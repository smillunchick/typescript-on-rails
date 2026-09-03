import { createHash } from "node:crypto";

import { isLexicalContextObservation } from "../architecture/index.js";
import type {
  ArchitectureDiagnostic,
  ArchitectureManifestV3,
  CompletenessObservation,
  ComposedSemanticRecord,
  DependencyManifest,
} from "../architecture/index.js";
import {
  isRuntimeRecordKind,
  parseRuntimeRecordId,
  runtimeRecordId,
  type ApplicationRuntimeLink,
  type RuntimeRecordKind,
} from "../runtime/index.js";

export const AGENT_PROJECTION_PROTOCOL_VERSION = 2 as const;

export interface CompositionRecordView {
  readonly kind: string;
  readonly owner: string;
  readonly name: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ArchitectureProjectionView<TRecord extends CompositionRecordView = CompositionRecordView> {
  readonly composition: readonly TRecord[];
  readonly linkage?: { readonly links: readonly ApplicationRuntimeLink[] };
  readonly base: {
    readonly dependencies: readonly DependencyManifest[];
    readonly features?: readonly { readonly name: string }[];
  };
  readonly completeness: ArchitectureManifestV3["completeness"];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalProjectionValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("CANONICAL_PROJECTION_VALUE_INVALID");
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError("CANONICAL_PROJECTION_DATE_INVALID");
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("CANONICAL_PROJECTION_CYCLE");
    ancestors.add(value);
    try { return `[${value.map((entry) => canonicalProjectionValue(entry, ancestors)).join(",")}]`; }
    finally { ancestors.delete(value); }
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("CANONICAL_PROJECTION_OBJECT_INVALID");
    if (ancestors.has(value)) throw new TypeError("CANONICAL_PROJECTION_CYCLE");
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) throw new TypeError("CANONICAL_PROJECTION_VALUE_INVALID");
    ancestors.add(value);
    try {
      return `{${Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalProjectionValue(entry, ancestors)}`)
        .join(",")}}`;
    } finally { ancestors.delete(value); }
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalProjectionJson(value: unknown): string {
  return canonicalProjectionValue(value, new WeakSet<object>());
}

export function canonicalProjectionHash(value: unknown): string {
  return createHash("sha256").update(canonicalProjectionJson(value)).digest("hex");
}

export function compositionRecordId(record: CompositionRecordView): string | undefined {
  return isRuntimeRecordKind(record.kind) ? runtimeRecordId(record.kind, record.owner, record.name) : undefined;
}

export function qualifiedCompositionSelector(record: CompositionRecordView): string {
  return `${record.kind}:${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}`;
}

export type ArchitectureSelectorMatch = "runtime-id" | "qualified-record" | "owner-group" | "record-name";

export interface ArchitectureSelectorCandidate {
  readonly kind: string;
  readonly owner: string;
  readonly name: string;
  readonly displayName: string;
  readonly runtimeId?: string;
  readonly qualifiedSelector: string;
}

export interface ResolvedArchitectureSelector<TRecord extends CompositionRecordView = CompositionRecordView> {
  readonly status: "resolved";
  readonly selector: string;
  readonly match: ArchitectureSelectorMatch;
  readonly owners: readonly string[];
  readonly suites: readonly string[];
  readonly records: readonly TRecord[];
  readonly seedIds: readonly string[];
  readonly alternates: readonly ArchitectureSelectorCandidate[];
}

export interface AmbiguousArchitectureSelector {
  readonly status: "ambiguous";
  readonly selector: string;
  readonly candidates: readonly ArchitectureSelectorCandidate[];
}

export interface MissingArchitectureSelector {
  readonly status: "not-found";
  readonly selector: string;
  readonly candidates: readonly ArchitectureSelectorCandidate[];
}

export type ArchitectureSelectorResult<TRecord extends CompositionRecordView = CompositionRecordView> =
  | ResolvedArchitectureSelector<TRecord>
  | AmbiguousArchitectureSelector
  | MissingArchitectureSelector;

function recordKey(record: CompositionRecordView): string {
  return `${record.kind}:${record.owner}:${record.name}`;
}

function sortedRecords<TRecord extends CompositionRecordView>(records: readonly TRecord[]): readonly TRecord[] {
  return Object.freeze([...records].sort((left, right) => compareText(recordKey(left), recordKey(right))));
}

function candidate(record: CompositionRecordView): ArchitectureSelectorCandidate {
  const runtimeId = compositionRecordId(record);
  return Object.freeze({
    kind: record.kind,
    owner: record.owner,
    name: record.name,
    displayName: `${record.owner}.${record.name}`,
    ...(runtimeId === undefined ? {} : { runtimeId }),
    qualifiedSelector: qualifiedCompositionSelector(record),
  });
}

function sortedCandidates(records: readonly CompositionRecordView[]): readonly ArchitectureSelectorCandidate[] {
  return Object.freeze(records.map(candidate).sort((left, right) => compareText(left.qualifiedSelector, right.qualifiedSelector)));
}

function ownerGroups(view: ArchitectureProjectionView): ReadonlySet<string> {
  const groups = new Set<string>(["application"]);
  for (const feature of view.base.features ?? []) groups.add(feature.name);
  for (const record of view.composition) groups.add(record.owner);
  return groups;
}

function selection<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selector: string,
  match: ArchitectureSelectorMatch,
  records: readonly TRecord[],
  ownerOverride?: string,
): ResolvedArchitectureSelector<TRecord> {
  const selected = sortedRecords(records);
  const owners = Object.freeze([...new Set(ownerOverride === undefined ? selected.map(({ owner }) => owner) : [ownerOverride])].sort(compareText));
  const suites = Object.freeze(owners.filter((owner) => owner.startsWith("application:")).map((owner) => owner.slice("application:".length)).sort(compareText));
  const selectedOwners = new Set(owners);
  const selectedRecords = new Set(selected);
  const alternates = sortedCandidates(view.composition.filter((record) =>
    !selectedRecords.has(record) && record.name === selector && !selectedOwners.has(record.owner)));
  const seedIds = Object.freeze(selected.map(compositionRecordId).filter((id): id is string => id !== undefined).sort(compareText));
  return Object.freeze({ status: "resolved", selector, match, owners, suites, records: selected, seedIds, alternates });
}

function qualifiedRecord<TRecord extends CompositionRecordView>(
  records: readonly TRecord[],
  selector: string,
): TRecord | undefined {
  const colon = selector.indexOf(":");
  const slash = selector.indexOf("/", colon + 1);
  if (colon < 1 || slash < colon + 2) return undefined;
  try {
    const kind = selector.slice(0, colon);
    const owner = decodeURIComponent(selector.slice(colon + 1, slash));
    const name = decodeURIComponent(selector.slice(slash + 1));
    const record = records.find((entry) => entry.kind === kind && entry.owner === owner && entry.name === name);
    return record !== undefined && qualifiedCompositionSelector(record) === selector ? record : undefined;
  } catch {
    return undefined;
  }
}

export function resolveArchitectureSelector<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selector: string,
): ArchitectureSelectorResult<TRecord> {
  if (selector.trim() === "") return Object.freeze({ status: "not-found", selector, candidates: Object.freeze([]) });
  if (selector.startsWith("rid1/")) {
    try {
      const identity = parseRuntimeRecordId(selector);
      const record = view.composition.find((entry) => entry.kind === identity.kind && entry.owner === identity.owner && entry.name === identity.name);
      return record === undefined
        ? Object.freeze({ status: "not-found", selector, candidates: Object.freeze([]) })
        : selection(view, selector, "runtime-id", [record]);
    } catch {
      return Object.freeze({ status: "not-found", selector, candidates: Object.freeze([]) });
    }
  }
  const qualified = qualifiedRecord(view.composition, selector);
  if (qualified !== undefined) return selection(view, selector, "qualified-record", [qualified]);

  const groups = ownerGroups(view);
  const suiteOwner = view.composition.find((record) => record.kind === "test" && record.detail?.suite === selector)?.owner;
  const owner = groups.has(selector) ? selector : suiteOwner;
  if (owner !== undefined) {
    return selection(view, selector, "owner-group", view.composition.filter((record) => record.owner === owner), owner);
  }

  const named = view.composition.filter((record) => record.name === selector);
  if (named.length === 1) return selection(view, selector, "record-name", named);
  if (named.length > 1) return Object.freeze({ status: "ambiguous", selector, candidates: sortedCandidates(named) });
  return Object.freeze({ status: "not-found", selector, candidates: Object.freeze([]) });
}

export interface LexicalArchitectureObservation {
  readonly basis: "context-member-call";
  readonly verified: false;
  readonly kind: "context-member" | "event-name";
  readonly from: string;
  readonly member: string;
  readonly name: string;
  readonly state: "direct" | "alias-unresolved" | "computed-unresolved";
  readonly scope: "run-body" | "nested-function";
  readonly runtimeReachability: "unknown";
  readonly to?: string;
  readonly file?: string;
  readonly line?: number;
  readonly reason: string;
}

export interface ArchitectureProjection<TRecord extends CompositionRecordView = CompositionRecordView> {
  readonly selection: ResolvedArchitectureSelector<TRecord>;
  readonly records: readonly TRecord[];
  readonly links: readonly ApplicationRuntimeLink[];
  readonly dependencies: readonly DependencyManifest[];
  readonly observedRecords: readonly TRecord[];
  readonly lexicalObservations: readonly LexicalArchitectureObservation[];
}

function lexicalProjection<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  records: readonly TRecord[],
): { readonly records: readonly TRecord[]; readonly observations: readonly LexicalArchitectureObservation[] } {
  const observed = new Set<TRecord>();
  const observations: LexicalArchitectureObservation[] = [];
  const eventsByName = new Map<string, TRecord[]>();
  for (const entry of view.composition) {
    if (entry.kind !== "event") continue;
    const events = eventsByName.get(entry.name) ?? [];
    events.push(entry);
    eventsByName.set(entry.name, events);
  }
  for (const record of records) {
    const from = compositionRecordId(record);
    if (from === undefined || !Array.isArray(record.detail?.contextObservations)) continue;
    for (const value of record.detail.contextObservations) {
      if (!isLexicalContextObservation(value)) continue;
      const event = value.event;
      const matches = event === undefined ? [] : eventsByName.get(event) ?? [];
      for (const match of matches) observed.add(match);
      const firstMatch = matches[0];
      const target = matches.length === 1 && firstMatch !== undefined ? compositionRecordId(firstMatch) : undefined;
      const file = value.file;
      const line = value.line;
      const state = value.state;
      const scope = value.scope;
      observations.push(Object.freeze({
        basis: "context-member-call" as const,
        verified: false as const,
        kind: event === undefined ? "context-member" as const : "event-name" as const,
        from,
        member: value.member,
        name: event ?? value.member,
        state,
        scope,
        runtimeReachability: "unknown" as const,
        ...(target === undefined ? {} : { to: target }),
        ...(file === undefined ? {} : { file }),
        ...(line === undefined ? {} : { line }),
        reason: event === undefined
          ? "bounded lexical observation of an application-context member; runtime reachability is unknown"
          : "bounded lexical observation of an event name; not a verified runtime link",
      }));
    }
  }
  return Object.freeze({
    records: sortedRecords([...observed]),
    observations: Object.freeze(observations.sort((left, right) => compareText(left.from, right.from) || compareText(left.file ?? "", right.file ?? "") || (left.line ?? 0) - (right.line ?? 0) || compareText(`${left.member}:${left.state}`, `${right.member}:${right.state}`))),
  });
}

export function projectArchitecture<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selected: ResolvedArchitectureSelector<TRecord>,
  options: { readonly depth?: "linked" | "trace" } = {},
): ArchitectureProjection<TRecord> {
  const depth = options.depth ?? "linked";
  const links = view.linkage?.links ?? [];
  const seedIds = new Set(selected.seedIds);
  const ids = new Set(seedIds);
  if (depth === "trace") {
    const incoming = new Map<string, ApplicationRuntimeLink[]>();
    const outgoing = new Map<string, ApplicationRuntimeLink[]>();
    for (const link of links) {
      const incomingLinks = incoming.get(link.to) ?? [];
      incomingLinks.push(link);
      incoming.set(link.to, incomingLinks);
      const outgoingLinks = outgoing.get(link.from) ?? [];
      outgoingLinks.push(link);
      outgoing.set(link.from, outgoingLinks);
    }
    const entrypointIds = new Set(view.composition.filter(({ kind }) => kind === "entrypoint").map(compositionRecordId).filter((id): id is string => id !== undefined));
    const queue = [...seedIds];
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      if (id === undefined) continue;
      for (const link of incoming.get(id) ?? []) {
        if (ids.has(link.from)) continue;
        ids.add(link.from);
        queue.push(link.from);
      }
      if (entrypointIds.has(id) && !seedIds.has(id)) continue;
      for (const link of outgoing.get(id) ?? []) {
        if (ids.has(link.to)) continue;
        ids.add(link.to);
        queue.push(link.to);
      }
    }
  } else {
    for (const link of links) {
      if (!seedIds.has(link.from) && !seedIds.has(link.to)) continue;
      ids.add(link.from);
      ids.add(link.to);
    }
  }
  const projectedLinks = Object.freeze(links.filter(({ from, to }) => ids.has(from) && ids.has(to) && (depth === "trace" || seedIds.has(from) || seedIds.has(to))));
  const selectedSet = new Set(selected.records);
  const records = sortedRecords(view.composition.filter((record) => {
    const id = compositionRecordId(record);
    return selectedSet.has(record) || (id !== undefined && ids.has(id));
  }));
  const owners = new Set(records.map(({ owner }) => owner).filter((owner) => owner !== "application" && !owner.startsWith("application:")));
  const dependencies = Object.freeze(view.base.dependencies.filter(({ from, to }) => owners.has(from) || owners.has(to)));
  const lexical = lexicalProjection(view, records);
  return Object.freeze({ selection: selected, records, links: projectedLinks, dependencies, observedRecords: lexical.records, lexicalObservations: lexical.observations });
}

export interface CompletenessSummary {
  readonly complete: boolean;
  readonly counts: ArchitectureManifestV3["completeness"]["counts"];
}

export interface ExecutableArchitectureSummary extends CompletenessSummary {
  readonly unknowns: readonly CompletenessObservation[];
}

export function completenessSummary(view: ArchitectureProjectionView): CompletenessSummary {
  return Object.freeze({ complete: view.completeness.complete, counts: view.completeness.counts });
}

export function unknownArchitectureObservations(view: ArchitectureProjectionView): readonly CompletenessObservation[] {
  return Object.freeze(view.completeness.observations.filter(({ category }) => category !== "declared"));
}

export function executableArchitectureSummary(view: ArchitectureProjectionView): ExecutableArchitectureSummary {
  return Object.freeze({
    ...completenessSummary(view),
    unknowns: Object.freeze(view.completeness.observations.filter(({ category }) => category === "discovered-undeclared" || category === "unknown")),
  });
}

interface ProjectionEnvelope {
  readonly projectionVersion: typeof AGENT_PROJECTION_PROTOCOL_VERSION;
  readonly kind: "brief" | "trace" | "tests" | "unknowns";
  readonly sha256: string;
}

function sealProjection<TBody extends object>(body: TBody): Readonly<TBody & { readonly sha256: string }> {
  return Object.freeze({ ...body, sha256: canonicalProjectionHash(body) });
}

export interface ArchitectureBrief<TRecord extends CompositionRecordView = CompositionRecordView> extends ProjectionEnvelope {
  readonly kind: "brief";
  readonly version: 2;
  readonly selector: string;
  readonly records: readonly TRecord[];
  readonly links: readonly ApplicationRuntimeLink[];
  readonly dependencies: readonly DependencyManifest[];
  readonly completeness: CompletenessSummary;
  readonly lexicalObservations: readonly LexicalArchitectureObservation[];
  readonly sourceBodiesIncluded: false;
  readonly contextBenefitClaim: false;
}

export function createArchitectureBrief<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selected: ResolvedArchitectureSelector<TRecord>,
): ArchitectureBrief<TRecord> {
  const projection = projectArchitecture(view, selected, { depth: "linked" });
  return sealProjection({
    projectionVersion: AGENT_PROJECTION_PROTOCOL_VERSION,
    kind: "brief" as const,
    version: 2 as const,
    selector: selected.selector,
    records: projection.records,
    links: projection.links,
    dependencies: projection.dependencies,
    completeness: completenessSummary(view),
    lexicalObservations: projection.lexicalObservations,
    sourceBodiesIncluded: false as const,
    contextBenefitClaim: false as const,
  });
}

export interface ArchitectureTrace<TRecord extends CompositionRecordView = CompositionRecordView> extends ProjectionEnvelope {
  readonly kind: "trace";
  readonly version: 1;
  readonly selector: string;
  readonly traceKind: "verified-static-linkage";
  readonly records: readonly TRecord[];
  readonly links: readonly ApplicationRuntimeLink[];
  readonly dependencies: readonly DependencyManifest[];
  readonly observedRecords: readonly TRecord[];
  readonly lexicalObservations: readonly LexicalArchitectureObservation[];
  readonly completeness: CompletenessSummary;
  readonly staticTraceAvailable: boolean;
  readonly runtimeTraceAvailable: false;
}

export function createArchitectureTrace<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selected: ResolvedArchitectureSelector<TRecord>,
): ArchitectureTrace<TRecord> {
  const projection = projectArchitecture(view, selected, { depth: "trace" });
  return sealProjection({
    projectionVersion: AGENT_PROJECTION_PROTOCOL_VERSION,
    kind: "trace" as const,
    version: 1 as const,
    selector: selected.selector,
    traceKind: "verified-static-linkage" as const,
    records: projection.records,
    links: projection.links,
    dependencies: projection.dependencies,
    observedRecords: projection.observedRecords,
    lexicalObservations: projection.lexicalObservations,
    completeness: completenessSummary(view),
    staticTraceAvailable: projection.links.length > 0,
    runtimeTraceAvailable: false as const,
  });
}

export interface ProjectionTestView {
  readonly file: string;
  readonly owner: string;
  readonly verification: "declared-only" | "source-exists" | "missing";
}

export type ProjectionTestVerification =
  | { readonly kind: "declared-only" }
  | { readonly kind: "completeness" }
  | { readonly kind: "callback"; readonly exists: (file: string) => boolean };

function testFeatures(record: CompositionRecordView): readonly string[] {
  return Array.isArray(record.detail?.features)
    ? record.detail.features.filter((feature): feature is string => typeof feature === "string")
    : [];
}

export function projectedTests<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selected: ResolvedArchitectureSelector<TRecord>,
  verification: ProjectionTestVerification = { kind: "declared-only" },
): readonly ProjectionTestView[] {
  const owners = new Set(selected.owners);
  const missing = new Set(view.completeness.observations.filter(({ kind }) => kind === "test-source").map(({ name }) => name));
  const tests = new Map<string, ProjectionTestView>();
  for (const record of view.composition) {
    if (record.kind !== "test") continue;
    if (!owners.has(record.owner) && !testFeatures(record).some((feature) => owners.has(feature))) continue;
    const status = verification.kind === "declared-only"
      ? "declared-only" as const
      : verification.kind === "callback"
        ? verification.exists(record.name) ? "source-exists" as const : "missing" as const
        : missing.has(record.name) ? "missing" as const : "source-exists" as const;
    const key = `${record.owner}\u0000${record.name}`;
    tests.set(key, Object.freeze({ file: record.name, owner: record.owner, verification: status }));
  }
  return Object.freeze([...tests.values()].sort((left, right) => compareText(`${left.file}:${left.owner}`, `${right.file}:${right.owner}`)));
}

export interface ArchitectureTestsReport extends ProjectionEnvelope {
  readonly kind: "tests";
  readonly version: 1;
  readonly selector: string;
  readonly tests: readonly ProjectionTestView[];
  readonly completeness: CompletenessSummary;
}

export function createArchitectureTests<TRecord extends CompositionRecordView>(
  view: ArchitectureProjectionView<TRecord>,
  selected: ResolvedArchitectureSelector<TRecord>,
  verification: ProjectionTestVerification = { kind: "declared-only" },
): ArchitectureTestsReport {
  return sealProjection({
    projectionVersion: AGENT_PROJECTION_PROTOCOL_VERSION,
    kind: "tests" as const,
    version: 1 as const,
    selector: selected.selector,
    tests: projectedTests(view, selected, verification),
    completeness: completenessSummary(view),
  });
}

export interface ArchitectureUnknownsReport extends ProjectionEnvelope {
  readonly kind: "unknowns";
  readonly version: 1;
  readonly complete: boolean;
  readonly counts: ArchitectureManifestV3["completeness"]["counts"];
  readonly unknowns: readonly CompletenessObservation[];
}

export function createArchitectureUnknowns(view: ArchitectureProjectionView): ArchitectureUnknownsReport {
  return sealProjection({
    projectionVersion: AGENT_PROJECTION_PROTOCOL_VERSION,
    kind: "unknowns" as const,
    version: 1 as const,
    ...completenessSummary(view),
    unknowns: unknownArchitectureObservations(view),
  });
}

export interface ArchitectureCheckOutcome {
  readonly ok: boolean;
  readonly exitCode: number;
}

export interface ArchitectureCheckReceipt {
  readonly receiptVersion: 1;
  readonly kind: "check";
  readonly ok: boolean;
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly executable?: ExecutableArchitectureSummary;
  readonly fullStack?: ArchitectureCheckOutcome;
  readonly tests?: ArchitectureCheckOutcome;
  readonly cancelled?: true;
  readonly sha256: string;
}

export function createArchitectureCheckReceipt(input: {
  readonly diagnostics: readonly ArchitectureDiagnostic[];
  readonly executable?: ExecutableArchitectureSummary;
  readonly lifecycle?: ArchitectureCheckOutcome;
  readonly tests?: ArchitectureCheckOutcome;
  readonly cancelled?: boolean;
}): ArchitectureCheckReceipt {
  const staticOk = !input.diagnostics.some(({ severity }) => severity === "error");
  const ok = staticOk
    && input.executable?.complete !== false
    && input.lifecycle?.ok !== false
    && input.tests?.ok !== false
    && input.cancelled !== true;
  return sealProjection({
    receiptVersion: 1 as const,
    kind: "check" as const,
    ok,
    diagnostics: input.diagnostics,
    ...(input.executable === undefined ? {} : { executable: input.executable }),
    ...(input.lifecycle === undefined ? {} : { fullStack: input.lifecycle }),
    ...(input.tests === undefined ? {} : { tests: input.tests }),
    ...(input.cancelled === true ? { cancelled: true as const } : {}),
  });
}

export type ExactArchitectureManifestV3 = ArchitectureProjectionView<ComposedSemanticRecord>;

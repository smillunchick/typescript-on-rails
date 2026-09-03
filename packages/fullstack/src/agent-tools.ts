import {
  canonicalProjectionHash,
  completenessSummary,
  projectedTests,
  projectArchitecture,
  resolveArchitectureSelector,
  unknownArchitectureObservations,
  type ArchitectureProjectionView,
  type CompositionRecordView,
} from "typescript-on-rails";

export type ComposedSemanticRecord = CompositionRecordView;
export type ArchitectureManifestV3Like = ArchitectureProjectionView;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface SemanticBrief {
  readonly version: 1;
  readonly selectors: readonly string[];
  readonly unresolvedSelectors: readonly string[];
  readonly records: readonly ComposedSemanticRecord[];
  readonly links: readonly { readonly kind: string; readonly from: string; readonly to: string; readonly protocol?: string }[];
  readonly dependencies: ArchitectureManifestV3Like["base"]["dependencies"];
  readonly completeness: ReturnType<typeof completenessSummary>;
  readonly sourceBodiesIncluded: false;
  readonly contextBenefitClaim: false;
  readonly sha256: string;
}

export function semanticBrief(manifest: ArchitectureManifestV3Like, selectors: readonly string[]): SemanticBrief {
  const selected = [...new Set(selectors)].sort(compareText);
  const unresolvedSelectors: string[] = [];
  const records = new Map<string, ComposedSemanticRecord>();
  const links = new Map<string, SemanticBrief["links"][number]>();
  const dependencies = new Map<string, SemanticBrief["dependencies"][number]>();
  for (const selector of selected) {
    const resolution = resolveArchitectureSelector(manifest, selector);
    if (resolution.status === "not-found") {
      unresolvedSelectors.push(selector);
      continue;
    }
    if (resolution.status === "ambiguous") throw new TypeError(`ARCHITECTURE_SELECTOR_AMBIGUOUS:${selector}`);
    const projection = projectArchitecture(manifest, resolution, { depth: "linked" });
    for (const record of projection.records) records.set(`${record.kind}:${record.owner}:${record.name}`, record);
    for (const link of projection.links) links.set(`${link.kind}:${link.from}:${link.to}:${link.protocol ?? ""}`, link);
    for (const dependency of projection.dependencies) dependencies.set(`${dependency.from}:${dependency.to}:${dependency.file}:${String(dependency.line)}`, dependency);
  }
  const body = {
    version: 1 as const,
    selectors: Object.freeze(selected),
    unresolvedSelectors: Object.freeze(unresolvedSelectors),
    records: Object.freeze([...records.values()].sort((left, right) => compareText(`${left.kind}:${left.owner}:${left.name}`, `${right.kind}:${right.owner}:${right.name}`))),
    links: Object.freeze([...links.values()].sort((left, right) => compareText(`${left.kind}:${left.from}:${left.to}`, `${right.kind}:${right.from}:${right.to}`))),
    dependencies: Object.freeze([...dependencies.values()].sort((left, right) => compareText(`${left.from}:${left.to}:${left.file}:${String(left.line)}`, `${right.from}:${right.to}:${right.file}:${String(right.line)}`))),
    completeness: completenessSummary(manifest),
    sourceBodiesIncluded: false as const,
    contextBenefitClaim: false as const,
  };
  return Object.freeze({ ...body, sha256: canonicalProjectionHash(body) });
}

export interface TraceRecord {
  readonly kind: "request" | "operation";
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: "success" | "failure";
  readonly correlationId?: string;
}

export class ExecutionTrace {
  readonly #records: TraceRecord[] = [];
  records(): readonly TraceRecord[] { return Object.freeze([...this.#records]); }
  async capture<T>(kind: TraceRecord["kind"], name: string, run: () => Promise<T> | T, options: { readonly correlationId?: string; readonly now?: () => number } = {}): Promise<T> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    try {
      const result = await run();
      this.#records.push(Object.freeze({ kind, name, startedAt, endedAt: now(), outcome: "success", ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) }));
      return result;
    } catch (error) {
      this.#records.push(Object.freeze({ kind, name, startedAt, endedAt: now(), outcome: "failure", ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) }));
      throw error;
    }
  }
}

export interface TestView {
  readonly file: string;
  readonly owner: string;
  readonly verification: "declared-only" | "source-exists" | "missing";
}

export function testsFor(
  manifest: ArchitectureManifestV3Like,
  selector: string,
  options: { readonly exists?: (file: string) => boolean } = {},
): readonly TestView[] {
  const selected = resolveArchitectureSelector(manifest, selector);
  if (selected.status === "not-found") return Object.freeze([]);
  if (selected.status === "ambiguous") throw new TypeError(`ARCHITECTURE_SELECTOR_AMBIGUOUS:${selector}`);
  return projectedTests(
    manifest,
    selected,
    options.exists === undefined ? { kind: "declared-only" } : { kind: "callback", exists: options.exists },
  );
}

export function unknowns(manifest: ArchitectureManifestV3Like): readonly ArchitectureManifestV3Like["completeness"]["observations"][number][] {
  return unknownArchitectureObservations(manifest);
}

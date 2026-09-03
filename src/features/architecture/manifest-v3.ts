import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { architecture, relationExceptionIssues, runtimeRecordId } from "../runtime/index.js";
import {
  PRECOMPUTED_PACKAGE_POLICY,
  selectPackagePolicy,
  type PackageCapabilityCatalog,
} from "../../infra/project/package-policy.js";
import type {
  App,
  ApplicationGraph,
  ApplicationRuntimeLink,
  AnyAdapterInstance,
  ExecutionContext,
  PackageCapability,
} from "../runtime/index.js";
import { analyzeApplication } from "./analyze.js";
import type { AnalyzeApplicationOptions, ArchitectureManifest } from "./manifest.js";

architecture.allow({
  rule: "package-capability",
  reason: "Manifest v3 performs framework-owned static source discovery with Node filesystem and the pinned TypeScript compiler API.",
});
architecture.allow({
  rule: "feature-infrastructure-boundary",
  reason: "Manifest v3 consumes the one repository package-capability catalog owned by project infrastructure.",
});

export const MANIFEST_V3_COMPOSITION_PROTOCOL_VERSION = 4 as const;
export const MANIFEST_V3_LINKAGE_PROTOCOL_VERSION = 4 as const;
const MANIFEST_V3_COMPILER = Object.freeze({
  manifestVersion: 3 as const,
  baseManifestVersion: 2 as const,
  typescriptVersion: ts.version,
  compositionProtocolVersion: MANIFEST_V3_COMPOSITION_PROTOCOL_VERSION,
  packageCapabilityVersion: 2 as const,
  packageCapabilitySemantics: "descriptive" as const,
});

export type PackageRuntimeLocation = "universal" | "browser" | "server" | "build";
export type PackageEffect = "none" | "filesystem" | "network" | "process" | "database" | "external-system";
export type PackageNondeterminism = "none" | "clock" | "random" | "environment" | "external" | "unknown";
export type PackageCapabilityProvenance = "official" | "override" | "declared-v2" | "migrated-v1";
export type PackageCapabilitySource = "official-package" | "application-v1" | "application-v2" | "options-v1" | "options-v2";
export type PackageVersionSource = "installed" | "lockfile" | "installed+lockfile" | "node-runtime" | "unresolved";

export interface PackageCapabilityV2 {
  readonly version: 2;
  readonly package: string;
  readonly packageVersion: string;
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
  readonly provenance: PackageCapabilityProvenance;
  readonly source?: PackageCapabilitySource;
  readonly versionSource?: PackageVersionSource;
  readonly officialOwner?: string;
  readonly inheritedFrom?: string;
}

export type PackageCapabilityV2Input = Omit<PackageCapabilityV2, "provenance"> & {
  readonly provenance?: PackageCapabilityProvenance;
};

export interface WorkspaceArchitectureManifest {
  readonly name: string;
  readonly root: string;
  readonly role: "application" | "support";
  readonly manifest: ArchitectureManifest;
  readonly packageCapabilities: readonly PackageCapabilityV2[];
}

export interface CompositionSource {
  readonly file: string;
  readonly line: number;
  readonly provenance: "static-registration" | "manifest-v2" | "declared-test";
}

export interface ComposedSemanticRecord {
  readonly kind:
    | "feature"
    | "model"
    | "operation"
    | "route"
    | "page"
    | "permission"
    | "repository"
    | "relation"
    | "schedule"
    | "event"
    | "consumer"
    | "adapter"
    | "entrypoint"
    | "test";
  readonly owner: string;
  readonly name: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface CompletenessObservation {
  readonly category: "declared" | "discovered-undeclared" | "outside-root" | "unknown";
  readonly kind: string;
  readonly name: string;
  readonly root: string;
  readonly file?: string;
  readonly reason: string;
}

export interface ArchitectureManifestV3 {
  readonly version: 3;
  readonly compiler: {
    readonly manifestVersion: 3;
    readonly baseManifestVersion: 2;
    readonly typescriptVersion: string;
    readonly compositionProtocolVersion: typeof MANIFEST_V3_COMPOSITION_PROTOCOL_VERSION;
    readonly packageCapabilityVersion: 2;
    readonly packageCapabilitySemantics: "descriptive";
  };
  readonly base: ArchitectureManifest;
  readonly workspaces: readonly WorkspaceArchitectureManifest[];
  readonly composition: readonly ComposedSemanticRecord[];
  readonly linkage: {
    readonly protocolVersion: typeof MANIFEST_V3_LINKAGE_PROTOCOL_VERSION;
    readonly links: readonly ApplicationRuntimeLink[];
  };
  readonly completeness: {
    readonly observations: readonly CompletenessObservation[];
    readonly counts: Readonly<Record<CompletenessObservation["category"], number>>;
    readonly complete: boolean;
  };
  readonly packageCapabilities: readonly PackageCapabilityV2[];
}

export interface AnalyzeApplicationV3Options extends AnalyzeApplicationOptions {
  readonly application?: App<Readonly<Record<string, AnyAdapterInstance>>, ExecutionContext>;
  readonly workspaces?: readonly {
    readonly name: string;
    readonly root: string;
    readonly tsconfig?: string;
    readonly packageCapabilities?: Readonly<Record<string, PackageCapability>>;
  }[];
  readonly packageCapabilitiesV2?: readonly PackageCapabilityV2Input[];
  readonly asOf?: Date;
}

function walk(directory: string, root: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, root, output);
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) output.push(path.relative(root, target).split(path.sep).join("/"));
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPackageRuntimeLocation(value: unknown): value is PackageRuntimeLocation {
  return value === "universal" || value === "browser" || value === "server" || value === "build";
}

function isPackageEffect(value: unknown): value is PackageEffect {
  return value === "none" || value === "filesystem" || value === "network" || value === "process" || value === "database" || value === "external-system";
}

function isPackageNondeterminism(value: unknown): value is PackageNondeterminism {
  return value === "none" || value === "clock" || value === "random" || value === "environment" || value === "external" || value === "unknown";
}

function packageVersionObservation(root: string, packageName: string, reason: string): CompletenessObservation {
  return { category: "unknown", kind: "package-version", name: packageName, root, file: "package.json", reason };
}

function configuredV3Options(root: string): Pick<AnalyzeApplicationV3Options, "workspaces"> {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(packageJson) || !isRecord(packageJson.typescriptOnRails)) return {};
  const configuration = packageJson.typescriptOnRails;
  const workspaces: NonNullable<AnalyzeApplicationV3Options["workspaces"]>[number][] = [];
  if (Array.isArray(configuration.architectureWorkspaces)) {
    for (const entry of configuration.architectureWorkspaces) {
      if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.root !== "string") {
        throw new TypeError("Invalid typescriptOnRails.architectureWorkspaces entry");
      }
      const workspaceRoot = path.resolve(root, entry.root);
      const relative = path.relative(path.resolve(root), workspaceRoot);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new TypeError(`Architecture workspace is outside the application root: ${entry.root}`);
      }
      workspaces.push({
        name: entry.name,
        root: workspaceRoot,
        ...(typeof entry.tsconfig === "string" ? { tsconfig: entry.tsconfig } : {}),
      });
    }
  }
  return workspaces.length === 0 ? {} : { workspaces: Object.freeze(workspaces) };
}

function discoveredFiles(root: string): string[] {
  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  const output: string[] = [];
  walk(root, root, output);
  return output.sort();
}

type SourceFileCache = Map<string, ts.SourceFile>;

function parsedSourceFile(file: string, cache: SourceFileCache): ts.SourceFile {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  const parsed = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  cache.set(file, parsed);
  return parsed;
}

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (propertyName === name) return property.initializer;
  }
  return undefined;
}

function literalText(value: ts.Expression | undefined): string | undefined {
  return value !== undefined && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function registrationSources(root: string, cache: SourceFileCache): ReadonlyMap<string, CompositionSource> {
  const found = new Map<string, CompositionSource | null>();
  const record = (key: string, source: CompositionSource): void => {
    found.set(key, found.has(key) ? null : source);
  };
  for (const relative of discoveredFiles(path.join(root, "src"))) {
    const file = path.join(root, "src", relative);
    const sourceFile = parsedSourceFile(file, cache);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0] !== undefined && ts.isObjectLiteralExpression(node.arguments[0])) {
        const callee = callName(node.expression);
        const object = node.arguments[0];
        let key: string | undefined;
        if (callee === "operationRoute" || callee === "route") {
          const method = literalText(propertyValue(object, "method"));
          const routePath = literalText(propertyValue(object, "path"));
          if (method !== undefined && routePath !== undefined) key = `route:${method} ${routePath}`;
        } else if (callee === "consumer") {
          const name = literalText(propertyValue(object, "name"));
          if (name !== undefined) key = `consumer:${name}`;
        } else if (callee === "schedule") {
          const name = literalText(propertyValue(object, "name"));
          if (name !== undefined) key = `schedule:${name}`;
        } else if (callee === "defineRepository") {
          const name = literalText(propertyValue(object, "name"));
          if (name !== undefined) key = `repository:${name}`;
        } else if (callee === "entrypoint" || callee === "processEntrypoint") {
          const name = literalText(propertyValue(object, "name"));
          if (name !== undefined) key = `entrypoint:${name}`;
        }
        if (key !== undefined) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          record(key, Object.freeze({ file: `src/${relative}`, line, provenance: "static-registration" as const }));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return new Map([...found].flatMap(([key, source]) => source === null ? [] : [[key, source]]));
}

export interface LexicalContextObservation {
  readonly member: string;
  readonly file: string;
  readonly line: number;
  readonly state: "direct" | "alias-unresolved" | "computed-unresolved";
  readonly scope: "run-body" | "nested-function";
  readonly runtimeReachability: "unknown";
  readonly event?: string;
}

export function isLexicalContextObservation(value: unknown): value is LexicalContextObservation {
  return isRecord(value)
    && typeof value.member === "string"
    && typeof value.file === "string"
    && typeof value.line === "number"
    && (value.state === "direct" || value.state === "alias-unresolved" || value.state === "computed-unresolved")
    && (value.scope === "run-body" || value.scope === "nested-function")
    && value.runtimeReachability === "unknown"
    && (value.event === undefined || typeof value.event === "string");
}

function expressionPath(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = expressionPath(expression.expression);
    return parent === undefined ? undefined : `${parent}.${expression.name.text}`;
  }
  return undefined;
}

interface OperationStaticAnalysis {
  readonly observations: readonly LexicalContextObservation[];
  readonly resolution: "resolved" | "context-unresolved" | "source-unresolved";
}

function operationStaticCalls(
  root: string,
  base: ArchitectureManifest,
  cache: SourceFileCache,
): ReadonlyMap<string, OperationStaticAnalysis> {
  const output = new Map<string, OperationStaticAnalysis>();
  for (const operation of base.operations) {
    if (operation.feature === null) continue;
    const key = `${operation.feature}:${operation.name}`;
    try {
      const file = path.join(root, operation.file);
      const sourceFile = parsedSourceFile(file, cache);
      const observations: LexicalContextObservation[] = [];
      let resolution: OperationStaticAnalysis["resolution"] = "context-unresolved";
      const inspectRun = (run: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): OperationStaticAnalysis["resolution"] => {
        const context = run.parameters[1]?.name;
        if (context === undefined) return "resolved";
        if (!ts.isIdentifier(context) || run.body === undefined) return "context-unresolved";
        const observe = (
          node: ts.Node,
          member: string,
          state: LexicalContextObservation["state"],
          nested: boolean,
          event?: string,
        ): void => {
          observations.push(Object.freeze({
            member,
            file: operation.file,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            state,
            scope: nested ? "nested-function" : "run-body",
            runtimeReachability: "unknown",
            ...(event === undefined ? {} : { event }),
          }));
        };
        const computedContextMember = (expression: ts.Expression): string | undefined => {
          if (ts.isElementAccessExpression(expression)) {
            const parent = expressionPath(expression.expression) ?? computedContextMember(expression.expression);
            return parent === context.text || parent?.startsWith(`${context.text}.`) === true ? `${parent}[computed]` : undefined;
          }
          if (ts.isPropertyAccessExpression(expression)) {
            const parent = computedContextMember(expression.expression);
            return parent === undefined ? undefined : `${parent}.${expression.name.text}`;
          }
          return undefined;
        };
        const visit = (node: ts.Node, nested: boolean): void => {
          if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
            const source = expressionPath(node.initializer);
            if (source?.startsWith(`${context.text}.`) === true) observe(node, source, "alias-unresolved", nested);
          }
          if (ts.isCallExpression(node)) {
            const member = expressionPath(node.expression);
            if (member?.startsWith(`${context.text}.`) === true) {
              const eventArgument = node.arguments[0];
              observe(
                node,
                member,
                "direct",
                nested,
                member.endsWith(".appendOutbox") && eventArgument !== undefined && ts.isIdentifier(eventArgument)
                  ? eventArgument.text
                  : undefined,
              );
            } else {
              const computed = computedContextMember(node.expression);
              if (computed !== undefined) observe(node, computed, "computed-unresolved", nested);
            }
          }
          const childNested = nested || (ts.isFunctionLike(node) && node !== run);
          ts.forEachChild(node, (child) => visit(child, childNested));
        };
        visit(run.body, false);
        return "resolved";
      };
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== operation.name || declaration.initializer === undefined || !ts.isCallExpression(declaration.initializer)) continue;
          const config = declaration.initializer.arguments[0];
          if (config === undefined || !ts.isObjectLiteralExpression(config)) continue;
          for (const property of config.properties) {
            if (!ts.isMethodDeclaration(property) && !ts.isPropertyAssignment(property)) continue;
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
            if (name !== "run") continue;
            if (ts.isMethodDeclaration(property)) resolution = inspectRun(property);
            else if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) resolution = inspectRun(property.initializer);
          }
        }
      }
      observations.sort((left, right) => compareText(left.file, right.file) || left.line - right.line || compareText(`${left.member}:${left.state}`, `${right.member}:${right.state}`));
      output.set(key, Object.freeze({ observations: Object.freeze(observations), resolution }));
    } catch {
      output.set(key, Object.freeze({ observations: Object.freeze([]), resolution: "source-unresolved" }));
    }
  }
  return output;
}

function exportedRouteMethods(file: string, cache: SourceFileCache): readonly string[] {
  const sourceFile = parsedSourceFile(file, cache);
  const methods = new Set<string>();
  for (const statement of sourceFile.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(statement.name.text)) methods.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && /^(?:GET|POST|PUT|PATCH|DELETE)$/.test(declaration.name.text)) {
          methods.add(declaration.name.text);
        }
      }
    }
  }
  return Object.freeze([...methods].sort());
}

function appPath(sourcePath: string, kind: "route" | "page"): string | undefined {
  const match = new RegExp(`^app/(.*?)(?:/)?${kind}\\.(?:ts|tsx)$`).exec(sourcePath);
  if (match === null) return undefined;
  const segments = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment !== "" && !/^\(.+\)$/.test(segment))
    .map((segment) => segment.replace(/^\[\.\.\.([^\]]+)\]$/, ":$1*").replace(/^\[([^\]]+)\]$/, ":$1"));
  return `/${segments.join("/")}`;
}

function immutableManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableManifestValue));
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = immutableManifestValue(entry);
    return Object.freeze(output);
  }
  return value;
}

function immutableDetail(detail: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) output[key] = immutableManifestValue(value);
  return Object.freeze(output);
}

function sourceDetail(
  detail: Readonly<Record<string, unknown>>,
  source: CompositionSource | undefined,
): Readonly<Record<string, unknown>> {
  return immutableDetail({ ...detail, ...(source === undefined ? {} : { source }) });
}

function compose(
  graph: ApplicationGraph | undefined,
  base: ArchitectureManifest,
  sources: ReadonlyMap<string, CompositionSource>,
  calls: ReadonlyMap<string, OperationStaticAnalysis>,
): ComposedSemanticRecord[] {
  if (graph === undefined) return [];
  const records: ComposedSemanticRecord[] = [];
  const modelSources = new Map(base.models.map((model) => [
    `${model.feature ?? "application"}:${model.name}`,
    Object.freeze({ file: model.file, line: model.line, provenance: "manifest-v2" as const }),
  ]));
  const operationSources = new Map(base.operations.map((operation) => [
    `${operation.feature ?? "application"}:${operation.name}`,
    Object.freeze({ file: operation.file, line: operation.line, provenance: "manifest-v2" as const }),
  ]));
  for (const feature of graph.features) {
    const repositoryAccess = feature.repositoryAccess.map(({ feature: owner, name }) => Object.freeze({ owner, repository: name, evidence: "public-path" as const }));
    const relationExceptions = graph.relationExceptions
      .filter(({ feature: accessingFeature }) => accessingFeature === feature.name)
      .map(({ relation, owner, reason, expires }) => Object.freeze({ relation, owner, reason, ...(expires === undefined ? {} : { expires }), evidence: "exception" as const }));
    const featureDetail = repositoryAccess.length === 0 && relationExceptions.length === 0
      ? undefined
      : Object.freeze({ repositoryAccess: Object.freeze(repositoryAccess), relationExceptions: Object.freeze(relationExceptions) });
    records.push({ kind: "feature", owner: feature.name, name: feature.name, ...(featureDetail === undefined ? {} : { detail: featureDetail }) });
    for (const item of feature.pages) records.push({ kind: "page", owner: feature.name, name: item.metadata.name, detail: { path: item.metadata.path, runtime: item.metadata.runtime } });
    for (const permission of feature.permissions) records.push({ kind: "permission", owner: feature.name, name: permission });
    for (const adapter of feature.adapters) records.push({
      kind: "adapter",
      owner: feature.name,
      name: adapter.name,
      detail: { role: "required", operations: Object.freeze(Object.keys(adapter.operations).sort()) },
    });
  }
  for (const item of graph.schedules) records.push({
    kind: "schedule",
    owner: item.owner,
    name: item.name,
    detail: sourceDetail({
      target: item.definition.target.metadata.name,
      event: item.definition.target.event.name,
      version: item.definition.target.event.version,
    }, sources.get(`schedule:${item.name}`)),
  });
  for (const item of graph.repositories) records.push({
    kind: "repository",
    owner: item.owner,
    name: item.name,
    detail: sourceDetail({
      relations: item.definition.relations,
      evidence: "declared-registration",
      sqlVerified: false,
    }, sources.get(`repository:${item.name}`)),
  });
  for (const relation of graph.relations) records.push({
    kind: "relation",
    owner: relation.owner,
    name: relation.relation,
    detail: {
      repository: relation.repository,
      exclusive: relation.exclusive,
      exceptions: Object.freeze(graph.relationExceptions
        .filter(({ relation: exceptionRelation }) => exceptionRelation === relation.relation)
        .map(({ feature, reason, expires }) => Object.freeze({ feature, reason, ...(expires === undefined ? {} : { expires }) }))),
      sqlVerified: false,
    },
  });
  for (const item of graph.adapters) records.push({
    kind: "adapter",
    owner: item.owner,
    name: item.name,
    detail: {
      role: "registered",
      provider: item.definition.provider,
      suitability: item.definition.suitability,
      operations: Object.freeze(Object.keys(item.definition.operations).sort()),
    },
  });
  for (const item of graph.models) records.push({
    kind: "model",
    owner: item.owner,
    name: item.name,
    detail: sourceDetail({ fields: item.definition.metadata.fields }, modelSources.get(`${item.owner}:${item.name}`)),
  });
  for (const item of graph.operations) {
    const key = `${item.owner}:${item.name}`;
    const analysis = calls.get(key);
    records.push({
      kind: "operation",
      owner: item.owner,
      name: item.name,
      detail: sourceDetail(
        {
          operationKind: item.definition.metadata.kind,
          contextObservations: analysis?.observations ?? [],
          contextObservationResolution: analysis?.resolution ?? "source-unresolved",
        },
        operationSources.get(key),
      ),
    });
  }
  for (const item of graph.routes) records.push({
    kind: "route",
    owner: item.owner,
    name: item.name,
    detail: sourceDetail({}, sources.get(`route:${item.name}`)),
  });
  for (const item of graph.events) records.push({ kind: "event", owner: item.owner, name: item.name, detail: { version: item.definition.version } });
  for (const item of graph.consumers) records.push({
    kind: "consumer",
    owner: item.owner,
    name: item.name,
    detail: sourceDetail(
      { event: item.definition.metadata.event, durable: item.definition.metadata.durable },
      sources.get(`consumer:${item.name}`),
    ),
  });
  for (const [process, entry] of Object.entries(graph.entrypoints)) {
    if (entry !== undefined) records.push({
      kind: "entrypoint",
      owner: "application",
      name: entry.metadata.name,
      detail: sourceDetail({ process }, sources.get(`entrypoint:${entry.metadata.name}`)),
    });
  }
  for (const test of graph.tests) for (const file of test.files) records.push({
    kind: "test",
    owner: test.kind === "feature" ? test.name : `application:${test.name}`,
    name: file,
    detail: {
      features: test.features,
      ...(test.kind === "application" ? { suite: test.name } : {}),
      source: Object.freeze({ file, line: 1, provenance: "declared-test" as const }),
    },
  });
  const unique = new Map<string, ComposedSemanticRecord>();
  for (const record of records) {
    const key = `${record.kind}:${record.owner}:${record.name}`;
    const frozen = Object.freeze({
      ...record,
      ...(record.detail === undefined ? {} : { detail: immutableDetail(record.detail) }),
    });
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior.detail) !== JSON.stringify(frozen.detail)) {
      throw new Error(`CONFLICTING_COMPOSITION_RECORD:${key}`);
    }
    unique.set(key, frozen);
  }
  return [...unique.values()].sort((left, right) => compareText(`${left.kind}:${left.owner}:${left.name}`, `${right.kind}:${right.owner}:${right.name}`));
}

function placeholderCallback(callback: (signal: AbortSignal) => unknown): boolean {
  const source = Function.prototype.toString.call(callback).replace(/\s+/g, "");
  return /^(?:async)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)=>(?:undefined|void0|\{\})$/.test(source)
    || /^(?:async)?function[^\{]*\{\}$/.test(source);
}

function completeness(
  applicationRoot: string,
  base: ArchitectureManifest,
  graph: ApplicationGraph | undefined,
  sourceFiles: SourceFileCache,
  composition: readonly ComposedSemanticRecord[],
  workspaces: readonly WorkspaceArchitectureManifest[],
  additionalObservations: readonly CompletenessObservation[] = [],
  asOf?: Date,
): ArchitectureManifestV3["completeness"] {
  const observations: CompletenessObservation[] = [...additionalObservations, ...composition.map((record): CompletenessObservation => ({
    category: "declared",
    kind: record.kind,
    name: record.name,
    root: applicationRoot,
    reason: "registered in the executable application graph",
  }))];
  if (graph !== undefined) {
    const routeOperations = new Set(graph.links.filter(({ kind }) => kind === "route-operation").map(({ from }) => from));
    const boundRoutes = new Set(graph.links.filter(({ kind }) => kind === "entrypoint-route").map(({ to }) => to));
    const boundConsumers = new Set(graph.links.filter(({ kind }) => kind === "entrypoint-consumer").map(({ to }) => to));
    const boundSchedules = new Set(graph.links.filter(({ kind }) => kind === "entrypoint-schedule").map(({ to }) => to));
    for (const record of composition) {
      if ((record.kind === "model" || record.kind === "route" || record.kind === "consumer" || record.kind === "entrypoint" || record.kind === "repository" || record.kind === "schedule") &&
          (typeof record.detail?.source !== "object" || record.detail.source === null)) {
        observations.push({ category: "unknown", kind: `${record.kind}-source`, name: `${record.owner}.${record.name}`, root: applicationRoot, reason: "registered runtime object has no unique static source provenance" });
      }
      if (record.kind === "operation" && record.detail?.contextObservationResolution !== "resolved") {
        observations.push({ category: "unknown", kind: "operation-context-observations", name: `${record.owner}.${record.name}`, root: applicationRoot, reason: "lexical context-member observation could not be resolved" });
      }
      if (record.kind === "route") {
        const id = runtimeRecordId("route", record.owner, record.name);
        if (!routeOperations.has(id)) {
          observations.push({ category: "unknown", kind: "route-link", name: record.name, root: applicationRoot, reason: "route does not derive execution from a registered operation" });
        }
        if (!boundRoutes.has(id)) {
          observations.push({ category: "unknown", kind: "route-binding", name: record.name, root: applicationRoot, reason: "route is not bound to the registered web entrypoint" });
        }
      }
      if (record.kind === "consumer" && record.detail?.durable === true) {
        const id = runtimeRecordId("consumer", record.owner, record.name);
        if (!boundConsumers.has(id)) {
          observations.push({ category: "unknown", kind: "consumer-binding", name: record.name, root: applicationRoot, reason: "durable consumer is not bound to the registered worker entrypoint" });
        }
      }
      if (record.kind === "schedule") {
        const id = runtimeRecordId("schedule", record.owner, record.name);
        if (!boundSchedules.has(id)) observations.push({ category: "unknown", kind: "schedule-binding", name: record.name, root: applicationRoot, reason: "schedule is not bound to the registered scheduler entrypoint" });
      }
      if (record.kind === "test") {
        try {
          if (!statSync(path.join(applicationRoot, record.name)).isFile()) throw new Error("not a file");
        } catch {
          observations.push({ category: "unknown", kind: "test-source", name: record.name, root: applicationRoot, file: record.name, reason: "registered test file does not exist" });
        }
      }
    }
    for (const exception of graph.relationExceptions) {
      if (exception.expires === undefined) {
        observations.push({ category: "unknown", kind: "relation-exception", name: `${exception.feature}.${exception.relation}`, root: applicationRoot, reason: "bounded relation exception has no expiry" });
      }
    }
    if (asOf !== undefined) {
      for (const issue of relationExceptionIssues(graph, { asOf })) {
        observations.push({ category: "unknown", kind: "relation-exception", name: `${issue.feature}.${issue.relation}`, root: applicationRoot, reason: `relation exception expired on ${issue.expires}` });
      }
    }
    for (const entry of Object.values(graph.entrypoints)) {
      if (entry !== undefined && placeholderCallback(entry.run)) {
        observations.push({ category: "unknown", kind: "entrypoint-execution", name: entry.metadata.name, root: applicationRoot, reason: "registered entrypoint has a placeholder run function" });
      }
    }
  }
  const declaredRoutes = new Set(composition.filter(({ kind }) => kind === "route").map(({ name }) => name));
  const declaredPagePaths = new Set(
    composition
      .filter(({ kind, detail }) => kind === "page" && typeof detail?.path === "string")
      .map(({ detail }) => String(detail?.path)),
  );
  for (const file of discoveredFiles(path.join(applicationRoot, "src"))) {
    if (/(^|\/)route\.(?:ts|tsx)$/.test(file)) {
      const discoveredPath = appPath(file, "route") ?? file;
      const methods = exportedRouteMethods(path.join(applicationRoot, "src", file), sourceFiles);
      if (methods.length === 0) {
        observations.push({ category: "unknown", kind: "route", name: discoveredPath, root: applicationRoot, file: `src/${file}`, reason: "route-like source has no statically visible HTTP method export" });
      }
      for (const method of methods) {
        const name = `${method} ${discoveredPath}`;
        if (!declaredRoutes.has(name)) observations.push({ category: "discovered-undeclared", kind: "route", name, root: applicationRoot, file: `src/${file}`, reason: "HTTP method export is not registered in the executable graph" });
      }
    } else if (/(^|\/)page\.(?:ts|tsx)$/.test(file)) {
      const discoveredPath = appPath(file, "page") ?? file;
      if (!declaredPagePaths.has(discoveredPath)) observations.push({ category: "discovered-undeclared", kind: "page", name: discoveredPath, root: applicationRoot, file: `src/${file}`, reason: "page source is not registered in the executable graph" });
    }
  }
  const declaredModels = new Set(composition.filter(({ kind }) => kind === "model").map(({ owner, name }) => `${owner}:${name}`));
  for (const model of base.models) {
    if (model.feature !== null && !declaredModels.has(`${model.feature}:${model.name}`)) {
      observations.push({ category: "discovered-undeclared", kind: "model", name: `${model.feature}.${model.name}`, root: applicationRoot, file: model.file, reason: "model declaration is not registered in the executable feature graph" });
    }
  }
  const declaredOperations = new Set(composition.filter(({ kind }) => kind === "operation").map(({ owner, name }) => `${owner}:${name}`));
  for (const feature of base.features) for (const item of feature.exports) {
    if (item.kind === "function" && !declaredOperations.has(`${feature.name}:${item.name}`)) {
      observations.push({ category: "unknown", kind: "public-function", name: `${feature.name}.${item.name}`, root: applicationRoot, file: item.file, reason: "public function has no declared operation, query, consumer, or lifecycle role" });
    }
  }
  for (const workspace of workspaces.filter(({ role }) => role === "support")) {
    for (const feature of workspace.manifest.features) observations.push({ category: "outside-root", kind: "feature", name: feature.name, root: workspace.root, file: feature.file, reason: "declared in a configured support workspace" });
  }
  for (const diagnostic of base.diagnostics.filter(({ severity }) => severity === "warning")) observations.push({ category: "unknown", kind: "diagnostic", name: diagnostic.code, root: applicationRoot, file: diagnostic.file, reason: diagnostic.message });
  observations.sort((left, right) => compareText(`${left.category}:${left.kind}:${left.name}`, `${right.category}:${right.kind}:${right.name}`));
  const counts = { declared: 0, "discovered-undeclared": 0, "outside-root": 0, unknown: 0 };
  for (const observation of observations) counts[observation.category] += 1;
  return Object.freeze({ observations: Object.freeze(observations), counts: Object.freeze(counts), complete: counts["discovered-undeclared"] === 0 && counts.unknown === 0 });
}

export function migratePackageCapabilityV1(packageName: string, capability: PackageCapability, packageVersion: string): PackageCapabilityV2 {
  if (packageVersion.trim() === "" || packageVersion === "unknown") throw new TypeError("Package capability v2 migration requires an exact package version");
  const shared = { version: 2 as const, package: packageName, packageVersion, provenance: "migrated-v1" as const };
  switch (capability) {
    case "ui": return { ...shared, runtime: ["browser"], effects: ["none"], nondeterminism: ["unknown"] };
    case "external-system": return { ...shared, runtime: ["server"], effects: ["external-system", "network"], nondeterminism: ["external"] };
    case "host-io": return { ...shared, runtime: ["server", "build"], effects: ["filesystem", "network", "process"], nondeterminism: ["environment", "unknown"] };
    case "pure": return { ...shared, runtime: ["universal"], effects: ["none"], nondeterminism: packageName === "node:os" || packageName === "node:perf_hooks" ? ["environment", "clock"] : ["none"] };
    default: throw new TypeError(`Unknown package capability: ${String(capability)}`);
  }
}

function validatePackageCapabilityV2(workspace: string, decision: PackageCapabilityV2Input): void {
  if (
    decision.version !== 2 ||
    decision.package.trim() === "" ||
    decision.packageVersion.trim() === "" ||
    decision.packageVersion === "unknown" ||
    !Array.isArray(decision.runtime) || !decision.runtime.every(isPackageRuntimeLocation) ||
    !Array.isArray(decision.effects) || !decision.effects.every(isPackageEffect) ||
    !Array.isArray(decision.nondeterminism) || !decision.nondeterminism.every(isPackageNondeterminism) ||
    (decision.provenance !== undefined && decision.provenance !== "declared-v2" && decision.provenance !== "migrated-v1" && decision.provenance !== "official" && decision.provenance !== "override")
  ) throw new TypeError(`Invalid package capability v2 decision in ${workspace}: ${decision.package}`);
}

function normalizePackageCapabilityV2(decision: PackageCapabilityV2Input): PackageCapabilityV2 {
  return Object.freeze({
    ...decision,
    runtime: Object.freeze([...new Set(decision.runtime)].sort(compareText)),
    effects: Object.freeze([...new Set(decision.effects)].sort(compareText)),
    nondeterminism: Object.freeze([...new Set(decision.nondeterminism)].sort(compareText)),
    provenance: decision.provenance ?? "declared-v2",
  });
}

function samePackageCapabilityFacts(left: PackageCapabilityV2, right: PackageCapabilityV2): boolean {
  return left.package === right.package
    && left.packageVersion === right.packageVersion
    && JSON.stringify(left.runtime) === JSON.stringify(right.runtime)
    && JSON.stringify(left.effects) === JSON.stringify(right.effects)
    && JSON.stringify(left.nondeterminism) === JSON.stringify(right.nondeterminism);
}

export function resolvePackageCapabilitiesV2(
  workspace: string,
  decisions: readonly PackageCapabilityV2Input[],
  inherited: readonly PackageCapabilityV2Input[] = [],
): readonly PackageCapabilityV2[] {
  const resolved = new Map<string, PackageCapabilityV2>();
  for (const decision of inherited) {
    validatePackageCapabilityV2(workspace, decision);
    const normalized = normalizePackageCapabilityV2(decision);
    const key = `${normalized.package}@${normalized.packageVersion}`;
    const inheritedDecision = Object.freeze({ ...normalized, inheritedFrom: normalized.inheritedFrom ?? "parent" });
    const prior = resolved.get(key);
    if (prior !== undefined && !samePackageCapabilityFacts(prior, inheritedDecision)) throw new TypeError(`Conflicting package capability v2 decision in ${workspace}: ${key}`);
    resolved.set(key, inheritedDecision);
  }
  for (const decision of decisions) {
    validatePackageCapabilityV2(workspace, decision);
    const normalized = normalizePackageCapabilityV2(decision);
    const key = `${normalized.package}@${normalized.packageVersion}`;
    const prior = resolved.get(key);
    if (prior !== undefined && !samePackageCapabilityFacts(prior, normalized)) throw new TypeError(`Conflicting package capability v2 decision in ${workspace}: ${key}`);
    resolved.set(key, normalized);
  }
  return Object.freeze([...resolved.values()].sort((left, right) => compareText(`${left.package}@${left.packageVersion}`, `${right.package}@${right.packageVersion}`)));
}

function packageCapabilitiesFromCatalog(catalog: PackageCapabilityCatalog): readonly PackageCapabilityV2[] {
  return Object.freeze(catalog.entries.flatMap((entry) => entry.packageVersion === "unresolved" ? [] : [Object.freeze({
    version: 2 as const,
    package: entry.package,
    packageVersion: entry.packageVersion,
    runtime: entry.runtime,
    effects: entry.effects,
    nondeterminism: entry.nondeterminism,
    provenance: entry.provenance,
    source: entry.source,
    versionSource: entry.versionSource,
    ...(entry.officialOwner === undefined ? {} : { officialOwner: entry.officialOwner }),
  })]));
}

function packageCatalogObservations(
  root: string,
  catalog: PackageCapabilityCatalog,
  packagePolicy: ArchitectureManifest["packagePolicy"],
): CompletenessObservation[] {
  const observations: CompletenessObservation[] = [];
  const usedPackages = new Set(packagePolicy.map(({ package: packageName }) => packageName));
  for (const entry of catalog.entries) {
    if (entry.packageVersion === "unresolved" && usedPackages.has(entry.package)) {
      observations.push(packageVersionObservation(root, entry.package, "installed package version could not be resolved; configure an exact package capability v2 decision after installing the package"));
    }
  }
  for (const issue of catalog.issues) {
    if (issue.kind !== "version-mismatch" && issue.kind !== "fact-conflict" && issue.kind !== "invalid-official-metadata") continue;
    observations.push({
      category: "unknown",
      kind: "package-capability",
      name: issue.key ?? issue.kind,
      root,
      file: "package.json",
      reason: issue.message,
    });
  }
  return observations;
}

export function analyzeApplicationV3(applicationRoot: string, options: AnalyzeApplicationV3Options = {}): ArchitectureManifestV3 {
  const {
    application,
    workspaces: suppliedWorkspaces,
    packageCapabilitiesV2: suppliedCapabilities,
    asOf,
    ...baseOptions
  } = options;
  const fileOptions = configuredV3Options(applicationRoot);
  const configured = suppliedWorkspaces ?? fileOptions.workspaces ?? [];
  const catalogOptions = suppliedCapabilities === undefined
    ? baseOptions
    : { ...baseOptions, packageCapabilitiesV2: suppliedCapabilities };
  const selectedPolicy = selectPackagePolicy(applicationRoot, catalogOptions);
  const baseAnalysisOptions = { ...baseOptions, [PRECOMPUTED_PACKAGE_POLICY]: selectedPolicy };
  const base = analyzeApplication(applicationRoot, baseAnalysisOptions);
  const capabilities = packageCapabilitiesFromCatalog(selectedPolicy.catalog);
  const versionObservations: CompletenessObservation[] = packageCatalogObservations(applicationRoot, selectedPolicy.catalog, base.packagePolicy);
  const workspaces: WorkspaceArchitectureManifest[] = [{
    name: "application",
    root: applicationRoot,
    role: "application",
    manifest: base,
    packageCapabilities: capabilities,
  }];
  for (const workspace of configured) {
    const workspaceOptions = {
      ...(workspace.tsconfig === undefined ? {} : { tsconfig: workspace.tsconfig }),
      ...(workspace.packageCapabilities === undefined ? {} : { packageCapabilities: workspace.packageCapabilities }),
    };
    const workspacePolicy = selectPackagePolicy(workspace.root, workspaceOptions);
    const workspaceAnalysisOptions = { ...workspaceOptions, [PRECOMPUTED_PACKAGE_POLICY]: workspacePolicy };
    const manifest = analyzeApplication(workspace.root, workspaceAnalysisOptions);
    const workspaceCapabilities = resolvePackageCapabilitiesV2(
      workspace.name,
      packageCapabilitiesFromCatalog(workspacePolicy.catalog),
      capabilities,
    );
    versionObservations.push(...packageCatalogObservations(workspace.root, workspacePolicy.catalog, manifest.packagePolicy));
    workspaces.push({
      name: workspace.name,
      root: workspace.root,
      role: "support",
      manifest,
      packageCapabilities: workspaceCapabilities,
    });
  }
  const graph = application?.graph;
  const sourceFiles: SourceFileCache = new Map();
  const composition = graph === undefined
    ? []
    : compose(graph, base, registrationSources(applicationRoot, sourceFiles), operationStaticCalls(applicationRoot, base, sourceFiles));
  const linkage = Object.freeze({ protocolVersion: MANIFEST_V3_LINKAGE_PROTOCOL_VERSION, links: Object.freeze([...(graph?.links ?? [])]) });
  return Object.freeze({
    version: 3,
    compiler: MANIFEST_V3_COMPILER,
    base,
    workspaces: Object.freeze(workspaces),
    composition: Object.freeze(composition),
    linkage,
    completeness: completeness(applicationRoot, base, graph, sourceFiles, composition, workspaces, versionObservations, asOf),
    packageCapabilities: Object.freeze([...capabilities].sort((left, right) => compareText(left.package, right.package))),
  });
}

export function migrateManifestV2(manifest: ArchitectureManifest): ArchitectureManifestV3 {
  return Object.freeze({
    version: 3,
    compiler: MANIFEST_V3_COMPILER,
    base: manifest,
    workspaces: Object.freeze([{
      name: "application",
      root: ".",
      role: "application" as const,
      manifest,
      packageCapabilities: Object.freeze([]),
    }]),
    composition: Object.freeze([]),
    linkage: Object.freeze({ protocolVersion: MANIFEST_V3_LINKAGE_PROTOCOL_VERSION, links: Object.freeze([]) }),
    completeness: Object.freeze({
      observations: Object.freeze([
        {
          category: "unknown" as const,
          kind: "composition",
          name: "application",
          root: ".",
          reason: "Manifest v2 contains no executable composition graph; load the application before claiming completeness",
        },
        ...manifest.packagePolicy.map((entry) => packageVersionObservation(
          ".",
          entry.package,
          "Manifest v2 does not record an installed package version; analyze the application or supply an exact package capability v2 decision",
        )),
      ]),
      counts: Object.freeze({ declared: 0, "discovered-undeclared": 0, "outside-root": 0, unknown: 1 + manifest.packagePolicy.length }),
      complete: false,
    }),
    packageCapabilities: Object.freeze([]),
  });
}

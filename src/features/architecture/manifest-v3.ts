import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

import { architecture, runtimeRecordId } from "../runtime/index.js";
import type {
  App,
  ApplicationGraph,
  ApplicationRuntimeLink,
  ExecutionContext,
  PackageCapability,
} from "../runtime/index.js";
import { analyzeApplication } from "./analyze.js";
import type { AnalyzeApplicationOptions, ArchitectureManifest } from "./manifest.js";

architecture.allow({
  rule: "package-capability",
  reason: "Manifest v3 performs framework-owned static source discovery with Node filesystem and the pinned TypeScript compiler API.",
});

export type PackageRuntimeLocation = "universal" | "browser" | "server" | "build";
export type PackageEffect = "none" | "filesystem" | "network" | "process" | "database" | "external-system";
export type PackageNondeterminism = "none" | "clock" | "random" | "environment" | "external" | "unknown";

export type PackageCapabilityProvenance = "declared-v2" | "migrated-v1";

export interface PackageCapabilityV2 {
  readonly version: 2;
  readonly package: string;
  readonly packageVersion: string;
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
  readonly provenance: PackageCapabilityProvenance;
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
    | "operation"
    | "route"
    | "page"
    | "permission"
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
    readonly compositionProtocolVersion: 2;
    readonly packageCapabilityVersion: 2;
    readonly packageCapabilitySemantics: "descriptive";
  };
  readonly base: ArchitectureManifest;
  readonly workspaces: readonly WorkspaceArchitectureManifest[];
  readonly composition: readonly ComposedSemanticRecord[];
  readonly linkage: {
    readonly protocolVersion: 1;
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
  readonly application?: App<Readonly<Record<string, { readonly contract: { readonly name: string } }>>, ExecutionContext>;
  readonly workspaces?: readonly {
    readonly name: string;
    readonly root: string;
    readonly tsconfig?: string;
    readonly packageCapabilities?: Readonly<Record<string, PackageCapability>>;
  }[];
  readonly packageCapabilitiesV2?: readonly PackageCapabilityV2Input[];
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

const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function owningPackageName(specifier: string): string | undefined {
  const normalized = specifier.replace(/^node:/, "");
  if (NODE_BUILTINS.has(normalized)) return `node:${normalized}`;
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return packageName === undefined || packageName === "" || packageName.includes("..") ? undefined : packageName;
}

function packageVersionAt(packageJsonPath: string, expectedName: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return isRecord(value) && value.name === expectedName && typeof value.version === "string" && value.version.trim() !== ""
      ? value.version
      : undefined;
  } catch {
    return undefined;
  }
}

function installedPackageVersion(root: string, specifier: string): string | undefined {
  const packageName = owningPackageName(specifier);
  if (packageName === undefined) return undefined;
  if (packageName.startsWith("node:")) return process.versions.node;
  let current = path.resolve(root);
  while (true) {
    const ownVersion = packageVersionAt(path.join(current, "package.json"), packageName);
    if (ownVersion !== undefined) return ownVersion;
    const installedVersion = packageVersionAt(path.join(current, "node_modules", ...packageName.split("/"), "package.json"), packageName);
    if (installedVersion !== undefined) return installedVersion;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function packageVersionObservation(root: string, packageName: string, reason: string): CompletenessObservation {
  return { category: "unknown", kind: "package-version", name: packageName, root, file: "package.json", reason };
}

function capabilityVersionObservations(
  root: string,
  packagePolicy: ArchitectureManifest["packagePolicy"],
  capabilities: readonly PackageCapabilityV2[],
): CompletenessObservation[] {
  const observations: CompletenessObservation[] = [];
  const unresolved = new Set<string>();
  const resolve = (packageName: string): string | undefined => {
    const installed = installedPackageVersion(root, packageName);
    if (installed === undefined && !unresolved.has(packageName)) {
      unresolved.add(packageName);
      observations.push(packageVersionObservation(root, packageName, "installed package version could not be resolved; configure an exact package capability v2 decision after installing the package"));
    }
    return installed;
  };
  for (const entry of packagePolicy) {
    const installed = resolve(entry.package);
    if (installed !== undefined && !capabilities.some((decision) => decision.package === entry.package && decision.packageVersion === installed)) {
      observations.push(packageVersionObservation(root, entry.package, `package capability decision does not match installed version ${installed}`));
    }
  }
  for (const decision of capabilities) {
    const installed = resolve(decision.package);
    if (installed !== undefined && decision.packageVersion !== installed) {
      observations.push(packageVersionObservation(root, decision.package, `configured version ${decision.packageVersion} does not match installed version ${installed}`));
    }
  }
  return observations;
}

function migrateInstalledPackagePolicy(
  root: string,
  packagePolicy: ArchitectureManifest["packagePolicy"],
): readonly PackageCapabilityV2[] {
  return Object.freeze(packagePolicy.flatMap((entry) => {
    const version = installedPackageVersion(root, entry.package);
    return version === undefined ? [] : [migratePackageCapabilityV1(entry.package, entry.capability, version)];
  }));
}

function configuredV3Options(root: string): Pick<AnalyzeApplicationV3Options, "workspaces" | "packageCapabilitiesV2"> {
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
  const capabilities: PackageCapabilityV2[] = [];
  if (Array.isArray(configuration.packageCapabilitiesV2)) {
    for (const entry of configuration.packageCapabilitiesV2) {
      if (
        !isRecord(entry) ||
        entry.version !== 2 ||
        typeof entry.package !== "string" ||
        typeof entry.packageVersion !== "string" ||
        !Array.isArray(entry.runtime) ||
        !entry.runtime.every(isPackageRuntimeLocation) ||
        !Array.isArray(entry.effects) ||
        !entry.effects.every(isPackageEffect) ||
        !Array.isArray(entry.nondeterminism) ||
        !entry.nondeterminism.every(isPackageNondeterminism)
      ) throw new TypeError("Invalid typescriptOnRails.packageCapabilitiesV2 entry");
      const candidate: PackageCapabilityV2 = {
        version: 2,
        package: entry.package,
        packageVersion: entry.packageVersion,
        runtime: Object.freeze([...entry.runtime]),
        effects: Object.freeze([...entry.effects]),
        nondeterminism: Object.freeze([...entry.nondeterminism]),
        provenance: "declared-v2",
        ...(typeof entry.inheritedFrom === "string" ? { inheritedFrom: entry.inheritedFrom } : {}),
      };
      validatePackageCapabilityV2("application", candidate);
      capabilities.push(candidate);
    }
  }
  return {
    ...(workspaces.length === 0 ? {} : { workspaces: Object.freeze(workspaces) }),
    ...(capabilities.length === 0 ? {} : { packageCapabilitiesV2: Object.freeze(capabilities) }),
  };
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

interface OperationStaticCall {
  readonly callee: string;
  readonly file: string;
  readonly line: number;
  readonly event?: string;
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
  readonly calls: readonly OperationStaticCall[];
  readonly resolved: boolean;
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
      const calls: OperationStaticCall[] = [];
      let resolved = false;
      const inspectRun = (run: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration): boolean => {
        const context = run.parameters[1]?.name;
        if (context === undefined) return true;
        if (!ts.isIdentifier(context)) return false;
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const callee = expressionPath(node.expression);
            if (callee?.startsWith(`${context.text}.`) === true) {
              const eventArgument = node.arguments[0];
              calls.push(Object.freeze({
                callee,
                file: operation.file,
                line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
                ...(callee.endsWith(".appendOutbox") && eventArgument !== undefined && ts.isIdentifier(eventArgument)
                  ? { event: eventArgument.text }
                  : {}),
              }));
            }
          }
          ts.forEachChild(node, visit);
        };
        if (run.body === undefined) return false;
        visit(run.body);
        return true;
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
            if (ts.isMethodDeclaration(property)) resolved = inspectRun(property);
            else if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) resolved = inspectRun(property.initializer);
          }
        }
      }
      output.set(key, Object.freeze({ calls: Object.freeze(calls), resolved }));
    } catch {
      output.set(key, Object.freeze({ calls: Object.freeze([]), resolved: false }));
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

function sourceDetail(
  detail: Readonly<Record<string, unknown>>,
  source: CompositionSource | undefined,
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...detail, ...(source === undefined ? {} : { source }) });
}

function compose(
  graph: ApplicationGraph | undefined,
  base: ArchitectureManifest,
  sources: ReadonlyMap<string, CompositionSource>,
  calls: ReadonlyMap<string, OperationStaticAnalysis>,
): ComposedSemanticRecord[] {
  if (graph === undefined) return [];
  const records: ComposedSemanticRecord[] = [];
  const operationSources = new Map(base.operations.map((operation) => [
    `${operation.feature ?? "application"}:${operation.name}`,
    Object.freeze({ file: operation.file, line: operation.line, provenance: "manifest-v2" as const }),
  ]));
  for (const feature of graph.features) {
    records.push({ kind: "feature", owner: feature.name, name: feature.name });
    for (const item of feature.pages) records.push({ kind: "page", owner: feature.name, name: item.metadata.name, detail: { path: item.metadata.path, runtime: item.metadata.runtime } });
    for (const permission of feature.permissions) records.push({ kind: "permission", owner: feature.name, name: permission });
    for (const adapter of feature.adapters) records.push({ kind: "adapter", owner: feature.name, name: adapter.contract.name });
    for (const test of feature.tests) records.push({
      kind: "test",
      owner: feature.name,
      name: test,
      detail: { source: Object.freeze({ file: test, line: 1, provenance: "declared-test" as const }) },
    });
  }
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
          calls: analysis?.calls ?? [],
          callsResolved: analysis?.resolved ?? false,
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
    owner: test.feature,
    name: file,
    detail: { source: Object.freeze({ file, line: 1, provenance: "declared-test" as const }) },
  });
  const unique = new Map<string, ComposedSemanticRecord>();
  for (const record of records) {
    const key = `${record.kind}:${record.owner}:${record.name}`;
    const prior = unique.get(key);
    if (prior !== undefined && JSON.stringify(prior.detail) !== JSON.stringify(record.detail)) {
      throw new Error(`CONFLICTING_COMPOSITION_RECORD:${key}`);
    }
    unique.set(key, record);
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
    for (const record of composition) {
      if ((record.kind === "route" || record.kind === "consumer" || record.kind === "entrypoint") &&
          (typeof record.detail?.source !== "object" || record.detail.source === null)) {
        observations.push({ category: "unknown", kind: `${record.kind}-source`, name: `${record.owner}.${record.name}`, root: applicationRoot, reason: "registered runtime object has no unique static source provenance" });
      }
      if (record.kind === "operation" && record.detail?.callsResolved !== true) {
        observations.push({ category: "unknown", kind: "operation-calls", name: `${record.owner}.${record.name}`, root: applicationRoot, reason: "operation call-path extraction could not be resolved" });
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
      if (record.kind === "test") {
        try {
          if (!statSync(path.join(applicationRoot, record.name)).isFile()) throw new Error("not a file");
        } catch {
          observations.push({ category: "unknown", kind: "test-source", name: record.name, root: applicationRoot, file: record.name, reason: "registered test file does not exist" });
        }
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
    (decision.provenance !== undefined && decision.provenance !== "declared-v2" && decision.provenance !== "migrated-v1")
  ) throw new TypeError(`Invalid package capability v2 decision in ${workspace}: ${decision.package}`);
}

function normalizePackageCapabilityV2(decision: PackageCapabilityV2Input): PackageCapabilityV2 {
  return Object.freeze({
    ...decision,
    runtime: Object.freeze([...decision.runtime]),
    effects: Object.freeze([...decision.effects]),
    nondeterminism: Object.freeze([...decision.nondeterminism]),
    provenance: decision.provenance ?? "declared-v2",
  });
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
    resolved.set(`${normalized.package}@${normalized.packageVersion}`, Object.freeze({ ...normalized, inheritedFrom: normalized.inheritedFrom ?? "parent" }));
  }
  for (const decision of decisions) {
    validatePackageCapabilityV2(workspace, decision);
    const normalized = normalizePackageCapabilityV2(decision);
    resolved.set(`${normalized.package}@${normalized.packageVersion}`, normalized);
  }
  return Object.freeze([...resolved.values()].sort((left, right) => compareText(`${left.package}@${left.packageVersion}`, `${right.package}@${right.packageVersion}`)));
}

export function analyzeApplicationV3(applicationRoot: string, options: AnalyzeApplicationV3Options = {}): ArchitectureManifestV3 {
  const {
    application,
    workspaces: suppliedWorkspaces,
    packageCapabilitiesV2: suppliedCapabilities,
    ...baseOptions
  } = options;
  const fileOptions = configuredV3Options(applicationRoot);
  const configured = suppliedWorkspaces ?? fileOptions.workspaces ?? [];
  const packageCapabilitiesV2 = suppliedCapabilities ?? fileOptions.packageCapabilitiesV2;
  const base = analyzeApplication(applicationRoot, baseOptions);
  const applicationDecisions = packageCapabilitiesV2 ?? migrateInstalledPackagePolicy(applicationRoot, base.packagePolicy);
  const capabilities = resolvePackageCapabilitiesV2("application", applicationDecisions);
  const versionObservations: CompletenessObservation[] = capabilityVersionObservations(applicationRoot, base.packagePolicy, capabilities);
  const workspaces: WorkspaceArchitectureManifest[] = [{
    name: "application",
    root: applicationRoot,
    role: "application",
    manifest: base,
    packageCapabilities: capabilities,
  }];
  for (const workspace of configured) {
    const manifest = analyzeApplication(workspace.root, {
      ...(workspace.tsconfig === undefined ? {} : { tsconfig: workspace.tsconfig }),
      ...(workspace.packageCapabilities === undefined ? {} : { packageCapabilities: workspace.packageCapabilities }),
    });
    const workspaceDecisions = migrateInstalledPackagePolicy(workspace.root, manifest.packagePolicy);
    const workspaceCapabilities = resolvePackageCapabilitiesV2(workspace.name, workspaceDecisions, capabilities);
    versionObservations.push(...capabilityVersionObservations(workspace.root, manifest.packagePolicy, workspaceCapabilities));
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
  const linkage = Object.freeze({ protocolVersion: 1 as const, links: Object.freeze([...(graph?.links ?? [])]) });
  return Object.freeze({
    version: 3,
    compiler: Object.freeze({ manifestVersion: 3, baseManifestVersion: 2, typescriptVersion: ts.version, compositionProtocolVersion: 2, packageCapabilityVersion: 2, packageCapabilitySemantics: "descriptive" as const }),
    base,
    workspaces: Object.freeze(workspaces),
    composition: Object.freeze(composition),
    linkage,
    completeness: completeness(applicationRoot, base, graph, sourceFiles, composition, workspaces, versionObservations),
    packageCapabilities: Object.freeze([...capabilities].sort((left, right) => compareText(left.package, right.package))),
  });
}

export function migrateManifestV2(manifest: ArchitectureManifest): ArchitectureManifestV3 {
  return Object.freeze({
    version: 3,
    compiler: Object.freeze({ manifestVersion: 3, baseManifestVersion: 2, typescriptVersion: ts.version, compositionProtocolVersion: 2, packageCapabilityVersion: 2, packageCapabilitySemantics: "descriptive" as const }),
    base: manifest,
    workspaces: Object.freeze([{
      name: "application",
      root: ".",
      role: "application" as const,
      manifest,
      packageCapabilities: Object.freeze([]),
    }]),
    composition: Object.freeze([]),
    linkage: Object.freeze({ protocolVersion: 1 as const, links: Object.freeze([]) }),
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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

import { architecture } from "../runtime/index.js";
import type { App, ApplicationGraph, ExecutionContext, PackageCapability } from "../runtime/index.js";
import { analyzeApplication } from "./analyze.js";
import type { AnalyzeApplicationOptions, ArchitectureManifest } from "./manifest.js";

architecture.allow({
  rule: "package-capability",
  reason: "Manifest v3 performs framework-owned static source discovery with Node filesystem and the pinned TypeScript compiler API.",
});

export type PackageRuntimeLocation = "universal" | "browser" | "server" | "build";
export type PackageEffect = "none" | "filesystem" | "network" | "process" | "database" | "external-system";
export type PackageNondeterminism = "none" | "clock" | "random" | "environment" | "external" | "unknown";

export interface PackageCapabilityV2 {
  readonly version: 2;
  readonly package: string;
  readonly packageVersion: string;
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
  readonly inheritedFrom?: string;
}

export interface WorkspaceArchitectureManifest {
  readonly name: string;
  readonly root: string;
  readonly role: "application" | "support";
  readonly manifest: ArchitectureManifest;
  readonly packageCapabilities: readonly PackageCapabilityV2[];
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
    readonly compositionProtocolVersion: 1;
    readonly packageCapabilityVersion: 2;
  };
  readonly base: ArchitectureManifest;
  readonly workspaces: readonly WorkspaceArchitectureManifest[];
  readonly composition: readonly ComposedSemanticRecord[];
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
  readonly packageCapabilitiesV2?: readonly PackageCapabilityV2[];
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

function exportedRouteMethods(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
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

function compose(graph: ApplicationGraph | undefined): ComposedSemanticRecord[] {
  if (graph === undefined) return [];
  const records: ComposedSemanticRecord[] = [];
  for (const feature of graph.features) {
    records.push({ kind: "feature", owner: feature.name, name: feature.name });
    for (const [name, operation] of Object.entries(feature.operations)) {
      records.push({ kind: "operation", owner: feature.name, name, detail: { operationKind: operation.metadata.kind } });
    }
    for (const route of feature.routes) records.push({ kind: "route", owner: feature.name, name: `${route.metadata.method} ${route.metadata.path}` });
    for (const item of feature.pages) records.push({ kind: "page", owner: feature.name, name: item.metadata.name, detail: { path: item.metadata.path, runtime: item.metadata.runtime } });
    for (const permission of feature.permissions) records.push({ kind: "permission", owner: feature.name, name: permission });
    for (const event of feature.events) records.push({ kind: "event", owner: feature.name, name: event.name });
    for (const item of feature.consumers) records.push({ kind: "consumer", owner: feature.name, name: item.metadata.name, detail: { event: item.metadata.event, durable: item.metadata.durable } });
    for (const adapter of feature.adapters) records.push({ kind: "adapter", owner: feature.name, name: adapter.contract.name });
    for (const test of feature.tests) records.push({ kind: "test", owner: feature.name, name: test });
  }
  for (const [process, entry] of Object.entries(graph.entrypoints)) {
    if (entry !== undefined) records.push({ kind: "entrypoint", owner: "application", name: entry.metadata.name, detail: { process } });
  }
  for (const test of graph.tests) for (const file of test.files) records.push({ kind: "test", owner: test.feature, name: file });
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

function completeness(
  applicationRoot: string,
  base: ArchitectureManifest,
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
  const declaredRoutes = new Set(composition.filter(({ kind }) => kind === "route").map(({ name }) => name));
  const declaredPagePaths = new Set(
    composition
      .filter(({ kind, detail }) => kind === "page" && typeof detail?.path === "string")
      .map(({ detail }) => String(detail?.path)),
  );
  for (const file of discoveredFiles(path.join(applicationRoot, "src"))) {
    if (/(^|\/)route\.(?:ts|tsx)$/.test(file)) {
      const discoveredPath = appPath(file, "route") ?? file;
      const methods = exportedRouteMethods(path.join(applicationRoot, "src", file));
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
  const shared = { version: 2 as const, package: packageName, packageVersion };
  switch (capability) {
    case "ui": return { ...shared, runtime: ["browser"], effects: ["none"], nondeterminism: ["unknown"] };
    case "external-system": return { ...shared, runtime: ["server"], effects: ["external-system", "network"], nondeterminism: ["external"] };
    case "host-io": return { ...shared, runtime: ["server", "build"], effects: ["filesystem", "network", "process"], nondeterminism: ["environment", "unknown"] };
    case "pure": return { ...shared, runtime: ["universal"], effects: ["none"], nondeterminism: packageName === "node:os" || packageName === "node:perf_hooks" ? ["environment", "clock"] : ["none"] };
    default: throw new TypeError(`Unknown package capability: ${String(capability)}`);
  }
}

function validatePackageCapabilityV2(workspace: string, decision: PackageCapabilityV2): void {
  if (
    decision.version !== 2 ||
    decision.package.trim() === "" ||
    decision.packageVersion.trim() === "" ||
    decision.packageVersion === "unknown"
  ) throw new TypeError(`Invalid package capability v2 decision in ${workspace}: ${decision.package}`);
}

export function resolvePackageCapabilitiesV2(
  workspace: string,
  decisions: readonly PackageCapabilityV2[],
  inherited: readonly PackageCapabilityV2[] = [],
): readonly PackageCapabilityV2[] {
  const resolved = new Map<string, PackageCapabilityV2>();
  for (const decision of inherited) {
    validatePackageCapabilityV2(workspace, decision);
    resolved.set(`${decision.package}@${decision.packageVersion}`, Object.freeze({ ...decision, inheritedFrom: decision.inheritedFrom ?? "parent" }));
  }
  for (const decision of decisions) {
    validatePackageCapabilityV2(workspace, decision);
    resolved.set(`${decision.package}@${decision.packageVersion}`, Object.freeze({ ...decision }));
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
  const composition = compose(application?.graph);
  return Object.freeze({
    version: 3,
    compiler: Object.freeze({ manifestVersion: 3, baseManifestVersion: 2, typescriptVersion: ts.version, compositionProtocolVersion: 1, packageCapabilityVersion: 2 }),
    base,
    workspaces: Object.freeze(workspaces),
    composition: Object.freeze(composition),
    completeness: completeness(applicationRoot, base, composition, workspaces, versionObservations),
    packageCapabilities: Object.freeze([...capabilities].sort((left, right) => compareText(left.package, right.package))),
  });
}

export function migrateManifestV2(manifest: ArchitectureManifest): ArchitectureManifestV3 {
  return Object.freeze({
    version: 3,
    compiler: Object.freeze({ manifestVersion: 3, baseManifestVersion: 2, typescriptVersion: ts.version, compositionProtocolVersion: 1, packageCapabilityVersion: 2 }),
    base: manifest,
    workspaces: Object.freeze([{
      name: "application",
      root: ".",
      role: "application" as const,
      manifest,
      packageCapabilities: Object.freeze([]),
    }]),
    composition: Object.freeze([]),
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

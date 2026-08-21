import type { ArchitectureManifest } from "../architecture/index.js";
import {
  assertComparableManifestV2,
  ManifestCompatibilityError,
} from "./manifest-compatibility.js";
import { requiredSemanticId } from "./selector.js";

export interface SemanticChange<T> {
  readonly before: T;
  readonly after: T;
}

export interface SemanticCategory<T> {
  readonly added: readonly T[];
  readonly removed: readonly T[];
  readonly changed: readonly SemanticChange<T>[];
}

export interface SemanticOwner { readonly kind: "feature" | "infra" | "app"; readonly name: string }
export interface DiagnosticSemantic { readonly code: string; readonly path: string; readonly message: string }
export type StaticTypeSemantic =
  | { readonly status: "resolved"; readonly provenance: "inferred-typescript"; readonly contract: import("../architecture/index.js").TypeContract }
  | { readonly status: "unresolved"; readonly provenance: "inferred-typescript"; readonly diagnostic: DiagnosticSemantic };
export type RuntimeSchemaSemantic =
  | { readonly status: "resolved"; readonly provenance: "declared-schema"; readonly validator: "declared"; readonly metadata: import("../runtime/index.js").SchemaMetadata }
  | { readonly status: "unresolved"; readonly provenance: "declared-schema"; readonly validator: "declared"; readonly diagnostic: DiagnosticSemantic }
  | { readonly status: "unresolved"; readonly validator: "not-declared"; readonly diagnostic: DiagnosticSemantic }
  | { readonly status: "not-declared"; readonly validator: "not-declared" };
export interface ContractSlotSemantic { readonly staticType: StaticTypeSemantic; readonly runtimeSchema: RuntimeSchemaSemantic }
export interface FeatureSemantic { readonly id: string; readonly owner: SemanticOwner; readonly name: string; readonly feature: string | null }
export interface PublicApiSemantic extends FeatureSemantic { readonly kind: string }
export interface DependencySemantic { readonly from: string; readonly to: string; readonly symbols: readonly string[] }
export interface PackagePolicySemantic { readonly package: string; readonly capability: import("../runtime/index.js").PackageCapability }
export interface PackageUseSemantic { readonly package: string; readonly capability: import("../runtime/index.js").PackageCapability }
export interface ModelSemantic extends FeatureSemantic { readonly fields: RuntimeSchemaSemantic }
export interface OperationSemantic extends FeatureSemantic {
  readonly kind: "action" | "query";
  readonly input: ContractSlotSemantic;
  readonly output: ContractSlotSemantic;
  readonly access: "public" | "permission" | "authorize" | "missing";
  readonly permission: string | null;
}
export interface RouteSemantic extends FeatureSemantic {
  readonly method: string | null;
  readonly path: string | null;
  readonly input: ContractSlotSemantic;
  readonly output: ContractSlotSemantic;
  readonly access: "public" | "permission" | "authorize" | "missing";
  readonly permission: string | null;
}
export interface EventSemantic extends FeatureSemantic { readonly payload: RuntimeSchemaSemantic }
export type AdapterOperationsSemantic =
  | { readonly status: "resolved"; readonly operations: Readonly<Record<string, { readonly input: RuntimeSchemaSemantic; readonly output: RuntimeSchemaSemantic }>> }
  | { readonly status: "unresolved"; readonly diagnostic: DiagnosticSemantic };
export type AdapterSemantic =
  | (FeatureSemantic & { readonly kind: "contract"; readonly operations: AdapterOperationsSemantic })
  | (FeatureSemantic & { readonly kind: "implementation"; readonly contractId: string | null });

export interface ArchitectureDiff {
  readonly changed: boolean;
  readonly features: SemanticCategory<FeatureSemantic>;
  readonly publicApis: SemanticCategory<PublicApiSemantic>;
  readonly dependencies: SemanticCategory<DependencySemantic>;
  readonly packagePolicy: SemanticCategory<PackagePolicySemantic>;
  readonly packageUses: SemanticCategory<PackageUseSemantic>;
  readonly models: SemanticCategory<ModelSemantic>;
  readonly operations: SemanticCategory<OperationSemantic>;
  readonly permissions: SemanticCategory<string>;
  readonly routes: SemanticCategory<RouteSemantic>;
  readonly events: SemanticCategory<EventSemantic>;
  readonly adapters: SemanticCategory<AdapterSemantic>;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function category<T>(before: readonly T[], after: readonly T[], key: (entry: T) => string): SemanticCategory<T> {
  const beforeByKey = new Map(before.map((entry) => [key(entry), entry]));
  const afterByKey = new Map(after.map((entry) => [key(entry), entry]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const added: T[] = [];
  const removed: T[] = [];
  const changed: SemanticChange<T>[] = [];
  for (const entryKey of keys) {
    const previous = beforeByKey.get(entryKey);
    const current = afterByKey.get(entryKey);
    if (previous === undefined && current !== undefined) added.push(current);
    else if (previous !== undefined && current === undefined) removed.push(previous);
    else if (previous !== undefined && current !== undefined && stable(previous) !== stable(current)) {
      changed.push({ before: previous, after: current });
    }
  }
  return { added, removed, changed };
}

function diagnostic(value: import("../architecture/index.js").TypeContractDiagnostic): DiagnosticSemantic {
  return { code: value.code, path: value.path, message: value.message };
}

function runtimeSchema(value: import("../architecture/index.js").RuntimeSchemaFacet): RuntimeSchemaSemantic {
  if (value.status === "resolved") return {
    status: value.status,
    provenance: value.provenance,
    validator: value.validator,
    metadata: value.metadata,
  };
  if (value.status === "unresolved") return value.validator === "declared"
    ? { status: value.status, provenance: value.provenance, validator: value.validator, diagnostic: diagnostic(value.diagnostic) }
    : { status: value.status, validator: value.validator, diagnostic: diagnostic(value.diagnostic) };
  return { status: value.status, validator: value.validator };
}

function staticType(value: import("../architecture/index.js").StaticTypeFacet): StaticTypeSemantic {
  return value.status === "resolved"
    ? { status: value.status, provenance: value.provenance, contract: value.contract }
    : { status: value.status, provenance: value.provenance, diagnostic: diagnostic(value.diagnostic) };
}

function slot(value: import("../architecture/index.js").ContractSlot): ContractSlotSemantic {
  return { staticType: staticType(value.staticType), runtimeSchema: runtimeSchema(value.runtimeSchema) };
}

function identity(entry: { readonly id: string | null; readonly owner: SemanticOwner; readonly name: string; readonly feature: string | null }): FeatureSemantic {
  return { id: requiredSemanticId(entry), owner: entry.owner, name: entry.name, feature: entry.feature };
}

function publicApis(manifest: ArchitectureManifest): PublicApiSemantic[] {
  return manifest.features.flatMap((feature) => feature.exports.map((entry) => ({ ...identity(entry), kind: entry.kind })));
}

function adapterOperations(value: import("../architecture/index.js").AdapterOperationsFacet): AdapterOperationsSemantic {
  if (value.status === "unresolved") return { status: value.status, diagnostic: diagnostic(value.diagnostic) };
  return {
    status: value.status,
    operations: Object.fromEntries(Object.entries(value.operations)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([name, operation]) => [name, { input: runtimeSchema(operation.input), output: runtimeSchema(operation.output) }])),
  };
}

function dependencies(manifest: ArchitectureManifest): DependencySemantic[] {
  const edges = new Map<string, { readonly from: string; readonly to: string; readonly symbols: Set<string> }>();
  for (const entry of manifest.dependencies) {
    const key = stable([entry.from, entry.to]);
    const edge = edges.get(key) ?? { from: entry.from, to: entry.to, symbols: new Set<string>() };
    for (const symbol of entry.symbols) edge.symbols.add(symbol);
    edges.set(key, edge);
  }
  return [...edges.values()]
    .map((entry) => ({ from: entry.from, to: entry.to, symbols: [...entry.symbols].sort() }));
}

function packageUses(manifest: ArchitectureManifest): PackageUseSemantic[] {
  const values = new Map<string, PackageUseSemantic>();
  for (const entry of manifest.packageUses) {
    values.set(entry.package, { package: entry.package, capability: entry.capability });
  }
  return [...values.values()];
}

function semantic(manifest: ArchitectureManifest) {
  return {
    features: manifest.features.map(identity),
    publicApis: publicApis(manifest),
    dependencies: dependencies(manifest),
    packagePolicy: manifest.packagePolicy.map((entry) => ({ package: entry.package, capability: entry.capability })),
    packageUses: packageUses(manifest),
    models: manifest.models.map((entry) => ({ ...identity(entry), fields: runtimeSchema(entry.fields) })),
    operations: manifest.operations.map((entry) => ({
      ...identity(entry), kind: entry.kind, input: slot(entry.input), output: slot(entry.output),
      access: entry.access, permission: entry.permission ?? null,
    })),
    permissions: [...manifest.permissions],
    routes: manifest.routes.map((entry) => ({
      ...identity(entry), method: entry.method, path: entry.path, input: slot(entry.input), output: slot(entry.output),
      access: entry.access, permission: entry.permission ?? null,
    })),
    events: manifest.events.map((entry) => ({ ...identity(entry), payload: runtimeSchema(entry.payload) })),
    adapters: manifest.adapters.map((entry): AdapterSemantic => entry.kind === "contract"
      ? { ...identity(entry), kind: entry.kind, operations: adapterOperations(entry.operations) }
      : { ...identity(entry), kind: entry.kind, contractId: entry.contractId }),
  };
}

function address(entry: FeatureSemantic): string {
  return entry.id;
}

function hasChanges(value: { readonly added: readonly unknown[]; readonly removed: readonly unknown[]; readonly changed: readonly unknown[] }): boolean {
  return value.added.length > 0 || value.removed.length > 0 || value.changed.length > 0;
}

function manifestVersion(value: unknown): unknown {
  return typeof value === "object" && value !== null && "version" in value ? value.version : undefined;
}

export function diffArchitecture(before: unknown, after: unknown): ArchitectureDiff {
  const beforeVersion = manifestVersion(before);
  const afterVersion = manifestVersion(after);
  if ((beforeVersion === 1 && afterVersion === 2) || (beforeVersion === 2 && afterVersion === 1)) {
    throw new ManifestCompatibilityError("mixed-version", "Architecture manifests from versions 1 and 2 cannot be compared.");
  }
  assertComparableManifestV2(before);
  assertComparableManifestV2(after);
  const previous = semantic(before);
  const current = semantic(after);
  const result = {
    features: category(previous.features, current.features, address),
    publicApis: category(previous.publicApis, current.publicApis, address),
    dependencies: category(previous.dependencies, current.dependencies, (entry) => stable([entry.from, entry.to])),
    packagePolicy: category(previous.packagePolicy, current.packagePolicy, (entry) => entry.package),
    packageUses: category(previous.packageUses, current.packageUses, (entry) => entry.package),
    models: category(previous.models, current.models, address),
    operations: category(previous.operations, current.operations, address),
    permissions: category(previous.permissions, current.permissions, (entry) => entry),
    routes: category(previous.routes, current.routes, address),
    events: category(previous.events, current.events, address),
    adapters: category(previous.adapters, current.adapters, address),
  };
  const changed = Object.values(result).some(hasChanges);
  return { changed, ...result };
}

const categoryOrder = [
  ["Feature", "features"],
  ["Public API", "publicApis"],
  ["Dependency", "dependencies"],
  ["Package policy", "packagePolicy"],
  ["Package use", "packageUses"],
  ["Model", "models"],
  ["Operation", "operations"],
  ["Permission", "permissions"],
  ["Route", "routes"],
  ["Event", "events"],
  ["Adapter", "adapters"],
] as const;

function description(value: unknown, categoryName: (typeof categoryOrder)[number][1]): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  if ("name" in value && typeof value.name === "string") {
    if (categoryName === "features") return value.name;
    if ("owner" in value && typeof value.owner === "object" && value.owner !== null && "kind" in value.owner && "name" in value.owner) {
      const owner = value.owner;
      const prefix = owner.kind === "feature" ? String(owner.name) : String(owner.kind);
      return `${prefix}.${value.name}`;
    }
    return value.name;
  }
  if ("from" in value && "to" in value) return `${String(value.from)} -> ${String(value.to)}`;
  if ("package" in value && "capability" in value) return `${String(value.package)} (${String(value.capability)})`;
  return stable(value);
}

export function formatArchitectureDiff(diff: ArchitectureDiff): string {
  if (!diff.changed) return "No architecture changes.\n";
  const lines = ["Architecture changes"];
  for (const [label, key] of categoryOrder) {
    const entries = diff[key];
    for (const entry of entries.added) lines.push(`${label} added: ${description(entry, key)}`);
    for (const entry of entries.removed) lines.push(`${label} removed: ${description(entry, key)}`);
    for (const entry of entries.changed) lines.push(`${label} changed: ${description(entry.after, key)}`);
  }
  return `${lines.join("\n")}\n`;
}

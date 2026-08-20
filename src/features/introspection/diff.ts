import type { ArchitectureManifest } from "../architecture/index.js";

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
export interface FeatureSemantic { readonly id: string | null; readonly owner: SemanticOwner; readonly name: string; readonly feature: string | null }
export interface PublicApiSemantic extends FeatureSemantic { readonly kind: string }
export interface DependencySemantic { readonly from: string; readonly to: string }
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

function category<T>(before: readonly T[], after: readonly T[], key: (entry: T, index: number) => string): SemanticCategory<T> {
  const beforeByKey = new Map(before.map((entry, index) => [key(entry, index), entry]));
  const afterByKey = new Map(after.map((entry, index) => [key(entry, index), entry]));
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
    ? {
        status: value.status,
        provenance: value.provenance,
        validator: value.validator,
        diagnostic: diagnostic(value.diagnostic),
      }
    : {
        status: value.status,
        validator: value.validator,
        diagnostic: diagnostic(value.diagnostic),
      };
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
  return { id: entry.id, owner: entry.owner, name: entry.name, feature: entry.feature };
}

function publicApis(manifest: ArchitectureManifest): PublicApiSemantic[] {
  return manifest.features.flatMap((feature) => feature.exports.map((entry) => ({
    ...identity(entry),
    kind: entry.kind,
  })));
}

function adapterOperations(value: import("../architecture/index.js").AdapterOperationsFacet): AdapterOperationsSemantic {
  if (value.status === "unresolved") return { status: value.status, diagnostic: diagnostic(value.diagnostic) };
  return {
    status: value.status,
    operations: Object.fromEntries(Object.entries(value.operations).map(([name, operation]) => [name, {
      input: runtimeSchema(operation.input),
      output: runtimeSchema(operation.output),
    }])),
  };
}

function semantic(manifest: ArchitectureManifest) {
  return {
    features: manifest.features.map(identity),
    publicApis: publicApis(manifest),
    dependencies: manifest.dependencies.map((entry) => ({ from: entry.from, to: entry.to })),
    models: manifest.models.map((entry) => ({ ...identity(entry), fields: runtimeSchema(entry.fields) })),
    operations: manifest.operations.map((entry) => ({
      ...identity(entry),
      kind: entry.kind,
      input: slot(entry.input),
      output: slot(entry.output),
      access: entry.access,
      permission: entry.permission ?? null,
    })),
    permissions: [...manifest.permissions],
    routes: manifest.routes.map((entry) => ({
      ...identity(entry),
      method: entry.method,
      path: entry.path,
      input: slot(entry.input),
      output: slot(entry.output),
      access: entry.access,
      permission: entry.permission ?? null,
    })),
    events: manifest.events.map((entry) => ({ ...identity(entry), payload: runtimeSchema(entry.payload) })),
    adapters: manifest.adapters.map((entry): AdapterSemantic => entry.kind === "contract"
      ? { ...identity(entry), kind: entry.kind, operations: adapterOperations(entry.operations) }
      : { ...identity(entry), kind: entry.kind, contractId: entry.contractId }),
  };
}

function address(entry: FeatureSemantic): string {
  return entry.id ?? `unresolved\0${entry.owner.kind}\0${entry.owner.name}\0${entry.name}`;
}

function hasChanges<T>(value: SemanticCategory<T>): boolean {
  return value.added.length > 0 || value.removed.length > 0 || value.changed.length > 0;
}

export function diffArchitecture(before: ArchitectureManifest, after: ArchitectureManifest): ArchitectureDiff {
  const previous = semantic(before);
  const current = semantic(after);
  const result = {
    features: category(previous.features, current.features, address),
    publicApis: category(previous.publicApis, current.publicApis, address),
    dependencies: category(previous.dependencies, current.dependencies, (entry) => `${entry.from}\0${entry.to}`),
    models: category(previous.models, current.models, address),
    operations: category(previous.operations, current.operations, address),
    permissions: category(previous.permissions, current.permissions, (entry) => entry),
    routes: category(previous.routes, current.routes, address),
    events: category(previous.events, current.events, address),
    adapters: category(previous.adapters, current.adapters, address),
  };
  const changed = hasChanges(result.features)
    || hasChanges(result.publicApis)
    || hasChanges(result.dependencies)
    || hasChanges(result.models)
    || hasChanges(result.operations)
    || hasChanges(result.permissions)
    || hasChanges(result.routes)
    || hasChanges(result.events)
    || hasChanges(result.adapters);
  return { changed, ...result };
}

const categoryOrder = [
  ["Feature", "features"],
  ["Public API", "publicApis"],
  ["Dependency", "dependencies"],
  ["Model", "models"],
  ["Operation", "operations"],
  ["Permission", "permissions"],
  ["Route", "routes"],
  ["Event", "events"],
  ["Adapter", "adapters"],
] as const;

function description(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);
  if ("name" in value && typeof value.name === "string") return value.name;
  if ("from" in value && "to" in value) return `${String(value.from)} -> ${String(value.to)}`;
  return stable(value);
}

export function formatArchitectureDiff(diff: ArchitectureDiff): string {
  if (!diff.changed) return "No architecture changes.\n";
  const lines = ["Architecture changes"];
  for (const [label, key] of categoryOrder) {
    const entries = diff[key];
    for (const entry of entries.added) lines.push(`${label} added: ${description(entry)}`);
    for (const entry of entries.removed) lines.push(`${label} removed: ${description(entry)}`);
    for (const entry of entries.changed) lines.push(`${label} changed: ${description(entry.after)}`);
  }
  return `${lines.join("\n")}\n`;
}

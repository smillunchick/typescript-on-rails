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

export interface FeatureSemantic { readonly name: string }
export interface PublicApiSemantic { readonly feature: string; readonly name: string; readonly kind: string }
export interface DependencySemantic { readonly from: string; readonly to: string }
export interface ModelSemantic { readonly name: string; readonly feature: string | null }
export interface RouteSemantic { readonly name: string; readonly method: string | null; readonly path: string | null; readonly feature: string | null; readonly permission: string | null }
export interface EventSemantic { readonly name: string; readonly feature: string | null }
export interface AdapterSemantic { readonly name: string; readonly kind: "contract" | "implementation"; readonly feature: string | null }

export interface ArchitectureDiff {
  readonly changed: boolean;
  readonly features: SemanticCategory<FeatureSemantic>;
  readonly publicApis: SemanticCategory<PublicApiSemantic>;
  readonly dependencies: SemanticCategory<DependencySemantic>;
  readonly models: SemanticCategory<ModelSemantic>;
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

function publicApis(manifest: ArchitectureManifest): PublicApiSemantic[] {
  return manifest.features.flatMap((feature) => feature.exports.map((entry) => ({
    feature: feature.name,
    name: entry.name,
    kind: entry.kind,
  }))).sort((left, right) => left.feature.localeCompare(right.feature) || left.name.localeCompare(right.name));
}

function semantic(manifest: ArchitectureManifest) {
  return {
    features: manifest.features.map((entry) => ({ name: entry.name })),
    publicApis: publicApis(manifest),
    dependencies: manifest.dependencies.map((entry) => ({ from: entry.from, to: entry.to })),
    models: manifest.models.map((entry) => ({ name: entry.name, feature: entry.feature })),
    permissions: [...manifest.permissions],
    routes: manifest.routes.map((entry) => ({
      name: entry.name,
      method: entry.method,
      path: entry.path,
      feature: entry.feature,
      permission: entry.permission ?? null,
    })),
    events: manifest.events.map((entry) => ({ name: entry.name, feature: entry.feature })),
    adapters: manifest.adapters.map((entry) => ({ name: entry.name, kind: entry.kind, feature: entry.feature })),
  };
}

function hasChanges<T>(value: SemanticCategory<T>): boolean {
  return value.added.length > 0 || value.removed.length > 0 || value.changed.length > 0;
}

export function diffArchitecture(before: ArchitectureManifest, after: ArchitectureManifest): ArchitectureDiff {
  const previous = semantic(before);
  const current = semantic(after);
  const result = {
    features: category(previous.features, current.features, (entry) => entry.name),
    publicApis: category(previous.publicApis, current.publicApis, (entry) => `${entry.feature}\0${entry.name}`),
    dependencies: category(previous.dependencies, current.dependencies, (entry) => `${entry.from}\0${entry.to}`),
    models: category(previous.models, current.models, (entry) => entry.name),
    permissions: category(previous.permissions, current.permissions, (entry) => entry),
    routes: category(previous.routes, current.routes, (entry) => entry.name),
    events: category(previous.events, current.events, (entry) => entry.name),
    adapters: category(previous.adapters, current.adapters, (entry) => entry.name),
  };
  const changed = hasChanges(result.features)
    || hasChanges(result.publicApis)
    || hasChanges(result.dependencies)
    || hasChanges(result.models)
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

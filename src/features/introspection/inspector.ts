import {
  analyzeApplication,
  type AdapterManifest,
  type AnalyzeApplicationOptions,
  type ArchitectureExceptionManifest,
  type ArchitectureManifest,
  type DependencyManifest,
  type EventManifest,
  type FeatureManifest,
  type ModelManifest,
  type OperationManifest,
  type RouteManifest,
} from "../architecture/index.js";


export interface CallerProjection {
  readonly feature: string;
  readonly owner: string;
  readonly symbol: string;
}

export interface OwnerProjection {
  readonly model: string;
  readonly feature: string | null;
}

export interface BoundaryProjection {
  readonly feature: string;
  readonly path: string | null;
  readonly exports: readonly { readonly name: string; readonly kind: string }[];
}

export interface ImpactProjection {
  readonly symbol: string;
  readonly owner: string | null;
  readonly callers: readonly string[];
}

export interface FeatureExplanation {
  readonly name: string;
  readonly publicBoundary: string | null;
  readonly publicApi: readonly { readonly name: string; readonly kind: string }[];
  readonly models: readonly string[];
  readonly actions: readonly string[];
  readonly queries: readonly string[];
  readonly routes: readonly string[];
  readonly permissions: readonly string[];
  readonly events: readonly string[];
  readonly adapters: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
}

export interface RouteExplanation {
  readonly name: string;
  readonly method: string | null;
  readonly path: string | null;
  readonly feature: string | null;
  readonly permission?: string;
}

export interface ApplicationInspector {
  readonly manifest: ArchitectureManifest;
  features(): readonly FeatureManifest[];
  dependencies(): readonly DependencyManifest[];
  actions(): readonly OperationManifest[];
  queries(): readonly OperationManifest[];
  models(): readonly ModelManifest[];
  permissions(): readonly string[];
  events(): readonly EventManifest[];
  adapters(): readonly AdapterManifest[];
  routes(): readonly RouteManifest[];
  owners(): readonly OwnerProjection[];
  boundaries(): readonly BoundaryProjection[];
  exceptions(): readonly ArchitectureExceptionManifest[];
  findOwner(modelName: string): ModelManifest | null;
  findCallers(publicSymbol: string): readonly CallerProjection[];
  explainFeature(name: string): FeatureExplanation | null;
  explainRoute(path: string): RouteExplanation | null;
  impact(publicSymbol: string): ImpactProjection;
}

function uniqueSorted(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

function featureOwner(manifest: ArchitectureManifest, publicSymbol: string): string | null {
  return manifest.features.find((feature) => feature.exports.some((entry) => entry.name === publicSymbol))?.name ?? null;
}

function operationNames(manifest: ArchitectureManifest, feature: string, kind: "action" | "query"): string[] {
  return manifest.operations
    .filter((operation) => operation.feature === feature && operation.kind === kind)
    .map((operation) => operation.name)
    .sort();
}

export function inspectManifest(manifest: ArchitectureManifest): ApplicationInspector {
  return {
    manifest,
    features: () => manifest.features,
    dependencies: () => manifest.dependencies,
    actions: () => manifest.operations.filter((operation) => operation.kind === "action"),
    queries: () => manifest.operations.filter((operation) => operation.kind === "query"),
    models: () => manifest.models,
    permissions: () => manifest.permissions,
    events: () => manifest.events,
    adapters: () => manifest.adapters,
    routes: () => manifest.routes,
    owners: () => manifest.models
      .map((model) => ({ model: model.name, feature: model.feature }))
      .sort((left, right) => left.model.localeCompare(right.model) || String(left.feature).localeCompare(String(right.feature))),
    boundaries: () => manifest.features.map((feature) => ({
      feature: feature.name,
      path: feature.publicBoundary,
      exports: feature.exports.map((entry) => ({ name: entry.name, kind: entry.kind })),
    })),
    exceptions: () => manifest.exceptions,
    findOwner: (modelName) => manifest.models.find((model) => model.name === modelName) ?? null,
    findCallers(publicSymbol) {
      const owner = featureOwner(manifest, publicSymbol);
      if (owner === null) return [];
      return manifest.dependencies
        .filter((dependency) => dependency.to === owner
          && (dependency.symbols.includes(publicSymbol) || dependency.symbols.includes("*")))
        .map((dependency) => ({ feature: dependency.from, owner, symbol: publicSymbol }))
        .sort((left, right) => left.feature.localeCompare(right.feature));
    },
    explainFeature(name) {
      const feature = manifest.features.find((entry) => entry.name === name);
      if (feature === undefined) return null;
      const featureRoutes = manifest.routes.filter((entry) => entry.feature === name);
      const operationPermissions = manifest.operations
        .filter((entry) => entry.feature === name)
        .map((entry) => entry.permission ?? null);
      return {
        name,
        publicBoundary: feature.publicBoundary,
        publicApi: feature.exports.map((entry) => ({ name: entry.name, kind: entry.kind })),
        models: manifest.models.filter((entry) => entry.feature === name).map((entry) => entry.name).sort(),
        actions: operationNames(manifest, name, "action"),
        queries: operationNames(manifest, name, "query"),
        routes: featureRoutes.map((entry) => `${entry.method ?? "?"} ${entry.path ?? entry.name}`).sort(),
        permissions: uniqueSorted([...operationPermissions, ...featureRoutes.map((entry) => entry.permission ?? null)]),
        events: manifest.events.filter((entry) => entry.feature === name).map((entry) => entry.name).sort(),
        adapters: manifest.adapters.filter((entry) => entry.feature === name).map((entry) => entry.name).sort(),
        dependencies: uniqueSorted(manifest.dependencies.filter((entry) => entry.from === name).map((entry) => entry.to)),
        dependents: uniqueSorted(manifest.dependencies.filter((entry) => entry.to === name).map((entry) => entry.from)),
      };
    },
    explainRoute(routePath) {
      const route = manifest.routes.find((entry) => entry.path === routePath);
      if (route === undefined) return null;
      return {
        name: route.name,
        method: route.method,
        path: route.path,
        feature: route.feature,
        ...(route.permission === undefined ? {} : { permission: route.permission }),
      };
    },
    impact(publicSymbol) {
      const owner = featureOwner(manifest, publicSymbol);
      const callers = owner === null
        ? []
        : uniqueSorted(manifest.dependencies
          .filter((entry) => entry.to === owner
            && (entry.symbols.includes(publicSymbol) || entry.symbols.includes("*")))
          .map((entry) => entry.from));
      return { symbol: publicSymbol, owner, callers };
    },
  };
}

export function inspectApplication(root: string, options: AnalyzeApplicationOptions = {}): ApplicationInspector {
  return inspectManifest(analyzeApplication(root, options));
}

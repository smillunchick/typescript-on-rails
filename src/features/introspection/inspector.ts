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
  type PublicExportManifest,
  type RouteManifest,
} from "../architecture/index.js";
import {
  createSemanticSelectorResolver,
  requiredSemanticId,
  semanticDisplayName,
  type SemanticSelectorCategory,
  type SemanticSelectorRecord,
  type SemanticSelectorResult,
} from "./selector.js";

export interface IdentityProjection {
  readonly id: string;
  readonly displayName: string;
}

export interface CallerProjection extends IdentityProjection {
  readonly feature: string;
  readonly featureId: string;
  readonly featureDisplayName: string;
  readonly owner: string;
  readonly ownerId: string;
  readonly ownerDisplayName: string;
  readonly symbol: string;
  readonly symbolId: string;
  readonly symbolDisplayName: string;
}

export interface OwnerProjection extends IdentityProjection {
  readonly model: string;
  readonly feature: string | null;
}

export interface NamedIdentityProjection extends IdentityProjection {
  readonly name: string;
}

export interface PublicApiProjection extends NamedIdentityProjection {
  readonly kind: string;
}

export interface RouteSummaryProjection extends NamedIdentityProjection {
  readonly method: string | null;
  readonly path: string | null;
}

export interface BoundaryProjection extends IdentityProjection {
  readonly feature: string;
  readonly path: string | null;
  readonly exports: readonly PublicApiProjection[];
}

export interface ImpactProjection extends IdentityProjection {
  readonly symbol: string;
  readonly owner: string;
  readonly ownerId: string;
  readonly ownerDisplayName: string;
  readonly callers: readonly string[];
  readonly callerIds: readonly string[];
}

export interface FeatureExplanation extends IdentityProjection {
  readonly name: string;
  readonly publicBoundary: string | null;
  readonly publicApi: readonly PublicApiProjection[];
  readonly models: readonly NamedIdentityProjection[];
  readonly actions: readonly NamedIdentityProjection[];
  readonly queries: readonly NamedIdentityProjection[];
  readonly routes: readonly RouteSummaryProjection[];
  readonly permissions: readonly string[];
  readonly events: readonly NamedIdentityProjection[];
  readonly adapters: readonly NamedIdentityProjection[];
  readonly dependencies: readonly NamedIdentityProjection[];
  readonly dependents: readonly NamedIdentityProjection[];
}

export interface RouteExplanation extends IdentityProjection {
  readonly name: string;
  readonly method: string | null;
  readonly path: string | null;
  readonly feature: string | null;
  readonly permission?: string;
}

export interface ApplicationInspector {
  readonly manifest: ArchitectureManifest;
  resolve(selector: string, categories?: readonly SemanticSelectorCategory[]): SemanticSelectorResult;
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
  findOwner(selector: string): SemanticSelectorResult<ModelManifest>;
  findCallers(selector: string): SemanticSelectorResult<readonly CallerProjection[]>;
  explainFeature(selector: string): SemanticSelectorResult<FeatureExplanation>;
  explainRoute(selector: string): SemanticSelectorResult<RouteExplanation>;
  impact(selector: string): SemanticSelectorResult<ImpactProjection>;
}

function uniqueSorted(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

function namedIdentity(
  record: { readonly id: string | null; readonly name: string; readonly owner: FeatureManifest["owner"] },
  category?: SemanticSelectorCategory,
): NamedIdentityProjection {
  return { ...identity(record, category), name: record.name };
}

function operationProjections(
  manifest: ArchitectureManifest,
  feature: string,
  kind: "action" | "query",
): NamedIdentityProjection[] {
  return manifest.operations
    .filter((operation) => operation.feature === feature && operation.kind === kind)
    .map((operation) => namedIdentity(operation, "operation"))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function identity(record: { readonly id: string | null; readonly name: string; readonly owner: FeatureManifest["owner"] }, category?: SemanticSelectorCategory): IdentityProjection {
  return { id: requiredSemanticId(record), displayName: semanticDisplayName(record, category) };
}

function isFeature(value: SemanticSelectorRecord): value is FeatureManifest {
  return "exports" in value;
}

function isModel(value: SemanticSelectorRecord): value is ModelManifest {
  return "fields" in value;
}

function isRoute(value: SemanticSelectorRecord): value is RouteManifest {
  return "method" in value && "path" in value && "input" in value;
}

function isPublicExport(value: SemanticSelectorRecord): value is PublicExportManifest {
  return "kind" in value && !("input" in value) && !("operations" in value) && !("contractId" in value);
}

function narrowResult<T extends SemanticSelectorRecord>(
  result: SemanticSelectorResult,
  isValue: (value: SemanticSelectorRecord) => value is T,
): SemanticSelectorResult<T> {
  if (result.status !== "resolved") return result;
  if (!isValue(result.value)) throw new Error(`Selector ${result.selector} resolved to the wrong semantic category`);
  return { ...result, value: result.value };
}

export function inspectManifest(manifest: ArchitectureManifest): ApplicationInspector {
  const selectorResolver = createSemanticSelectorResolver(manifest);
  const featuresByName = new Map(manifest.features.map((feature) => [feature.name, feature]));
  const exportOwners = new Map<string, FeatureManifest>();
  for (const feature of manifest.features) {
    for (const entry of feature.exports) exportOwners.set(requiredSemanticId(entry), feature);
  }

  function featureReferences(names: readonly string[]): NamedIdentityProjection[] {
    return uniqueSorted(names).map((name) => {
      const feature = featuresByName.get(name);
      if (feature === undefined) throw new Error(`Manifest dependency references unknown feature ${name}`);
      return namedIdentity(feature, "feature");
    });
  }

  function callersFor(symbol: PublicExportManifest): CallerProjection[] {
    const ownerFeature = exportOwners.get(requiredSemanticId(symbol));
    if (ownerFeature === undefined) return [];
    const owner = ownerFeature.name;
    return manifest.dependencies
      .filter((dependency) => dependency.to === owner
        && (dependency.symbols.includes(symbol.name) || dependency.symbols.includes("*")))
      .flatMap((dependency) => {
        const caller = featuresByName.get(dependency.from);
        return caller === undefined ? [] : [{
          ...identity(caller, "feature"),
          feature: caller.name,
          featureId: requiredSemanticId(caller),
          featureDisplayName: caller.name,
          owner,
          ownerId: requiredSemanticId(ownerFeature),
          ownerDisplayName: ownerFeature.name,
          symbol: symbol.name,
          symbolId: requiredSemanticId(symbol),
          symbolDisplayName: semanticDisplayName(symbol, "public-export"),
        }];
      })
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  }

  const inspector: ApplicationInspector = {
    manifest,
    resolve: (selector, categories) => selectorResolver.resolve(selector, categories),
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
      .map((model) => ({ ...identity(model, "model"), model: model.name, feature: model.feature }))
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    boundaries: () => manifest.features.map((feature) => ({
      ...identity(feature, "feature"),
      feature: feature.name,
      path: feature.publicBoundary,
      exports: feature.exports.map((entry) => ({ ...identity(entry, "public-export"), name: entry.name, kind: entry.kind })),
    })),
    exceptions: () => manifest.exceptions,
    findOwner: (selector) => narrowResult(selectorResolver.resolve(selector, ["model"]), isModel),
    findCallers(selector) {
      const result = narrowResult(selectorResolver.resolve(selector, ["public-export"]), isPublicExport);
      return result.status === "resolved"
        ? { ...result, value: callersFor(result.value) }
        : result;
    },
    explainFeature(selector) {
      const result = narrowResult(selectorResolver.resolve(selector, ["feature"]), isFeature);
      if (result.status !== "resolved") return result;
      const feature = result.value;
      const featureName = feature.name;
      const featureRoutes = manifest.routes.filter((entry) => entry.feature === featureName);
      const operationPermissions = manifest.operations
        .filter((entry) => entry.feature === featureName)
        .map((entry) => entry.permission ?? null);
      return {
        ...result,
        value: {
          ...identity(feature, "feature"),
          name: featureName,
          publicBoundary: feature.publicBoundary,
          publicApi: feature.exports.map((entry) => ({ ...identity(entry, "public-export"), name: entry.name, kind: entry.kind })),
          models: manifest.models
            .filter((entry) => entry.feature === featureName)
            .map((entry) => namedIdentity(entry, "model"))
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          actions: operationProjections(manifest, featureName, "action"),
          queries: operationProjections(manifest, featureName, "query"),
          routes: featureRoutes
            .map((entry) => ({ ...namedIdentity(entry, "route"), method: entry.method, path: entry.path }))
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          permissions: uniqueSorted([...operationPermissions, ...featureRoutes.map((entry) => entry.permission ?? null)]),
          events: manifest.events
            .filter((entry) => entry.feature === featureName)
            .map((entry) => namedIdentity(entry, "event"))
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          adapters: manifest.adapters
            .filter((entry) => entry.feature === featureName)
            .map((entry) => namedIdentity(entry))
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
          dependencies: featureReferences(manifest.dependencies.filter((entry) => entry.from === featureName).map((entry) => entry.to)),
          dependents: featureReferences(manifest.dependencies.filter((entry) => entry.to === featureName).map((entry) => entry.from)),
        },
      };
    },
    explainRoute(selector) {
      const result = narrowResult(selectorResolver.resolve(selector, ["route"]), isRoute);
      if (result.status !== "resolved") return result;
      const route = result.value;
      return {
        ...result,
        value: {
          ...identity(route, "route"),
          name: route.name,
          method: route.method,
          path: route.path,
          feature: route.feature,
          ...(route.permission === undefined ? {} : { permission: route.permission }),
        },
      };
    },
    impact(selector) {
      const result = narrowResult(selectorResolver.resolve(selector, ["public-export"]), isPublicExport);
      if (result.status !== "resolved") return result;
      const symbol = result.value;
      const ownerFeature = exportOwners.get(requiredSemanticId(symbol));
      if (ownerFeature === undefined) throw new Error(`Public export ${requiredSemanticId(symbol)} has no feature owner`);
      const callers = callersFor(symbol);
      return {
        ...result,
        value: {
          ...identity(symbol, "public-export"),
          symbol: symbol.name,
          owner: ownerFeature.name,
          ownerId: requiredSemanticId(ownerFeature),
          ownerDisplayName: ownerFeature.name,
          callers: callers.map((entry) => entry.feature),
          callerIds: callers.map((entry) => entry.featureId),
        },
      };
    },
  };
  return inspector;
}

export function inspectApplication(root: string, options: AnalyzeApplicationOptions = {}): ApplicationInspector {
  return inspectManifest(analyzeApplication(root, options));
}

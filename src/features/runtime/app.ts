import type {
  ApplicationEntrypoint,
  ContextFactory,
  FeatureRegistration,
  TestOwnership,
} from "./composition.js";
import type { ExecutionContext } from "./executable.js";

interface ConfiguredAdapter {
  readonly contract: { readonly name: string };
}

type AdapterInstances = Readonly<Record<string, ConfiguredAdapter>>;

export interface ApplicationGraph<TContext extends ExecutionContext = ExecutionContext> {
  readonly features: readonly FeatureRegistration<TContext>[];
  readonly context?: ContextFactory<TContext>;
  readonly entrypoints: Readonly<Partial<Record<"web" | "worker" | "scheduler", ApplicationEntrypoint>>>;
  readonly tests: readonly TestOwnership[];
}

export interface App<
  TAdapters extends AdapterInstances,
  TContext extends ExecutionContext = ExecutionContext,
> {
  readonly adapters: TAdapters;
  readonly graph: ApplicationGraph<TContext>;
  readonly metadata: {
    readonly kind: "app";
    readonly adapters: Readonly<Record<string, string>>;
  };
}

function isAdapterInstances(value: unknown): value is AdapterInstances {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((adapter) => {
    if (typeof adapter !== "object" || adapter === null || !("contract" in adapter)) return false;
    const contract = adapter.contract;
    return typeof contract === "object" && contract !== null && "name" in contract && typeof contract.name === "string";
  });
}

export interface AppConfig<
  TAdapters extends AdapterInstances,
  TContext extends ExecutionContext,
> {
  readonly adapters?: TAdapters;
  readonly features?: readonly FeatureRegistration<TContext>[];
  readonly context?: ContextFactory<TContext>;
  readonly entrypoints?: Readonly<Partial<Record<"web" | "worker" | "scheduler", ApplicationEntrypoint>>>;
  readonly tests?: readonly TestOwnership[];
}

export function defineApp<
  const TAdapters extends AdapterInstances,
  TContext extends ExecutionContext = ExecutionContext,
>(config: AppConfig<TAdapters, TContext>): App<TAdapters, TContext>;
export function defineApp(config?: undefined): App<Record<string, never>>;
export function defineApp(config: unknown = undefined): unknown {
  let adapters: AdapterInstances = {};
  if (typeof config === "object" && config !== null && "adapters" in config && config.adapters !== undefined) {
    if (!isAdapterInstances(config.adapters)) throw new TypeError("App adapters must be configured adapter instances");
    adapters = config.adapters;
  }
  const record = typeof config === "object" && config !== null ? config : undefined;
  const features = record !== undefined && "features" in record && Array.isArray(record.features)
    ? record.features
    : [];
  const tests = record !== undefined && "tests" in record && Array.isArray(record.tests)
    ? record.tests
    : [];
  const entrypoints =
    record !== undefined &&
    "entrypoints" in record &&
    typeof record.entrypoints === "object" &&
    record.entrypoints !== null
      ? record.entrypoints
      : {};
  const context =
    record !== undefined &&
    "context" in record &&
    typeof record.context === "object" &&
    record.context !== null
      ? record.context
      : undefined;

  const names = new Set<string>();
  for (const feature of features) {
    if (typeof feature !== "object" || feature === null || !("name" in feature) || typeof feature.name !== "string") {
      throw new TypeError("App features must be created with defineFeature");
    }
    if (names.has(feature.name)) throw new TypeError(`Duplicate app feature: ${feature.name}`);
    names.add(feature.name);
  }

  const metadataAdapters: Record<string, string> = {};
  for (const [name, adapter] of Object.entries(adapters)) metadataAdapters[name] = adapter.contract.name;
  return Object.freeze({
    adapters,
    graph: Object.freeze({
      features: Object.freeze([...features]),
      ...(context === undefined ? {} : { context }),
      entrypoints: Object.freeze({ ...entrypoints }),
      tests: Object.freeze([...tests]),
    }),
    metadata: Object.freeze({ kind: "app", adapters: Object.freeze(metadataAdapters) }),
  });
}

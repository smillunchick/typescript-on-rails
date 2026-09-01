import type { EventDefinition } from "./event.js";
import type { Executable, ExecutionContext } from "./executable.js";
import type {
  ApplicationEntrypoint,
  ConsumerDefinition,
  ContextFactory,
  FeatureRegistration,
  TestOwnership,
  EntrypointKind,
} from "./composition.js";
import type { RouteDefinition } from "./route.js";
import { runtimeRecordId } from "./runtime-id.js";

interface ConfiguredAdapter {
  readonly contract: { readonly name: string };
}

type AdapterInstances = Readonly<Record<string, ConfiguredAdapter>>;
type EntrypointMap = Readonly<Partial<Record<EntrypointKind, ApplicationEntrypoint>>>;
const ENTRYPOINT_KINDS: readonly EntrypointKind[] = ["web", "worker", "scheduler"];

export interface OwnedRuntimeDefinition<TDefinition extends object> {
  readonly owner: string;
  readonly name: string;
  readonly definition: TDefinition;
}

export type RuntimeLinkKind =
  | "route-operation"
  | "consumer-event"
  | "entrypoint-route"
  | "entrypoint-consumer";

export interface ApplicationRuntimeLink {
  readonly kind: RuntimeLinkKind;
  readonly from: string;
  readonly to: string;
  readonly protocol?: string;
}

export type AnyFeatureRegistration = FeatureRegistration<never>;

export interface ApplicationGraph<TContext extends ExecutionContext = ExecutionContext> {
  readonly features: readonly AnyFeatureRegistration[];
  readonly context?: ContextFactory<TContext>;
  readonly entrypoints: EntrypointMap;
  readonly tests: readonly TestOwnership[];
  readonly operations: readonly OwnedRuntimeDefinition<Executable<unknown, unknown, never>>[];
  readonly routes: readonly OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>[];
  readonly events: readonly OwnedRuntimeDefinition<EventDefinition<unknown>>[];
  readonly consumers: readonly OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>[];
  readonly links: readonly ApplicationRuntimeLink[];
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
  readonly features?: readonly AnyFeatureRegistration[];
  readonly context?: ContextFactory<TContext>;
  readonly entrypoints?: EntrypointMap;
  readonly tests?: readonly TestOwnership[];
}

function compileGraph(
  features: readonly AnyFeatureRegistration[],
  entrypoints: EntrypointMap,
  tests: readonly TestOwnership[],
  context: ContextFactory<ExecutionContext> | undefined,
): ApplicationGraph {
  type Registered =
    | ({ readonly kind: "operation" } & OwnedRuntimeDefinition<Executable<unknown, unknown, never>>)
    | ({ readonly kind: "route" } & OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>)
    | ({ readonly kind: "event" } & OwnedRuntimeDefinition<EventDefinition<unknown>>)
    | ({ readonly kind: "consumer" } & OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>);

  const definitions = new Map<object, Registered>();
  const operations: OwnedRuntimeDefinition<Executable<unknown, unknown, never>>[] = [];
  const routes: OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>[] = [];
  const events: OwnedRuntimeDefinition<EventDefinition<unknown>>[] = [];
  const consumers: OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>[] = [];

  const register = (record: Registered): void => {
    if (definitions.has(record.definition)) throw new TypeError(`DUPLICATE_RUNTIME_DEFINITION:${record.kind}:${record.owner}:${record.name}`);
    definitions.set(record.definition, record);
  };

  for (const feature of features) {
    for (const [name, definition] of Object.entries(feature.operations)) {
      const record = Object.freeze({ owner: feature.name, name, definition });
      operations.push(record);
      register({ kind: "operation", ...record });
    }
    for (const definition of feature.routes) {
      const name = `${definition.metadata.method} ${definition.metadata.path}`;
      const record = Object.freeze({ owner: feature.name, name, definition });
      routes.push(record);
      register({ kind: "route", ...record });
    }
    for (const definition of feature.events) {
      const record = Object.freeze({ owner: feature.name, name: definition.name, definition });
      events.push(record);
      register({ kind: "event", ...record });
    }
    for (const definition of feature.consumers) {
      const record = Object.freeze({ owner: feature.name, name: definition.metadata.name, definition });
      consumers.push(record);
      register({ kind: "consumer", ...record });
    }
  }

  const links: ApplicationRuntimeLink[] = [];
  for (const route of routes) {
    const operation = route.definition.operation;
    if (operation === undefined) continue;
    const target = definitions.get(operation);
    if (target?.kind !== "operation" || target.owner !== route.owner) {
      throw new TypeError(`UNREGISTERED_ROUTE_OPERATION:${route.owner}:${route.name}`);
    }
    links.push({
      kind: "route-operation",
      from: runtimeRecordId("route", route.owner, route.name),
      to: runtimeRecordId("operation", target.owner, target.name),
    });
  }
  for (const consumer of consumers) {
    const target = definitions.get(consumer.definition.event);
    if (target?.kind !== "event") throw new TypeError(`UNREGISTERED_CONSUMER_EVENT:${consumer.owner}:${consumer.name}`);
    links.push({
      kind: "consumer-event",
      from: runtimeRecordId("consumer", consumer.owner, consumer.name),
      to: runtimeRecordId("event", target.owner, target.name),
    });
  }

  for (const process of ENTRYPOINT_KINDS) {
    const entry = entrypoints[process];
    if (entry === undefined) continue;
    if (entry.metadata.process !== process) throw new TypeError(`ENTRYPOINT_PROCESS_MISMATCH:${entry.metadata.name}`);
    for (const binding of entry.bindings) {
      const target = definitions.get(binding.target);
      if (target === undefined) throw new TypeError(`UNREGISTERED_RUNTIME_BINDING_TARGET:${binding.binding.name}`);
      const expected = process === "web" ? "route" : process === "worker" ? "consumer" : undefined;
      if (target.kind !== expected) throw new TypeError(`RUNTIME_BINDING_PROCESS_MISMATCH:${binding.binding.name}`);
      links.push({
        kind: target.kind === "route" ? "entrypoint-route" : "entrypoint-consumer",
        from: runtimeRecordId("entrypoint", "application", entry.metadata.name),
        to: runtimeRecordId(target.kind, target.owner, target.name),
        protocol: binding.binding.protocol,
      });
    }
  }

  links.sort((left, right) => `${left.kind}:${left.from}:${left.to}`.localeCompare(`${right.kind}:${right.from}:${right.to}`));
  return Object.freeze({
    features: Object.freeze([...features]),
    ...(context === undefined ? {} : { context }),
    entrypoints: Object.freeze({ ...entrypoints }),
    tests: Object.freeze([...tests]),
    operations: Object.freeze(operations),
    routes: Object.freeze(routes),
    events: Object.freeze(events),
    consumers: Object.freeze(consumers),
    links: Object.freeze(links.map((link) => Object.freeze(link))),
  });
}

export function defineApp<
  const TAdapters extends AdapterInstances,
  TContext extends ExecutionContext = ExecutionContext,
>(config: AppConfig<TAdapters, TContext>): App<TAdapters, TContext>;
export function defineApp(config?: undefined): App<Record<string, never>>;
export function defineApp(
  config: AppConfig<AdapterInstances, ExecutionContext> | undefined = undefined,
): App<AdapterInstances, ExecutionContext> {
  const adapters = config?.adapters ?? {};
  if (!isAdapterInstances(adapters)) throw new TypeError("App adapters must be configured adapter instances");
  const features = config?.features ?? [];
  const tests = config?.tests ?? [];
  const entrypoints = config?.entrypoints ?? {};
  const context = config?.context;

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
    graph: compileGraph(features, entrypoints, tests, context),
    metadata: Object.freeze({ kind: "app" as const, adapters: Object.freeze(metadataAdapters) }),
  });
}

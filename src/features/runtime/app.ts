import { isAdapterInstance, type AnyAdapterContract, type AnyAdapterInstance } from "./adapter.js";
import type { EventDefinition } from "./event.js";
import type { Executable, ExecutionContext } from "./executable.js";
import type {
  ApplicationEntrypoint,
  AnyModel,
  ConsumerDefinition,
  ContextFactory,
  FeatureRegistration,
  ScheduleDefinition,
  TestOwnership,
  EntrypointKind,
} from "./composition.js";
import type { RouteDefinition } from "./route.js";
import type {
  AnyRepositoryDefinition,
  RegisteredRelationException,
} from "./repository.js";
import { runtimeRecordId } from "./runtime-id.js";

type AdapterInstances = Readonly<Record<string, AnyAdapterInstance>>;
type EntrypointMap = Readonly<Partial<Record<EntrypointKind, ApplicationEntrypoint>>>;
const ENTRYPOINT_KINDS: readonly EntrypointKind[] = ["web", "worker", "scheduler"];
export const APPLICATION_GRAPH_PROTOCOL_VERSION = 2 as const;

export interface OwnedRuntimeDefinition<TDefinition extends object> {
  readonly owner: string;
  readonly name: string;
  readonly definition: TDefinition;
}

export type RuntimeLinkKind =
  | "route-operation"
  | "consumer-event"
  | "feature-adapter"
  | "repository-access"
  | "repository-relation"
  | "relation-exception"
  | "schedule-consumer"
  | "entrypoint-route"
  | "entrypoint-schedule"
  | "entrypoint-consumer";

export interface ApplicationRuntimeLink {
  readonly kind: RuntimeLinkKind;
  readonly from: string;
  readonly to: string;
  readonly protocol?: string;
}

export type AnyFeatureRegistration = FeatureRegistration<never>;

export interface RegisteredTestOwnership {
  readonly kind: "feature" | "application";
  readonly name: string;
  readonly features: readonly string[];
  readonly files: readonly string[];
}

export interface RegisteredRelation {
  readonly relation: string;
  readonly owner: string;
  readonly repository: string;
  readonly exclusive: true;
}

export interface ApplicationGraph<TContext extends ExecutionContext = ExecutionContext> {
  readonly features: readonly AnyFeatureRegistration[];
  readonly context?: ContextFactory<TContext>;
  readonly entrypoints: EntrypointMap;
  readonly tests: readonly RegisteredTestOwnership[];
  readonly models: readonly OwnedRuntimeDefinition<AnyModel>[];
  readonly operations: readonly OwnedRuntimeDefinition<Executable<unknown, unknown, never>>[];
  readonly routes: readonly OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>[];
  readonly events: readonly OwnedRuntimeDefinition<EventDefinition<unknown>>[];
  readonly consumers: readonly OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>[];
  readonly adapterRequirements: readonly OwnedRuntimeDefinition<AnyAdapterContract>[];
  readonly adapters: readonly OwnedRuntimeDefinition<AnyAdapterInstance>[];
  readonly repositories: readonly OwnedRuntimeDefinition<AnyRepositoryDefinition>[];
  readonly relations: readonly RegisteredRelation[];
  readonly relationExceptions: readonly RegisteredRelationException[];
  readonly schedules: readonly OwnedRuntimeDefinition<ScheduleDefinition>[];
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
    readonly graphProtocolVersion: typeof APPLICATION_GRAPH_PROTOCOL_VERSION;
    readonly adapters: Readonly<Record<string, string>>;
  };
}

function configuredAdapters(value: unknown): AdapterInstances {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("App adapters must be configured adapter instances");
  const output: Record<string, AnyAdapterInstance> = {};
  const contracts = new Set<object>();
  const names = new Map<string, string>();
  for (const [key, adapter] of Object.entries(value)) {
    if (!isAdapterInstance(adapter)) throw new TypeError(`ADAPTER_INSTANCE_INVALID:${key}`);
    const priorKey = names.get(adapter.contract.name);
    if (contracts.has(adapter.contract) || priorKey !== undefined) {
      throw new TypeError(`DUPLICATE_ADAPTER_CONTRACT:${adapter.contract.name}:${priorKey ?? key}:${key}`);
    }
    contracts.add(adapter.contract);
    names.set(adapter.contract.name, key);
    output[key] = adapter;
  }
  return Object.freeze(output);
}

function adapterPolicy(
  features: readonly AnyFeatureRegistration[],
  adapters: AdapterInstances,
): ReadonlyMap<AnyAdapterContract, AnyAdapterInstance> {
  const byContract = new Map<AnyAdapterContract, AnyAdapterInstance>();
  const byName = new Map<string, { readonly key: string; readonly instance: AnyAdapterInstance }>();
  for (const [key, instance] of Object.entries(adapters)) {
    byContract.set(instance.contract, instance);
    byName.set(instance.contract.name, { key, instance });
  }
  const used = new Set<AnyAdapterInstance>();
  for (const feature of features) {
    for (const contract of feature.adapters) {
      const exact = byContract.get(contract);
      if (exact !== undefined) {
        used.add(exact);
        continue;
      }
      const sameName = byName.get(contract.name);
      if (sameName !== undefined) {
        throw new TypeError(`ADAPTER_CONTRACT_IDENTITY_MISMATCH:${feature.name}:${contract.name}:${sameName.key}`);
      }
      throw new TypeError(`ADAPTER_CONTRACT_NOT_REGISTERED:${feature.name}:${contract.name}`);
    }
  }
  for (const [key, instance] of Object.entries(adapters)) {
    if (!used.has(instance)) throw new TypeError(`UNUSED_ADAPTER:${key}:${instance.contract.name}`);
  }
  return byContract;
}

function normalizedTestPath(file: string): string {
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) throw new TypeError(`INVALID_TEST_PATH:${file}`);
  const output: string[] = [];
  for (const segment of file.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new TypeError(`INVALID_TEST_PATH:${file}`);
    output.push(segment);
  }
  if (output.length === 0) throw new TypeError(`INVALID_TEST_PATH:${file}`);
  return output.join("/");
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
  adaptersByContract: ReadonlyMap<AnyAdapterContract, AnyAdapterInstance>,
  entrypoints: EntrypointMap,
  tests: readonly TestOwnership[],
  context: ContextFactory<ExecutionContext> | undefined,
): ApplicationGraph {
  type Registered =
    | ({ readonly kind: "model" } & OwnedRuntimeDefinition<AnyModel>)
    | ({ readonly kind: "operation" } & OwnedRuntimeDefinition<Executable<unknown, unknown, never>>)
    | ({ readonly kind: "route" } & OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>)
    | ({ readonly kind: "event" } & OwnedRuntimeDefinition<EventDefinition<unknown>>)
    | ({ readonly kind: "consumer" } & OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>)
    | ({ readonly kind: "adapter" } & OwnedRuntimeDefinition<AnyAdapterInstance>)
    | ({ readonly kind: "repository" } & OwnedRuntimeDefinition<AnyRepositoryDefinition>)
    | ({ readonly kind: "schedule" } & OwnedRuntimeDefinition<ScheduleDefinition>);

  const definitions = new Map<object, Registered>();
  const semanticIds = new Map<string, { readonly kind: string; readonly owner: string; readonly name: string }>();
  const routeEndpoints = new Map<string, { readonly owner: string; readonly name: string }>();
  const models: OwnedRuntimeDefinition<AnyModel>[] = [];
  const operations: OwnedRuntimeDefinition<Executable<unknown, unknown, never>>[] = [];
  const routes: OwnedRuntimeDefinition<RouteDefinition<unknown, unknown, never>>[] = [];
  const events: OwnedRuntimeDefinition<EventDefinition<unknown>>[] = [];
  const consumers: OwnedRuntimeDefinition<ConsumerDefinition<unknown, unknown>>[] = [];
  const adapterRequirements: OwnedRuntimeDefinition<AnyAdapterContract>[] = [];
  const adapters: OwnedRuntimeDefinition<AnyAdapterInstance>[] = [];
  const repositories: OwnedRuntimeDefinition<AnyRepositoryDefinition>[] = [];
  const relations: RegisteredRelation[] = [];
  const relationExceptions: RegisteredRelationException[] = [];
  const schedules: OwnedRuntimeDefinition<ScheduleDefinition>[] = [];
  const relationOwners = new Map<string, { readonly feature: string; readonly repository: string }>();

  const registerSemantic = (kind: Parameters<typeof runtimeRecordId>[0], owner: string, name: string): void => {
    const id = runtimeRecordId(kind, owner, name);
    const prior = semanticIds.get(id);
    if (prior !== undefined) throw new TypeError(`DUPLICATE_RUNTIME_SEMANTIC_ID:${id}:${prior.owner}.${prior.name}:${owner}.${name}`);
    semanticIds.set(id, { kind, owner, name });
  };
  const register = (record: Registered): void => {
    if (definitions.has(record.definition)) throw new TypeError(`DUPLICATE_RUNTIME_DEFINITION:${record.kind}:${record.owner}:${record.name}`);
    registerSemantic(record.kind, record.owner, record.name);
    definitions.set(record.definition, record);
  };

  for (const instance of [...new Set(adaptersByContract.values())].sort((left, right) => left.contract.name.localeCompare(right.contract.name))) {
    const record = Object.freeze({ owner: "application", name: instance.contract.name, definition: instance });
    adapters.push(record);
    register({ kind: "adapter", ...record });
  }

  for (const feature of features) {
    registerSemantic("feature", feature.name, feature.name);
    for (const definition of feature.models) {
      const record = Object.freeze({ owner: feature.name, name: definition.name, definition });
      models.push(record);
      register({ kind: "model", ...record });
    }
    for (const [name, definition] of Object.entries(feature.operations)) {
      const record = Object.freeze({ owner: feature.name, name, definition });
      operations.push(record);
      register({ kind: "operation", ...record });
    }
    for (const definition of feature.routes) {
      const name = `${definition.metadata.method} ${definition.metadata.path}`;
      const priorEndpoint = routeEndpoints.get(name);
      if (priorEndpoint !== undefined) throw new TypeError(`DUPLICATE_ROUTE_ENDPOINT:${name}:${priorEndpoint.owner}:${feature.name}`);
      const record = Object.freeze({ owner: feature.name, name, definition });
      routes.push(record);
      register({ kind: "route", ...record });
      routeEndpoints.set(name, { owner: feature.name, name });
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
    for (const definition of feature.adapters) {
      const record = Object.freeze({ owner: feature.name, name: definition.name, definition });
      adapterRequirements.push(record);
      registerSemantic("adapter", record.owner, record.name);
    }
    for (const definition of feature.repositories) {
      const record = Object.freeze({ owner: feature.name, name: definition.name, definition });
      repositories.push(record);
      register({ kind: "repository", ...record });
      for (const relation of definition.relations) {
        const prior = relationOwners.get(relation);
        if (prior !== undefined && prior.feature !== feature.name) {
          throw new TypeError(`CONFLICTING_RELATION_OWNER:${relation}:${prior.feature}:${feature.name}`);
        }
        if (prior !== undefined && prior.repository !== definition.name) {
          throw new TypeError(`CONFLICTING_RELATION_REPOSITORY:${relation}:${prior.repository}:${definition.name}`);
        }
        relationOwners.set(relation, { feature: feature.name, repository: definition.name });
      }
    }
    for (const definition of feature.schedules) {
      const record = Object.freeze({ owner: feature.name, name: definition.metadata.name, definition });
      schedules.push(record);
      register({ kind: "schedule", ...record });
    }
  }

  const testClaims = new Map<string, string>();
  const testOwners = new Map<string, { readonly kind: "feature" | "application"; readonly name: string; readonly features: Set<string>; readonly files: Set<string> }>();
  const claimTest = (kind: "feature" | "application", name: string, coveredFeatures: readonly string[], inputFile: string): void => {
    const file = normalizedTestPath(inputFile);
    const owner = kind === "feature" ? name : `application:${name}`;
    const priorOwner = testClaims.get(file);
    if (priorOwner !== undefined && priorOwner !== owner) throw new TypeError(`DUPLICATE_TEST_OWNERSHIP:${file}:${priorOwner}:${owner}`);
    if (priorOwner === undefined) {
      registerSemantic("test", owner, file);
      testClaims.set(file, owner);
    }
    const registration = testOwners.get(owner) ?? { kind, name, features: new Set<string>(), files: new Set<string>() };
    for (const feature of coveredFeatures) registration.features.add(feature);
    registration.files.add(file);
    testOwners.set(owner, registration);
  };
  for (const feature of features) for (const file of feature.tests) claimTest("feature", feature.name, [feature.name], file);
  const featureNames = new Set(features.map(({ name }) => name));
  for (const test of tests) {
    if ("feature" in test) {
      if (!featureNames.has(test.feature)) throw new TypeError(`UNKNOWN_TEST_FEATURE:${test.feature}`);
      for (const file of test.files) claimTest("feature", test.feature, [test.feature], file);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(test.suite)) throw new TypeError(`INVALID_TEST_SUITE:${test.suite}`);
    const coveredFeatures = [...new Set(test.features)].sort();
    for (const feature of coveredFeatures) if (!featureNames.has(feature)) throw new TypeError(`UNKNOWN_TEST_FEATURE:${feature}`);
    for (const file of test.files) claimTest("application", test.suite, coveredFeatures, file);
  }
  const registeredTests: RegisteredTestOwnership[] = [...testOwners.values()]
    .map(({ kind, name, features: coveredFeatures, files }) => Object.freeze({
      kind,
      name,
      features: Object.freeze([...coveredFeatures].sort()),
      files: Object.freeze([...files].sort()),
    }))
    .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));

  for (const [relation, owner] of [...relationOwners].sort(([left], [right]) => left.localeCompare(right))) {
    registerSemantic("relation", owner.feature, relation);
    relations.push(Object.freeze({ relation, owner: owner.feature, repository: owner.repository, exclusive: true as const }));
  }

  const links: ApplicationRuntimeLink[] = [];
  for (const repository of repositories) {
    for (const relation of repository.definition.relations) {
      links.push({
        kind: "repository-relation",
        from: runtimeRecordId("repository", repository.owner, repository.name),
        to: runtimeRecordId("relation", repository.owner, relation),
      });
    }
  }
  for (const feature of features) {
    for (const access of feature.repositoryAccess) {
      const target = definitions.get(access);
      if (target?.kind !== "repository") throw new TypeError(`UNREGISTERED_REPOSITORY_ACCESS:${feature.name}:${access.name}`);
      links.push({
        kind: "repository-access",
        from: runtimeRecordId("feature", feature.name, feature.name),
        to: runtimeRecordId("repository", target.owner, target.name),
      });
    }
    for (const exception of feature.relationExceptions) {
      const owner = relationOwners.get(exception.relation);
      if (owner === undefined) throw new TypeError(`UNKNOWN_EXCEPTION_RELATION:${feature.name}:${exception.relation}`);
      if (owner.feature === feature.name) throw new TypeError(`REDUNDANT_RELATION_EXCEPTION:${feature.name}:${exception.relation}`);
      relationExceptions.push(Object.freeze({ ...exception, owner: owner.feature }));
      links.push({
        kind: "relation-exception",
        from: runtimeRecordId("feature", feature.name, feature.name),
        to: runtimeRecordId("relation", owner.feature, exception.relation),
      });
    }
  }
  relationExceptions.sort((left, right) => `${left.feature}:${left.relation}`.localeCompare(`${right.feature}:${right.relation}`));
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
  for (const scheduled of schedules) {
    const target = definitions.get(scheduled.definition.target);
    if (target?.kind !== "consumer") throw new TypeError(`UNREGISTERED_SCHEDULE_TARGET:${scheduled.owner}:${scheduled.name}`);
    if (target.owner !== scheduled.owner) throw new TypeError(`CROSS_OWNER_SCHEDULE_TARGET:${scheduled.owner}:${scheduled.name}:${target.owner}`);
    const eventTarget = definitions.get(scheduled.definition.target.event);
    if (eventTarget?.kind !== "event" || eventTarget.owner !== scheduled.owner) {
      throw new TypeError(`CROSS_OWNER_SCHEDULE_EVENT:${scheduled.owner}:${scheduled.name}:${eventTarget?.owner ?? "unregistered"}`);
    }
    links.push({
      kind: "schedule-consumer",
      from: runtimeRecordId("schedule", scheduled.owner, scheduled.name),
      to: runtimeRecordId("consumer", target.owner, target.name),
      protocol: "jobs.schedule/v1",
    });
  }
  for (const requirement of adapterRequirements) {
    const instance = adaptersByContract.get(requirement.definition);
    if (instance === undefined) throw new TypeError(`ADAPTER_CONTRACT_NOT_REGISTERED:${requirement.owner}:${requirement.name}`);
    links.push({
      kind: "feature-adapter",
      from: runtimeRecordId("adapter", requirement.owner, requirement.name),
      to: runtimeRecordId("adapter", "application", instance.contract.name),
    });
  }

  for (const process of ENTRYPOINT_KINDS) {
    const entry = entrypoints[process];
    if (entry === undefined) continue;
    if (entry.metadata.process !== process) throw new TypeError(`ENTRYPOINT_PROCESS_MISMATCH:${entry.metadata.name}`);
    registerSemantic("entrypoint", "application", entry.metadata.name);
    for (const binding of entry.bindings) {
      const target = definitions.get(binding.target);
      if (target === undefined) throw new TypeError(`UNREGISTERED_RUNTIME_BINDING_TARGET:${binding.binding.name}`);
      const expected = process === "web" ? "route" : process === "worker" ? "consumer" : "schedule";
      if (target.kind !== expected) throw new TypeError(`RUNTIME_BINDING_PROCESS_MISMATCH:${binding.binding.name}`);
      links.push({
        kind: target.kind === "route" ? "entrypoint-route" : target.kind === "consumer" ? "entrypoint-consumer" : "entrypoint-schedule",
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
    tests: Object.freeze(registeredTests),
    models: Object.freeze(models),
    operations: Object.freeze(operations),
    routes: Object.freeze(routes),
    events: Object.freeze(events),
    consumers: Object.freeze(consumers),
    adapterRequirements: Object.freeze(adapterRequirements),
    adapters: Object.freeze(adapters),
    repositories: Object.freeze(repositories),
    relations: Object.freeze(relations),
    relationExceptions: Object.freeze(relationExceptions),
    schedules: Object.freeze(schedules),
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
  const adapters = configuredAdapters(config?.adapters ?? {});
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

  const adaptersByContract = adapterPolicy(features, adapters);
  const metadataAdapters: Record<string, string> = {};
  for (const [name, adapter] of Object.entries(adapters)) metadataAdapters[name] = adapter.contract.name;
  return Object.freeze({
    adapters,
    graph: compileGraph(features, adaptersByContract, entrypoints, tests, context),
    metadata: Object.freeze({ kind: "app" as const, graphProtocolVersion: APPLICATION_GRAPH_PROTOCOL_VERSION, adapters: Object.freeze(metadataAdapters) }),
  });
}

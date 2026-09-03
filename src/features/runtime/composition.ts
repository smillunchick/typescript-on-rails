import { isAdapterContract, type AnyAdapterContract } from "./adapter.js";
import type { EventDefinition } from "./event.js";
import type { Executable, ExecutionContext } from "./executable.js";
import type { Model } from "./model.js";
import {
  isRepositoryDefinition,
  normalizeRelationException,
  type AnyRepositoryDefinition,
  type RelationException,
  type RelationExceptionInput,
} from "./repository.js";
import type { SchemaFields } from "./schema.js";
import type { RouteDefinition } from "./route.js";

type MaybePromise<T> = T | Promise<T>;

export type EntrypointKind = "web" | "worker" | "scheduler";

const RUNTIME_BINDING = "typescript-on-rails.runtime-binding/v1" as const;

export interface RuntimeBinding<TTarget extends object = object> {
  readonly runtimeBinding: typeof RUNTIME_BINDING;
  readonly binding: {
    readonly kind: "runtime-binding";
    readonly name: string;
    readonly protocol: string;
    readonly process: EntrypointKind;
  };
  readonly target: TTarget;
}

export function runtimeBinding<TTarget extends object>(definition: {
  readonly name: string;
  readonly protocol: string;
  readonly process: EntrypointKind;
  readonly target: TTarget;
}): RuntimeBinding<TTarget> {
  if (!definition.name || !definition.protocol) throw new TypeError("A runtime binding needs a name and protocol");
  return Object.freeze({
    runtimeBinding: RUNTIME_BINDING,
    binding: Object.freeze({
      kind: "runtime-binding" as const,
      name: definition.name,
      protocol: definition.protocol,
      process: definition.process,
    }),
    target: definition.target,
  });
}

export function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  return typeof value === "object" && value !== null && "runtimeBinding" in value && value.runtimeBinding === RUNTIME_BINDING;
}

export interface PageDefinition {
  readonly metadata: {
    readonly kind: "page";
    readonly name: string;
    readonly path: string;
    readonly runtime: "server" | "client" | "hybrid";
    readonly permission?: string;
  };
}

export function page(definition: Omit<PageDefinition["metadata"], "kind">): PageDefinition {
  if (!definition.name || !definition.path.startsWith("/")) {
    throw new TypeError("A page needs a name and an absolute path");
  }
  return Object.freeze({ metadata: Object.freeze({ kind: "page", ...definition }) });
}

export interface ConsumerDefinition<TPayload = unknown, TContext = undefined> {
  readonly event: EventDefinition<TPayload>;
  readonly metadata: {
    readonly kind: "consumer";
    readonly name: string;
    readonly event: string;
    readonly durable: boolean;
  };
  handle(payload: TPayload, context: TContext): MaybePromise<void>;
}

export function consumer<TPayload, TContext = undefined>(definition: {
  readonly name: string;
  readonly event: EventDefinition<TPayload>;
  readonly durable?: boolean;
  readonly handle: (payload: TPayload, context: TContext) => MaybePromise<void>;
}): ConsumerDefinition<TPayload, TContext> {
  return Object.freeze({
    event: definition.event,
    metadata: Object.freeze({
      kind: "consumer",
      name: definition.name,
      event: definition.event.name,
      durable: definition.durable ?? false,
    }),
    handle: definition.handle,
  });
}

export const SCHEDULE_PROTOCOL_MARKER = "typescript-on-rails.schedule" as const;
export const SCHEDULE_PROTOCOL_VERSION = 1 as const;

export interface ScheduledOccurrence<TPayload> {
  readonly occurrence: string;
  readonly payload: TPayload;
  readonly dueAt?: Date;
}

export interface ScheduleDefinition<TPayload = unknown, TContext = unknown> {
  readonly [SCHEDULE_PROTOCOL_MARKER]: typeof SCHEDULE_PROTOCOL_VERSION;
  readonly feature: string;
  readonly target: ConsumerDefinition<TPayload, TContext>;
  readonly metadata: {
    readonly kind: "schedule";
    readonly name: string;
    readonly feature: string;
    readonly target: string;
    readonly event: string;
    readonly version: number;
  };
  occurrences(now: Date): readonly ScheduledOccurrence<TPayload>[];
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return typeof value === "object" && value !== null && SCHEDULE_PROTOCOL_MARKER in value && value[SCHEDULE_PROTOCOL_MARKER] === SCHEDULE_PROTOCOL_VERSION;
}

export function schedule<TPayload, TContext = undefined>(definition: {
  readonly name: string;
  readonly feature: string;
  readonly target: ConsumerDefinition<TPayload, TContext>;
  readonly occurrences: (now: Date) => readonly ScheduledOccurrence<TPayload>[];
}): ScheduleDefinition<TPayload, TContext> {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new TypeError(`INVALID_SCHEDULE_NAME:${definition.name}`);
  if (!/^[a-z][a-z0-9-]*$/.test(definition.feature) || definition.feature === "application") throw new TypeError(`INVALID_SCHEDULE_FEATURE:${definition.feature}`);
  if (definition.target.metadata.durable !== true) throw new TypeError(`SCHEDULE_TARGET_NOT_DURABLE:${definition.feature}:${definition.name}`);
  if (definition.target.event.owner !== undefined && definition.target.event.owner !== definition.feature) {
    throw new TypeError(`SCHEDULE_EVENT_OWNER_CONFLICT:${definition.feature}:${definition.name}:${definition.target.event.owner}`);
  }
  if (typeof definition.occurrences !== "function") throw new TypeError(`SCHEDULE_OCCURRENCES_INVALID:${definition.feature}:${definition.name}`);
  return Object.freeze({
    [SCHEDULE_PROTOCOL_MARKER]: SCHEDULE_PROTOCOL_VERSION,
    feature: definition.feature,
    target: definition.target,
    metadata: Object.freeze({
      kind: "schedule" as const,
      name: definition.name,
      feature: definition.feature,
      target: definition.target.metadata.name,
      event: definition.target.event.name,
      version: definition.target.event.version,
    }),
    occurrences: definition.occurrences,
  });
}

export interface ApplicationEntrypoint {
  readonly metadata: {
    readonly kind: "entrypoint";
    readonly name: string;
    readonly process: EntrypointKind;
  };
  readonly bindings: readonly RuntimeBinding[];
  run(signal: AbortSignal): MaybePromise<void>;
}

export function entrypoint(definition: {
  readonly name: string;
  readonly process: EntrypointKind;
  readonly bindings?: readonly RuntimeBinding[];
  readonly run: (signal: AbortSignal) => MaybePromise<void>;
}): ApplicationEntrypoint {
  if (!definition.name) throw new TypeError("An entrypoint needs a name");
  const bindings = [...(definition.bindings ?? [])];
  for (const binding of bindings) {
    if (!isRuntimeBinding(binding) || binding.binding.process !== definition.process) {
      throw new TypeError(`Invalid ${definition.process} runtime binding`);
    }
  }
  return Object.freeze({
    metadata: Object.freeze({ kind: "entrypoint" as const, name: definition.name, process: definition.process }),
    bindings: Object.freeze(bindings),
    run: definition.run,
  });
}

export interface FeatureTestOwnership {
  readonly feature: string;
  readonly files: readonly string[];
}

export interface ApplicationTestSuite {
  readonly suite: string;
  readonly features: readonly string[];
  readonly files: readonly string[];
}

export type TestOwnership = FeatureTestOwnership | ApplicationTestSuite;
export type AnyModel = Model<SchemaFields>;

export interface FeatureRegistration<TContext extends ExecutionContext = ExecutionContext> {
  readonly name: string;
  readonly models: readonly AnyModel[];
  readonly operations: Readonly<Record<string, Executable<unknown, unknown, TContext>>>;
  readonly routes: readonly RouteDefinition<unknown, unknown, TContext>[];
  readonly pages: readonly PageDefinition[];
  readonly permissions: readonly string[];
  readonly events: readonly EventDefinition<unknown>[];
  readonly consumers: readonly ConsumerDefinition<unknown, unknown>[];
  readonly adapters: readonly AnyAdapterContract[];
  readonly repositories: readonly AnyRepositoryDefinition[];
  readonly repositoryAccess: readonly AnyRepositoryDefinition[];
  readonly relationExceptions: readonly RelationException[];
  readonly schedules: readonly ScheduleDefinition[];
  readonly tests: readonly string[];
}

export function defineFeature<TContext extends ExecutionContext = ExecutionContext>(definition: {
  readonly name: string;
  readonly models?: readonly AnyModel[];
  readonly operations?: Readonly<Record<string, Executable<unknown, unknown, TContext>>>;
  readonly routes?: readonly RouteDefinition<unknown, unknown, TContext>[];
  readonly pages?: readonly PageDefinition[];
  readonly permissions?: readonly string[];
  readonly events?: readonly EventDefinition<unknown>[];
  readonly consumers?: readonly ConsumerDefinition<unknown, unknown>[];
  readonly adapters?: readonly AnyAdapterContract[];
  readonly repositories?: readonly AnyRepositoryDefinition[];
  readonly repositoryAccess?: readonly AnyRepositoryDefinition[];
  readonly relationExceptions?: readonly RelationExceptionInput[];
  readonly schedules?: readonly ScheduleDefinition[];
  readonly tests?: readonly string[];
}): FeatureRegistration<TContext> {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new TypeError("Feature names must be kebab-case");
  if (definition.name === "application") throw new TypeError("RESERVED_FEATURE_NAME:application");
  const permissions = [...new Set(definition.permissions ?? [])].sort();
  const events = [...(definition.events ?? [])];
  for (const eventDefinition of events) {
    if (eventDefinition.owner !== undefined && eventDefinition.owner !== definition.name) {
      throw new TypeError(`EVENT_OWNER_CONFLICT:${eventDefinition.name}:${eventDefinition.owner}:${definition.name}`);
    }
  }
  const adapters = [...(definition.adapters ?? [])];
  const adapterNames = new Set<string>();
  const adapterDefinitions = new Set<object>();
  for (const [index, adapter] of adapters.entries()) {
    if (!isAdapterContract(adapter)) throw new TypeError(`ADAPTER_REQUIREMENT_INVALID:${definition.name}:${String(index)}`);
    if (adapterDefinitions.has(adapter) || adapterNames.has(adapter.name)) {
      throw new TypeError(`DUPLICATE_ADAPTER_REQUIREMENT:${definition.name}:${adapter.name}`);
    }
    adapterDefinitions.add(adapter);
    adapterNames.add(adapter.name);
  }
  const repositories = [...(definition.repositories ?? [])];
  const repositoryNames = new Set<string>();
  const repositoryDefinitions = new Set<object>();
  const ownedRelations = new Set<string>();
  for (const [index, repository] of repositories.entries()) {
    if (!isRepositoryDefinition(repository)) throw new TypeError(`REPOSITORY_DEFINITION_INVALID:${definition.name}:${String(index)}`);
    if (repository.feature !== definition.name) throw new TypeError(`REPOSITORY_FEATURE_CONFLICT:${repository.name}:${repository.feature}:${definition.name}`);
    if (repositoryDefinitions.has(repository) || repositoryNames.has(repository.name)) throw new TypeError(`DUPLICATE_REPOSITORY:${definition.name}:${repository.name}`);
    repositoryDefinitions.add(repository);
    repositoryNames.add(repository.name);
    for (const relation of repository.relations) ownedRelations.add(relation);
  }
  repositories.sort((left, right) => left.name.localeCompare(right.name));
  const repositoryAccess = [...(definition.repositoryAccess ?? [])];
  const accessNames = new Set<string>();
  for (const [index, repository] of repositoryAccess.entries()) {
    if (!isRepositoryDefinition(repository)) throw new TypeError(`REPOSITORY_ACCESS_INVALID:${definition.name}:${String(index)}`);
    if (repository.feature === definition.name) throw new TypeError(`SELF_REPOSITORY_ACCESS:${definition.name}:${repository.name}`);
    const key = `${repository.feature}:${repository.name}`;
    if (accessNames.has(key)) throw new TypeError(`DUPLICATE_REPOSITORY_ACCESS:${definition.name}:${repository.feature}.${repository.name}`);
    accessNames.add(key);
  }
  repositoryAccess.sort((left, right) => `${left.feature}:${left.name}`.localeCompare(`${right.feature}:${right.name}`));
  const relationExceptions = (definition.relationExceptions ?? []).map((input) => normalizeRelationException(definition.name, input));
  const exceptionRelations = new Set<string>();
  for (const exception of relationExceptions) {
    if (exceptionRelations.has(exception.relation)) throw new TypeError(`DUPLICATE_RELATION_EXCEPTION:${definition.name}:${exception.relation}`);
    if (ownedRelations.has(exception.relation)) throw new TypeError(`RELATION_EXCEPTION_ON_OWNED_RELATION:${definition.name}:${exception.relation}`);
    exceptionRelations.add(exception.relation);
  }
  relationExceptions.sort((left, right) => left.relation.localeCompare(right.relation));
  const schedules = [...(definition.schedules ?? [])];
  const scheduleNames = new Set<string>();
  const scheduleDefinitions = new Set<object>();
  for (const [index, scheduled] of schedules.entries()) {
    if (!isScheduleDefinition(scheduled)) throw new TypeError(`SCHEDULE_DEFINITION_INVALID:${definition.name}:${String(index)}`);
    if (scheduled.feature !== definition.name) throw new TypeError(`SCHEDULE_FEATURE_CONFLICT:${scheduled.metadata.name}:${scheduled.feature}:${definition.name}`);
    if (scheduleDefinitions.has(scheduled) || scheduleNames.has(scheduled.metadata.name)) throw new TypeError(`DUPLICATE_SCHEDULE:${definition.name}:${scheduled.metadata.name}`);
    scheduleDefinitions.add(scheduled);
    scheduleNames.add(scheduled.metadata.name);
  }
  schedules.sort((left, right) => left.metadata.name < right.metadata.name ? -1 : left.metadata.name > right.metadata.name ? 1 : 0);
  return Object.freeze({
    name: definition.name,
    models: Object.freeze([...(definition.models ?? [])]),
    operations: Object.freeze({ ...(definition.operations ?? {}) }),
    routes: Object.freeze([...(definition.routes ?? [])]),
    pages: Object.freeze([...(definition.pages ?? [])]),
    permissions: Object.freeze(permissions),
    events: Object.freeze(events),
    consumers: Object.freeze([...(definition.consumers ?? [])]),
    adapters: Object.freeze(adapters),
    repositories: Object.freeze(repositories),
    repositoryAccess: Object.freeze(repositoryAccess),
    relationExceptions: Object.freeze(relationExceptions),
    schedules: Object.freeze(schedules),
    tests: Object.freeze([...(definition.tests ?? [])].sort()),
  });
}

export interface ContextFactory<TContext extends ExecutionContext> {
  create(input: unknown): MaybePromise<TContext>;
}

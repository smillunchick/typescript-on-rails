import type { AdapterInstance, AdapterOperations } from "./adapter.js";
import type { EventDefinition } from "./event.js";
import type { Executable, ExecutionContext } from "./executable.js";
import type { RouteDefinition } from "./route.js";

type MaybePromise<T> = T | Promise<T>;

export type EntrypointKind = "web" | "worker" | "scheduler";

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

export interface ConsumerDefinition<TPayload = unknown> {
  readonly event: EventDefinition<TPayload>;
  readonly metadata: {
    readonly kind: "consumer";
    readonly name: string;
    readonly event: string;
    readonly durable: boolean;
  };
  handle(payload: TPayload): MaybePromise<void>;
}

export function consumer<TPayload>(definition: {
  readonly name: string;
  readonly event: EventDefinition<TPayload>;
  readonly durable?: boolean;
  readonly handle: (payload: TPayload) => MaybePromise<void>;
}): ConsumerDefinition<TPayload> {
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

export interface ApplicationEntrypoint {
  readonly metadata: {
    readonly kind: "entrypoint";
    readonly name: string;
    readonly process: EntrypointKind;
  };
  run(signal: AbortSignal): MaybePromise<void>;
}

export function entrypoint(definition: {
  readonly name: string;
  readonly process: EntrypointKind;
  readonly run: (signal: AbortSignal) => MaybePromise<void>;
}): ApplicationEntrypoint {
  return Object.freeze({
    metadata: Object.freeze({ kind: "entrypoint", name: definition.name, process: definition.process }),
    run: definition.run,
  });
}

export interface TestOwnership {
  readonly feature: string;
  readonly files: readonly string[];
}

export interface FeatureRegistration<TContext extends ExecutionContext = ExecutionContext> {
  readonly name: string;
  readonly operations: Readonly<Record<string, Executable<unknown, unknown, TContext>>>;
  readonly routes: readonly RouteDefinition<unknown, unknown, TContext>[];
  readonly pages: readonly PageDefinition[];
  readonly permissions: readonly string[];
  readonly events: readonly EventDefinition<unknown>[];
  readonly consumers: readonly ConsumerDefinition<unknown>[];
  readonly adapters: readonly AdapterInstance<AdapterOperations>[];
  readonly tests: readonly string[];
}

export function defineFeature<TContext extends ExecutionContext = ExecutionContext>(definition: {
  readonly name: string;
  readonly operations?: Readonly<Record<string, Executable<unknown, unknown, TContext>>>;
  readonly routes?: readonly RouteDefinition<unknown, unknown, TContext>[];
  readonly pages?: readonly PageDefinition[];
  readonly permissions?: readonly string[];
  readonly events?: readonly EventDefinition<unknown>[];
  readonly consumers?: readonly ConsumerDefinition<unknown>[];
  readonly adapters?: readonly AdapterInstance<AdapterOperations>[];
  readonly tests?: readonly string[];
}): FeatureRegistration<TContext> {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new TypeError("Feature names must be kebab-case");
  const permissions = [...new Set(definition.permissions ?? [])].sort();
  return Object.freeze({
    name: definition.name,
    operations: Object.freeze({ ...(definition.operations ?? {}) }),
    routes: Object.freeze([...(definition.routes ?? [])]),
    pages: Object.freeze([...(definition.pages ?? [])]),
    permissions: Object.freeze(permissions),
    events: Object.freeze([...(definition.events ?? [])]),
    consumers: Object.freeze([...(definition.consumers ?? [])]),
    adapters: Object.freeze([...(definition.adapters ?? [])]),
    tests: Object.freeze([...(definition.tests ?? [])].sort()),
  });
}

export interface ContextFactory<TContext extends ExecutionContext> {
  create(input: unknown): MaybePromise<TContext>;
}

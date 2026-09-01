import type { AdapterInstance, AdapterOperations } from "./adapter.js";
import type { EventDefinition } from "./event.js";
import type { Executable, ExecutionContext } from "./executable.js";
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
  readonly consumers: readonly ConsumerDefinition<unknown, unknown>[];
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
  readonly consumers?: readonly ConsumerDefinition<unknown, unknown>[];
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

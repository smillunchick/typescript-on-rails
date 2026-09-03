import type { Schema, SchemaMetadata } from "./schema.js";
import { normalizeSchema } from "./schema-protocol.js";
import { runtimeRecordId } from "./runtime-id.js";

type MaybePromise<TValue> = TValue | Promise<TValue>;
type EventHandler = (payload: unknown) => Promise<void>;

export interface EventDefinition<TPayload> {
  readonly owner?: string;
  readonly id?: string;
  readonly name: string;
  readonly version: number;
  readonly payload: Schema<TPayload>;
  parse(value: unknown): TPayload;
  readonly metadata: {
    readonly kind: "event";
    readonly name: string;
    readonly payload: SchemaMetadata;
  };
}

export interface OwnedEventDefinition<TPayload> extends EventDefinition<TPayload> {
  readonly owner: string;
  readonly id: string;
}

interface EventInput<TPayload> {
  readonly name: string;
  readonly version?: number;
  readonly payload: Schema<TPayload>;
}

export function event<TPayload>(definition: EventInput<TPayload> & { readonly owner: string }): OwnedEventDefinition<TPayload>;
export function event<TPayload>(definition: EventInput<TPayload>): EventDefinition<TPayload>;
export function event<TPayload>(definition: EventInput<TPayload> & { readonly owner?: string }): EventDefinition<TPayload> {
  const version = definition.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("EVENT_VERSION_MUST_BE_A_POSITIVE_INTEGER");
  if (definition.owner !== undefined && !/^[a-z][a-z0-9-]*$/.test(definition.owner)) {
    throw new TypeError("EVENT_OWNER_MUST_BE_KEBAB_CASE");
  }
  const payload = normalizeSchema(definition.payload);
  return Object.freeze({
    ...(definition.owner === undefined
      ? {}
      : { owner: definition.owner, id: runtimeRecordId("event", definition.owner, definition.name) }),
    name: definition.name,
    version,
    payload,
    parse: (value: unknown) => payload.parse(value),
    metadata: Object.freeze({ kind: "event" as const, name: definition.name, payload: payload.metadata }),
  });
}

export interface EventBus {
  on<TPayload>(
    eventDefinition: EventDefinition<TPayload>,
    handler: (payload: TPayload) => MaybePromise<void>,
  ): () => void;
  emit<TPayload>(eventDefinition: EventDefinition<TPayload>, payload: TPayload): Promise<void>;
}

export function createEventBus(): EventBus {
  const subscriptions = new Map<object, Set<EventHandler>>();

  return {
    on(eventDefinition, handler) {
      const wrapped: EventHandler = async (payload) => {
        await handler(eventDefinition.payload.parse(payload));
      };
      const handlers = subscriptions.get(eventDefinition) ?? new Set<EventHandler>();
      handlers.add(wrapped);
      subscriptions.set(eventDefinition, handlers);
      return () => {
        handlers.delete(wrapped);
        if (handlers.size === 0) subscriptions.delete(eventDefinition);
      };
    },
    async emit(eventDefinition, payload) {
      const parsed = eventDefinition.payload.parse(payload);
      const failures: unknown[] = [];
      for (const handler of subscriptions.get(eventDefinition) ?? []) {
        try {
          await handler(parsed);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Event ${eventDefinition.name} delivery failed`);
      }
    },
  };
}

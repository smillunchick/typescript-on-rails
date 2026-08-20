import type { Schema, SchemaMetadata } from "./schema.js";
import { normalizeSchema } from "./schema-protocol.js";

type MaybePromise<TValue> = TValue | Promise<TValue>;
type EventHandler = (payload: unknown) => Promise<void>;

export interface EventDefinition<TPayload> {
  readonly name: string;
  readonly payload: Schema<TPayload>;
  readonly metadata: {
    readonly kind: "event";
    readonly name: string;
    readonly payload: SchemaMetadata;
  };
}

export function event<TPayload>(definition: {
  readonly name: string;
  readonly payload: Schema<TPayload>;
}): EventDefinition<TPayload> {
  const payload = normalizeSchema(definition.payload);
  return {
    name: definition.name,
    payload,
    metadata: { kind: "event", name: definition.name, payload: payload.metadata },
  };
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

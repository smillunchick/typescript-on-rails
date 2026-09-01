import {
  runtimeBinding,
  type ConsumerDefinition,
  type FeatureRegistration,
  type RuntimeBinding,
} from "typescript-on-rails";

import type { JobHandler, JobStore, OutboxRecord } from "./jobs.js";
import type { OutboxPublisher } from "./runtime.js";

export interface ConsumerRuntime {
  readonly bindings: readonly RuntimeBinding<ConsumerDefinition<unknown, unknown>>[];
  readonly handlers: Readonly<Record<string, JobHandler>>;
  publisher(store: JobStore): OutboxPublisher;
}

interface RegisteredConsumer {
  readonly feature: string;
  readonly job: string;
  readonly consumer: ConsumerDefinition<unknown, unknown>;
}

export interface ConsumerRuntimeOptions {
  readonly context?: (registration: { readonly feature: string; readonly name: string }) => unknown;
}

export function createConsumerRuntime(
  features: readonly FeatureRegistration[],
  options: ConsumerRuntimeOptions = {},
): ConsumerRuntime {
  const registered: RegisteredConsumer[] = [];
  for (const feature of features) {
    for (const consumer of feature.consumers) {
      if (!consumer.metadata.durable) continue;
      registered.push({ feature: feature.name, job: `${feature.name}.${consumer.metadata.name}`, consumer });
    }
  }
  registered.sort((left, right) => left.job.localeCompare(right.job));
  const names = new Set<string>();
  const byEvent = new Map<string, RegisteredConsumer[]>();
  const handlers: Record<string, JobHandler> = {};
  const bindings: RuntimeBinding<ConsumerDefinition<unknown, unknown>>[] = [];
  for (const item of registered) {
    if (names.has(item.job)) throw new TypeError(`DUPLICATE_CONSUMER_JOB:${item.job}`);
    names.add(item.job);
    const eventConsumers = byEvent.get(item.consumer.event.name) ?? [];
    eventConsumers.push(item);
    byEvent.set(item.consumer.event.name, eventConsumers);
    handlers[item.job] = async (payload) => {
      await item.consumer.handle(
        item.consumer.event.parse(payload),
        options.context?.({ feature: item.feature, name: item.consumer.metadata.name }),
      );
    };
    bindings.push(runtimeBinding({
      name: item.job,
      protocol: "jobs.consumer/v1",
      process: "worker",
      target: item.consumer,
    }));
  }
  return Object.freeze({
    bindings: Object.freeze(bindings),
    handlers: Object.freeze(handlers),
    publisher(store: JobStore): OutboxPublisher {
      return Object.freeze({
        async publish(record: OutboxRecord) {
          const eventConsumers = byEvent.get(record.event);
          if (eventConsumers === undefined || eventConsumers.length === 0) throw new Error(`OUTBOX_CONSUMER_NOT_REGISTERED:${record.event}`);
          for (const item of eventConsumers) {
            await store.enqueue({
              name: item.job,
              payload: record.payload,
              idempotencyKey: `${record.idempotencyKey}:${item.job}`,
            });
          }
        },
      });
    },
  });
}

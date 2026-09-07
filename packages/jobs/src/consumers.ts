import {
  runtimeBinding,
  runtimeRecordId,
  type ConsumerDefinition,
  type FeatureRegistration,
  type RuntimeBinding,
} from "typescript-on-rails";

import type {
  DurableEnvelope,
  JobHandler,
  JobHandlerContext,
  OutboxFanoutTarget,
  OutboxRecord,
} from "./jobs.js";
import type { OutboxPublisher } from "./runtime.js";
import { samePersistedJson } from "./identity.js";

export interface DurableConsumerContext<TApplication> {
  readonly application: TApplication;
  readonly job: JobHandlerContext;
}

export type DurableAuthorityEnvelope = Omit<DurableEnvelope, "payload">;
export interface DurableContextInput {
  readonly envelope: DurableAuthorityEnvelope;
  readonly attempt: number;
}

export interface DurableUpcaster {
  readonly event: { readonly id: string };
  readonly from: number;
  readonly to: number;
  upcast(value: unknown): unknown;
}

export interface ConsumerRuntime {
  readonly bindings: readonly RuntimeBinding<ConsumerDefinition<unknown, unknown>>[];
  readonly handlers: Readonly<Record<string, JobHandler>>;
  publisher(): OutboxPublisher;
}

interface RegisteredConsumer {
  readonly feature: string;
  readonly job: string;
  readonly consumerId: string;
  readonly eventId: string;
  readonly consumer: ConsumerDefinition<unknown, unknown>;
}

export interface ConsumerRuntimeOptions<TApplication = unknown> {
  readonly context?: (input: DurableContextInput, registration: { readonly feature: string; readonly name: string; readonly consumerId: string }) => Promise<TApplication> | TApplication;
  readonly authorize?: (input: DurableContextInput, registration: { readonly feature: string; readonly name: string; readonly consumerId: string }) => Promise<void> | void;
  readonly upcasters?: readonly DurableUpcaster[];
}

function permanent(code: string, cause?: unknown): Error {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code, permanent: true });
}

function authorityEnvelope(envelope: DurableEnvelope): DurableAuthorityEnvelope {
  const {
    occurrenceId,
    eventId,
    eventName,
    schemaVersion,
    occurredAt,
    requestId,
    correlationId,
    tenantId,
    actorId,
    causationId,
  } = envelope;
  return Object.freeze({
    occurrenceId,
    eventId,
    eventName,
    schemaVersion,
    occurredAt: new Date(occurredAt.getTime()),
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(actorId === undefined ? {} : { actorId }),
    requestId,
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
  });
}

function handlerPayload(value: unknown): { readonly envelope: DurableEnvelope; readonly payload: unknown; readonly payloadVersion: unknown } {
  if (typeof value !== "object" || value === null || !("envelope" in value)) {
    throw permanent("DURABLE_HANDLER_PAYLOAD_INVALID");
  }
  const raw = value.envelope;
  if (typeof raw !== "object" || raw === null) throw permanent("DURABLE_HANDLER_PAYLOAD_INVALID");
  const requiredText = (key: "correlationId" | "eventId" | "eventName" | "occurrenceId" | "requestId"): string => {
    const field = Reflect.get(raw, key);
    if (typeof field !== "string" || field.length === 0) throw permanent("DURABLE_HANDLER_PAYLOAD_INVALID");
    return field;
  };
  const optionalText = (key: "actorId" | "causationId" | "tenantId"): string | undefined => {
    const field = Reflect.get(raw, key);
    if (field !== undefined && typeof field !== "string") throw permanent("DURABLE_HANDLER_PAYLOAD_INVALID");
    return field;
  };
  const rawOccurredAt = Reflect.get(raw, "occurredAt");
  const rawSchemaVersion = Reflect.get(raw, "schemaVersion");
  const occurredAt = rawOccurredAt instanceof Date ? new Date(rawOccurredAt.getTime()) : new Date(String(rawOccurredAt));
  if (Number.isNaN(occurredAt.getTime()) || !Number.isSafeInteger(rawSchemaVersion) || Number(rawSchemaVersion) < 1) {
    throw permanent("DURABLE_HANDLER_PAYLOAD_INVALID");
  }
  const tenantId = optionalText("tenantId");
  const actorId = optionalText("actorId");
  const causationId = optionalText("causationId");
  const envelope: DurableEnvelope = Object.freeze({
    occurrenceId: requiredText("occurrenceId"),
    eventId: requiredText("eventId"),
    eventName: requiredText("eventName"),
    schemaVersion: Number(rawSchemaVersion),
    payload: Reflect.get(raw, "payload"),
    occurredAt,
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(actorId === undefined ? {} : { actorId }),
    requestId: requiredText("requestId"),
    correlationId: requiredText("correlationId"),
    ...(causationId === undefined ? {} : { causationId }),
  });
  return Object.freeze({ envelope, payload: Reflect.get(value, "payload"), payloadVersion: Reflect.get(value, "payloadVersion") });
}

export function createConsumerRuntime<TApplication = unknown>(
  features: readonly FeatureRegistration[],
  options: ConsumerRuntimeOptions<TApplication> = {},
): ConsumerRuntime {
  const eventOwners = new Map<object, string>();
  for (const feature of features) {
    for (const eventDefinition of feature.events) {
      const existing = eventOwners.get(eventDefinition);
      if (existing !== undefined && existing !== feature.name) {
        throw new TypeError(`EVENT_OWNER_CONFLICT:${eventDefinition.name}:${existing}:${feature.name}`);
      }
      if (eventDefinition.owner !== undefined && eventDefinition.owner !== feature.name) {
        throw new TypeError(`EVENT_OWNER_CONFLICT:${eventDefinition.name}:${eventDefinition.owner}:${feature.name}`);
      }
      eventOwners.set(eventDefinition, feature.name);
    }
  }
  const registered: RegisteredConsumer[] = [];
  for (const feature of features) {
    for (const consumer of feature.consumers) {
      if (!consumer.metadata.durable) continue;
      const eventOwner = eventOwners.get(consumer.event);
      if (eventOwner === undefined) throw new TypeError(`UNREGISTERED_CONSUMER_EVENT:${feature.name}:${consumer.metadata.name}`);
      const eventId = runtimeRecordId("event", eventOwner, consumer.event.name);
      const job = `${feature.name}.${consumer.metadata.name}`;
      if (job.length > 200) throw new TypeError(`DURABLE_CONSUMER_JOB_NAME_INVALID:${job}`);
      registered.push({
        feature: feature.name,
        job,
        consumerId: runtimeRecordId("consumer", feature.name, consumer.metadata.name),
        eventId,
        consumer,
      });
    }
  }
  registered.sort((left, right) => left.job.localeCompare(right.job));

  const upcasters = new Map<string, Map<number, DurableUpcaster | null>>();
  for (const item of options.upcasters ?? []) {
    if (!Number.isSafeInteger(item.from) || item.from < 1 || item.to !== item.from + 1) {
      throw new TypeError(`UPCASTER_MUST_BE_ADJACENT:${item.event.id}:${item.from}:${item.to}`);
    }
    const eventUpcasters = upcasters.get(item.event.id) ?? new Map<number, DurableUpcaster | null>();
    eventUpcasters.set(item.from, eventUpcasters.has(item.from) ? null : item);
    upcasters.set(item.event.id, eventUpcasters);
  }

  function currentPayload(item: RegisteredConsumer, value: unknown, from: number): unknown {
    if (!Number.isSafeInteger(from) || from < 1) throw permanent("EVENT_PAYLOAD_VERSION_INVALID");
    if (from > item.consumer.event.version) throw permanent("EVENT_VERSION_FROM_FUTURE");
    let payload: unknown;
    try {
      payload = structuredClone(value);
    } catch (error) {
      throw permanent("EVENT_PAYLOAD_NOT_CLONEABLE", error);
    }
    for (let version = from; version < item.consumer.event.version; version += 1) {
      const upcaster = upcasters.get(item.eventId)?.get(version);
      if (upcaster === undefined) throw permanent("EVENT_UPCASTER_MISSING");
      if (upcaster === null) throw permanent("EVENT_UPCASTER_AMBIGUOUS");
      try {
        payload = upcaster.upcast(payload);
      } catch (error) {
        throw permanent("EVENT_UPCAST_FAILED", error);
      }
    }
    try {
      return item.consumer.event.parse(payload);
    } catch (error) {
      throw permanent("EVENT_PAYLOAD_INVALID", error);
    }
  }

  const jobs = new Set<string>();
  const targets = new Set<string>();
  const byEvent = new Map<string, RegisteredConsumer[]>();
  const handlers: Record<string, JobHandler> = {};
  const bindings: RuntimeBinding<ConsumerDefinition<unknown, unknown>>[] = [];
  for (const item of registered) {
    if (jobs.has(item.job)) throw new TypeError(`DUPLICATE_CONSUMER_JOB:${item.job}`);
    jobs.add(item.job);
    const targetKey = `${item.eventId}\u0000${item.consumerId}\u0000${item.consumer.event.version}`;
    if (targets.has(targetKey)) throw new TypeError(`DUPLICATE_CONSUMER_TARGET:${item.consumerId}:${item.consumer.event.version}`);
    targets.add(targetKey);
    const eventConsumers = byEvent.get(item.eventId) ?? [];
    eventConsumers.push(item);
    byEvent.set(item.eventId, eventConsumers);
    handlers[item.job] = async (value, job) => {
      const durable = handlerPayload(value);
      const delivery = job.delivery;
      if (durable.envelope.eventId !== item.eventId || durable.envelope.eventName !== item.consumer.event.name) {
        throw permanent("DURABLE_EVENT_IDENTITY_MISMATCH");
      }
      if (delivery?.name !== item.job || (delivery.consumerId !== undefined && delivery.consumerId !== item.consumerId)) {
        throw permanent("DURABLE_CONSUMER_IDENTITY_MISMATCH");
      }
      let payloadVersion = delivery.payloadVersion;
      if (delivery.outboxId !== undefined) {
        if (delivery.consumerId !== item.consumerId || delivery.outboxId !== durable.envelope.occurrenceId || delivery.scheduleId !== undefined) {
          throw permanent("DURABLE_CONSUMER_IDENTITY_MISMATCH");
        }
      } else if (delivery.scheduleId !== undefined) {
        // Old schedules stored both copies at envelope.schemaVersion, with identity
        // established by the persisted schedule link and exact claimed job name.
        if (!samePersistedJson(durable.payload, durable.envelope.payload)) {
          throw permanent("EVENT_PAYLOAD_VERSION_INVALID");
        }
        payloadVersion = durable.envelope.schemaVersion;
      } else {
        throw permanent("EVENT_PAYLOAD_VERSION_INVALID");
      }
      if (payloadVersion === undefined || payloadVersion < durable.envelope.schemaVersion ||
          (durable.payloadVersion !== undefined && durable.payloadVersion !== payloadVersion)) throw permanent("EVENT_PAYLOAD_VERSION_INVALID");
      const payload = currentPayload(item, durable.payload, payloadVersion);
      const input = Object.freeze({ envelope: authorityEnvelope(durable.envelope), attempt: job.attempt });
      const registration = Object.freeze({ feature: item.feature, name: item.consumer.metadata.name, consumerId: item.consumerId });
      await options.authorize?.(input, registration);
      const application = await options.context?.(input, registration) as TApplication;
      const context: DurableConsumerContext<TApplication> = Object.freeze({ application, job });
      await item.consumer.handle(payload, context);
    };
    bindings.push(runtimeBinding({ name: item.job, protocol: "jobs.consumer/v1", process: "worker", target: item.consumer }));
  }

  return Object.freeze({
    bindings: Object.freeze(bindings),
    handlers: Object.freeze(handlers),
    publisher(): OutboxPublisher {
      return Object.freeze({
        async targets(record: OutboxRecord): Promise<readonly OutboxFanoutTarget[]> {
          const eventConsumers = byEvent.get(record.eventId);
          if (eventConsumers === undefined || eventConsumers.length === 0) throw permanent("EVENT_NOT_REGISTERED");
          const result: OutboxFanoutTarget[] = [];
          for (const item of eventConsumers) {
            const targetVersion = item.consumer.event.version;
            try {
              if (record.eventName !== item.consumer.event.name) throw permanent("DURABLE_EVENT_IDENTITY_MISMATCH");
              const payload = currentPayload(item, record.payload, record.schemaVersion);
              const envelope: DurableEnvelope = Object.freeze({
                ...authorityEnvelope(record),
                payload: record.payload,
              });
              result.push(Object.freeze({
                kind: "job" as const,
                consumerId: item.consumerId,
                consumerVersion: targetVersion,
                jobName: item.job,
                payload: Object.freeze({ envelope, payload }),
              }));
            } catch (error) {
              if (!(typeof error === "object" && error !== null && "permanent" in error && error.permanent === true && "code" in error && typeof error.code === "string")) throw error;
              result.push(Object.freeze({
                kind: "failed" as const,
                consumerId: item.consumerId,
                consumerVersion: targetVersion,
                errorCode: error.code,
                permanent: true,
              }));
            }
          }
          return Object.freeze(result);
        },
      });
    },
  });
}

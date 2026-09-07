import { createHash } from "node:crypto";

import { parseRuntimeRecordId } from "typescript-on-rails";

import type {
  AppendOutboxOptions,
  DurableEvent,
  EnqueueJob,
  LegacyReconciliationCandidate,
  ReplayOutboxRequest,
  ScheduleOccurrence,
} from "./jobs.js";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function persistedJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw Object.assign(new TypeError("IDEMPOTENCY_VALUE_NOT_JSON"), { code: "IDEMPOTENCY_VALUE_NOT_JSON" });
  return JSON.parse(serialized) as JsonValue;
}

function freezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}

export function samePersistedJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return canonical(persistedJson(left)) === canonical(persistedJson(right));
}

export function immutablePersistedJson(value: unknown): unknown {
  return freezeJson(persistedJson(value));
}

export function copiedDate(value: Date): Date {
  return new Date(value.getTime());
}

export function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return "UNEXPECTED";
  const code = error.code.trim().slice(0, 100);
  return code === "" ? "UNEXPECTED" : code;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(persistedJson(value))).digest("hex");
}

function jobIdentity(input: EnqueueJob): Readonly<Record<string, unknown>> {
  validateEnqueueJob(input);
  return {
    name: input.name,
    payload: persistedJson(input.payload),
    maximumAttempts: input.maximumAttempts ?? 5,
    availableAt: input.availableAt?.toISOString() ?? null,
    replayGeneration: input.replayGeneration ?? 0,
  };
}

function boundedId(value: string, label: string, maximumLength: number): void {
  if (value.trim().length === 0 || value.length > maximumLength) {
    throw Object.assign(new TypeError(`${label}_INVALID`), { code: `${label}_INVALID` });
  }
}

function validDate(value: Date, code: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw Object.assign(new TypeError(code), { code });
  }
}

function validateDurableEvent(event: DurableEvent<unknown>): void {
  boundedId(event.id, "DURABLE_EVENT_ID", Number.MAX_SAFE_INTEGER);
  boundedId(event.name, "DURABLE_EVENT_NAME", 200);
  let identity: ReturnType<typeof parseRuntimeRecordId>;
  try {
    identity = parseRuntimeRecordId(event.id);
  } catch (error) {
    throw Object.assign(new TypeError("DURABLE_EVENT_ID_INVALID", { cause: error }), { code: "DURABLE_EVENT_ID_INVALID" });
  }
  if (identity.kind !== "event" || identity.name !== event.name) {
    throw Object.assign(new TypeError("DURABLE_EVENT_ID_MISMATCH"), { code: "DURABLE_EVENT_ID_MISMATCH" });
  }
  if (!Number.isSafeInteger(event.version) || event.version < 1) {
    throw Object.assign(new TypeError("DURABLE_EVENT_VERSION_INVALID"), { code: "DURABLE_EVENT_VERSION_INVALID" });
  }
}

function validateEnqueueJob(input: EnqueueJob): void {
  boundedId(input.name, "JOB_NAME", 200);
  boundedId(input.idempotencyKey, "JOB_IDEMPOTENCY_KEY", 300);
  if (input.maximumAttempts !== undefined && (!Number.isSafeInteger(input.maximumAttempts) || input.maximumAttempts < 1)) {
    throw Object.assign(new TypeError("JOB_MAXIMUM_ATTEMPTS_INVALID"), { code: "JOB_MAXIMUM_ATTEMPTS_INVALID" });
  }
  if (input.availableAt !== undefined) validDate(input.availableAt, "JOB_AVAILABLE_AT_INVALID");
  if (input.outboxId !== undefined) boundedId(input.outboxId, "JOB_OUTBOX_ID", 80);
  if (input.consumerId !== undefined) boundedId(input.consumerId, "JOB_CONSUMER_ID", Number.MAX_SAFE_INTEGER);
  if (input.replayGeneration !== undefined && (!Number.isSafeInteger(input.replayGeneration) || input.replayGeneration < 0)) {
    throw Object.assign(new TypeError("JOB_REPLAY_GENERATION_INVALID"), { code: "JOB_REPLAY_GENERATION_INVALID" });
  }
}

export function validateAppendOutboxOptions(options: AppendOutboxOptions): void {
  boundedId(options.idempotencyKey, "OUTBOX_IDEMPOTENCY_KEY", 300);
  boundedId(options.requestId, "OUTBOX_REQUEST_ID", 200);
  boundedId(options.correlationId, "OUTBOX_CORRELATION_ID", 200);
  if (options.tenantId !== undefined) boundedId(options.tenantId, "OUTBOX_TENANT_ID", 200);
  if (options.actorId !== undefined) boundedId(options.actorId, "OUTBOX_ACTOR_ID", 200);
  if (options.causationId !== undefined) boundedId(options.causationId, "OUTBOX_CAUSATION_ID", 200);
  if (options.occurredAt !== undefined) validDate(options.occurredAt, "OUTBOX_OCCURRED_AT_INVALID");
  if (options.maximumAttempts !== undefined && (!Number.isSafeInteger(options.maximumAttempts) || options.maximumAttempts < 1)) throw Object.assign(new TypeError("OUTBOX_MAXIMUM_ATTEMPTS_INVALID"), { code: "OUTBOX_MAXIMUM_ATTEMPTS_INVALID" });
}

export function validateReplayOutboxRequest(request: ReplayOutboxRequest): void {
  boundedId(request.requestId, "REPLAY_REQUEST_ID", 200);
  boundedId(request.approvedBy, "REPLAY_APPROVER", 200);
  boundedId(request.reason, "REPLAY_REASON", 300);
  validDate(request.requestedAt, "REPLAY_REQUESTED_AT_INVALID");
}

export function jobRequestDigest(input: EnqueueJob): string {
  return digest(jobIdentity(input));
}

export function durableIdentityHash(value: string): string {
  boundedId(value, "DURABLE_IDENTITY", Number.MAX_SAFE_INTEGER);
  return digest(value);
}

export function outboxDeliveryIdempotencyKey(occurrenceId: string, consumerId: string, replayGeneration = 0): string {
  boundedId(occurrenceId, "OUTBOX_OCCURRENCE_ID", 80);
  boundedId(consumerId, "OUTBOX_CONSUMER_ID", Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(replayGeneration) || replayGeneration < 0) {
    throw Object.assign(new TypeError("OUTBOX_REPLAY_GENERATION_INVALID"), { code: "OUTBOX_REPLAY_GENERATION_INVALID" });
  }
  return `outbox:${digest({ occurrenceId, consumerId, replayGeneration })}`;
}

export function outboxRequestDigest<T>(event: DurableEvent<T>, payload: T, options: AppendOutboxOptions): string {
  validateDurableEvent(event);
  validateAppendOutboxOptions(options);
  return digest({
    eventId: event.id,
    eventName: event.name,
    schemaVersion: event.version,
    payload: persistedJson(payload),
    occurredAt: options.occurredAt?.toISOString() ?? null,
    tenantId: options.tenantId ?? null,
    actorId: options.actorId ?? null,
    requestId: options.requestId,
    correlationId: options.correlationId,
    causationId: options.causationId ?? null,
    maximumAttempts: options.maximumAttempts ?? 5,
  });
}

export function legacyReconciliationGraph(candidates: readonly LegacyReconciliationCandidate[]): {
  readonly byName: ReadonlyMap<string, ReadonlySet<string>>;
  readonly hash: string;
} {
  const byName = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    boundedId(candidate.eventName, "LEGACY_EVENT_NAME", 200);
    boundedId(candidate.eventId, "LEGACY_EVENT_ID", Number.MAX_SAFE_INTEGER);
    const ids = byName.get(candidate.eventName) ?? new Set<string>();
    ids.add(candidate.eventId);
    byName.set(candidate.eventName, ids);
  }
  const canonicalCandidates = [...byName]
    .flatMap(([eventName, ids]) => [...ids].map((eventId) => ({ eventName, eventId })))
    .sort((left, right) => compareText(left.eventName, right.eventName) || compareText(left.eventId, right.eventId));
  return Object.freeze({ byName, hash: digest(canonicalCandidates) });
}

export function scheduleRequestDigest(input: ScheduleOccurrence): string {
  return digest(input.identityPayload === undefined
    ? {
        schedule: input.schedule,
        occurrence: input.occurrence,
        jobIdempotencyKey: input.job.idempotencyKey,
        job: jobIdentity(input.job),
      }
    : {
        schedule: input.schedule,
        occurrence: input.occurrence,
        jobName: input.job.name,
        maximumAttempts: input.job.maximumAttempts ?? 5,
        identityPayload: persistedJson(input.identityPayload),
      });
}

export function idempotencyConflict(code: "JOB_IDEMPOTENCY_CONFLICT" | "OUTBOX_IDEMPOTENCY_CONFLICT" | "SCHEDULE_IDEMPOTENCY_CONFLICT"): Error {
  return Object.assign(new Error(code), { code });
}

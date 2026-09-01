import { createHash } from "node:crypto";

import type { DurableEvent, EnqueueJob, ScheduleOccurrence } from "./jobs.js";

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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(persistedJson(value))).digest("hex");
}

function jobIdentity(input: EnqueueJob): Readonly<Record<string, unknown>> {
  return {
    name: input.name,
    payload: persistedJson(input.payload),
    maximumAttempts: input.maximumAttempts ?? 5,
    availableAt: input.availableAt?.toISOString() ?? null,
  };
}

export function jobRequestDigest(input: EnqueueJob): string {
  return digest(jobIdentity(input));
}

export function outboxRequestDigest<T>(event: DurableEvent<T>, payload: T): string {
  return digest({ event: event.name, version: event.version, payload: persistedJson(payload) });
}

export function scheduleRequestDigest(input: ScheduleOccurrence): string {
  return digest({
    schedule: input.schedule,
    occurrence: input.occurrence,
    jobIdempotencyKey: input.job.idempotencyKey,
    job: jobIdentity(input.job),
  });
}

export function idempotencyConflict(code: "JOB_IDEMPOTENCY_CONFLICT" | "OUTBOX_IDEMPOTENCY_CONFLICT" | "SCHEDULE_IDEMPOTENCY_CONFLICT"): Error {
  return Object.assign(new Error(code), { code });
}

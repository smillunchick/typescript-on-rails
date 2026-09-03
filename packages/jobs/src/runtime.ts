import {
  isScheduleDefinition,
  runtimeBinding,
  runtimeRecordId,
  type RuntimeBinding,
  type ScheduleDefinition as RegisteredScheduleDefinition,
} from "typescript-on-rails";

import { durableIdentityHash, safeErrorCode } from "./identity.js";
import type {
  JobStore,
  OutboxFanoutTarget,
  OutboxRecord,
  ScheduleOccurrence,
} from "./jobs.js";

export interface OutboxPublisher {
  targets(record: OutboxRecord): Promise<readonly OutboxFanoutTarget[]>;
}

export interface OutboxDispatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly partial: number;
  readonly retried: number;
  readonly quarantined: number;
  readonly fenceLost: number;
  readonly cancelled: number;
}

function permanentFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "permanent" in error && error.permanent === true;
}

function backoffDelay(base: number, maximum: number, attempt: number, jitter: () => number): number {
  const exponential = Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
  const rawJitter = jitter();
  const boundedJitter = Number.isFinite(rawJitter) ? Math.max(0, Math.min(1, rawJitter)) : 0;
  return Math.min(maximum, Math.floor(exponential * (1 + boundedJitter)));
}

export async function dispatchOutbox(
  store: JobStore,
  publisher: OutboxPublisher,
  options: {
    readonly limit?: number;
    readonly leaseMilliseconds?: number;
    readonly baseBackoffMilliseconds?: number;
    readonly maximumBackoffMilliseconds?: number;
    readonly now?: () => Date;
    readonly jitter?: () => number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<OutboxDispatchResult> {
  const now = options.now ?? (() => new Date());
  const readNow = (): Date => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("OUTBOX_DISPATCH_TIME_INVALID");
    return new Date(value.getTime());
  };
  const jitter = options.jitter ?? Math.random;
  const limit = options.limit ?? 100;
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  const baseBackoff = options.baseBackoffMilliseconds ?? 1_000;
  const maximumBackoff = options.maximumBackoffMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("OUTBOX_DISPATCH_LIMIT_INVALID");
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1 || leaseMilliseconds > 86_400_000) throw new TypeError("OUTBOX_DISPATCH_LEASE_INVALID");
  if (!Number.isSafeInteger(baseBackoff) || baseBackoff < 1 || !Number.isSafeInteger(maximumBackoff) || maximumBackoff < baseBackoff) {
    throw new TypeError("OUTBOX_DISPATCH_BACKOFF_INVALID");
  }
  const counts = { claimed: 0, published: 0, partial: 0, retried: 0, quarantined: 0, fenceLost: 0, cancelled: 0 };
  for (let index = 0; index < limit; index += 1) {
    if (options.signal?.aborted) {
      counts.cancelled += 1;
      break;
    }
    const record = await store.claimOutbox(readNow(), leaseMilliseconds);
    if (record === undefined) break;
    counts.claimed += 1;
    const leaseToken = record.leaseToken;
    if (leaseToken === undefined) throw new Error(`OUTBOX_CLAIM_WITHOUT_LEASE:${record.id}`);
    if (options.signal?.aborted) {
      const at = readNow();
      const settled = await store.settleOutbox(record.id, leaseToken, { kind: "retry", at, availableAt: at, errorCode: "DISPATCH_CANCELLED" });
      if (settled) counts.cancelled += 1;
      else counts.fenceLost += 1;
      break;
    }
    try {
      const targets = await publisher.targets(record);
      const snapshot = await store.materializeFanout(record, targets);
      if (snapshot.failed > 0 || snapshot.succeeded !== snapshot.total) {
        const at = readNow();
        const permanentReceipt = snapshot.receipts.find(({ state, permanent }) => state === "failed" && permanent);
        if (snapshot.permanentFailed > 0) {
          const settled = await store.settleOutbox(record.id, leaseToken, { kind: "quarantine", at, reason: permanentReceipt?.errorCode ?? "FANOUT_PERMANENT_FAILURE" });
          if (settled) counts.quarantined += 1;
          else counts.fenceLost += 1;
          continue;
        }
        const availableAt = new Date(at.getTime() + backoffDelay(baseBackoff, maximumBackoff, record.attempts, jitter));
        const settled = record.attempts >= record.maximumAttempts
          ? await store.settleOutbox(record.id, leaseToken, { kind: "quarantine", at, reason: "EXHAUSTED" })
          : await store.settleOutbox(record.id, leaseToken, { kind: "partial", at, availableAt, errorCode: "FANOUT_PARTIAL" });
        if (settled && record.attempts >= record.maximumAttempts) counts.quarantined += 1;
        else if (settled) counts.partial += 1;
        else counts.fenceLost += 1;
      } else {
        const settled = await store.settleOutbox(record.id, leaseToken, { kind: "published", at: readNow() });
        if (settled) counts.published += 1;
        else counts.fenceLost += 1;
      }
    } catch (error) {
      const code = safeErrorCode(error);
      if (code === "OUTBOX_FENCE_LOST") {
        counts.fenceLost += 1;
        continue;
      }
      if (permanentFailure(error) || record.attempts >= record.maximumAttempts) {
        const reason = permanentFailure(error) ? code : "EXHAUSTED";
        const settled = await store.settleOutbox(record.id, leaseToken, { kind: "quarantine", at: readNow(), reason });
        if (settled) counts.quarantined += 1;
        else counts.fenceLost += 1;
      } else {
        const delay = backoffDelay(baseBackoff, maximumBackoff, record.attempts, jitter);
        const at = readNow();
        const settled = await store.settleOutbox(record.id, leaseToken, { kind: "retry", at, availableAt: new Date(at.getTime() + delay), errorCode: code });
        if (settled) counts.retried += 1;
        else counts.fenceLost += 1;
      }
    }
  }
  return Object.freeze(counts);
}

export interface ScheduleDefinition { readonly name: string; occurrences(now: Date): readonly ScheduleOccurrence[] }

export function scheduleRuntimeBinding(
  scheduled: RegisteredScheduleDefinition,
): RuntimeBinding<RegisteredScheduleDefinition> {
  return runtimeBinding({
    name: `${scheduled.feature}.${scheduled.metadata.name}`,
    protocol: "jobs.schedule/v1",
    process: "scheduler",
    target: scheduled,
  });
}

function scheduleError(code: string): Error {
  return Object.assign(new TypeError(code), { code });
}

function registeredOccurrence(
  scheduled: RegisteredScheduleDefinition,
  occurrence: ReturnType<RegisteredScheduleDefinition["occurrences"]>[number],
  now: Date,
): ScheduleOccurrence {
  if (occurrence.occurrence.trim() === "" || occurrence.occurrence.length > 100) throw scheduleError("SCHEDULE_OCCURRENCE_INVALID");
  const dueAt = occurrence.dueAt ?? now;
  if (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime())) throw scheduleError("SCHEDULE_DUE_AT_INVALID");
  const payload = scheduled.target.event.parse(occurrence.payload);
  const scheduleId = runtimeRecordId("schedule", scheduled.feature, scheduled.metadata.name);
  const occurrenceHash = durableIdentityHash(`${scheduleId}\u0000${occurrence.occurrence}`);
  const eventId = scheduled.target.event.id ?? runtimeRecordId("event", scheduled.feature, scheduled.target.event.name);
  const requestId = `schedule:${occurrenceHash}`;
  const jobName = `${scheduled.feature}.${scheduled.target.metadata.name}`;
  if (jobName.length > 200) throw scheduleError("SCHEDULE_TARGET_JOB_INVALID");
  return Object.freeze({
    schedule: `schedule:${durableIdentityHash(scheduleId)}`,
    occurrence: occurrence.occurrence,
    identityPayload: { payloadPresent: payload !== undefined, payload: payload ?? null },
    job: Object.freeze({
      name: jobName,
      payload: Object.freeze({
        envelope: Object.freeze({
          occurrenceId: requestId,
          eventId,
          eventName: scheduled.target.event.name,
          schemaVersion: scheduled.target.event.version,
          payload,
          occurredAt: new Date(dueAt),
          requestId,
          correlationId: requestId,
        }),
        payload,
      }),
      idempotencyKey: requestId,
      availableAt: new Date(dueAt),
    }),
  });
}

export interface ScheduleFailure {
  readonly schedule: string;
  readonly occurrence?: string;
  readonly errorCode: string;
}

export interface ScheduleRunResult {
  readonly created: number;
  readonly replayed: number;
  readonly failed: number;
  readonly failureOverflow: number;
  readonly cancelled: boolean;
  readonly failures: readonly ScheduleFailure[];
}

export interface RunSchedulerOptions {
  readonly signal?: AbortSignal;
  readonly maximumOccurrencesPerSchedule?: number;
}

function genericOccurrence(scheduled: ScheduleDefinition, occurrence: ScheduleOccurrence): ScheduleOccurrence {
  if (scheduled.name.trim() === "" || scheduled.name.length > 200 || occurrence.schedule.trim() === "" || occurrence.schedule.length > 200) throw scheduleError("SCHEDULE_NAME_INVALID");
  if (occurrence.occurrence.trim() === "" || occurrence.occurrence.length > 100) throw scheduleError("SCHEDULE_OCCURRENCE_INVALID");
  return occurrence;
}

export async function runScheduler(
  store: JobStore,
  schedules: readonly (ScheduleDefinition | RegisteredScheduleDefinition)[],
  now = new Date(),
  options: RunSchedulerOptions = {},
): Promise<ScheduleRunResult> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("SCHEDULER_TIME_INVALID");
  const maximumOccurrences = options.maximumOccurrencesPerSchedule ?? 10_000;
  if (!Number.isInteger(maximumOccurrences) || maximumOccurrences < 1 || maximumOccurrences > 10_000) throw new TypeError("SCHEDULER_LIMIT_INVALID");
  let created = 0;
  let replayed = 0;
  let failureOverflow = 0;
  const failures: ScheduleFailure[] = [];
  const recordFailure = (failure: ScheduleFailure): void => {
    if (failures.length < 1_000) failures.push(Object.freeze(failure));
    else failureOverflow += 1;
  };
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const cancellationRequested = (): boolean => options.signal?.aborted === true;
  const ordered = [...schedules].sort((left, right) => {
    const leftName = isScheduleDefinition(left) ? `${left.feature}.${left.metadata.name}` : left.name;
    const rightName = isScheduleDefinition(right) ? `${right.feature}.${right.metadata.name}` : right.name;
    return compareText(leftName, rightName);
  });
  let cancelled = cancellationRequested();
  for (const scheduled of ordered) {
    if (cancellationRequested()) {
      cancelled = true;
      break;
    }
    const scheduleName = isScheduleDefinition(scheduled) ? `${scheduled.feature}.${scheduled.metadata.name}` : scheduled.name;
    let occurrences: readonly (ScheduleOccurrence | ReturnType<RegisteredScheduleDefinition["occurrences"]>[number])[];
    try {
      occurrences = scheduled.occurrences(new Date(now));
      if (!Array.isArray(occurrences)) throw scheduleError("SCHEDULE_OCCURRENCES_INVALID");
      if (occurrences.length > maximumOccurrences) throw scheduleError("SCHEDULE_OCCURRENCE_LIMIT_EXCEEDED");
    } catch (error) {
      recordFailure({ schedule: scheduleName, errorCode: safeErrorCode(error) });
      continue;
    }
    for (const occurrence of occurrences) {
      if (cancellationRequested()) {
        cancelled = true;
        break;
      }
      try {
        const materialized = isScheduleDefinition(scheduled)
          ? registeredOccurrence(scheduled, occurrence, now)
          : genericOccurrence(scheduled, occurrence);
        if ((await store.materialize(materialized)).replayed) replayed += 1;
        else created += 1;
      } catch (error) {
        recordFailure({
          schedule: scheduleName,
          ...(typeof occurrence === "object" && occurrence !== null && "occurrence" in occurrence && typeof occurrence.occurrence === "string" ? { occurrence: occurrence.occurrence.slice(0, 100) } : {}),
          errorCode: safeErrorCode(error),
        });
      }
    }
  }
  return Object.freeze({ created, replayed, failed: failures.length + failureOverflow, failureOverflow, cancelled, failures: Object.freeze(failures) });
}

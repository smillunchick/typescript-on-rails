import type { DurableEvent, JobStore, ScheduleOccurrence } from "./jobs.js";

export interface OutboxPublisher { publish(record: { readonly id: string; readonly event: string; readonly version: number; readonly payload: unknown; readonly idempotencyKey: string }): Promise<void> }

export async function dispatchOutbox(
  store: JobStore,
  publisher: OutboxPublisher,
  options: {
    readonly limit?: number;
    readonly leaseMilliseconds?: number;
    readonly now?: () => Date;
  } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  let count = 0;
  for (const record of await store.dueOutbox(
    options.limit ?? 100,
    now(),
    options.leaseMilliseconds ?? 30_000,
  )) {
    const leaseToken = record.leaseToken;
    if (leaseToken === undefined) throw new Error(`OUTBOX_CLAIM_WITHOUT_LEASE:${record.id}`);
    await publisher.publish(record);
    if (!(await store.markPublished(record.id, leaseToken, now()))) {
      throw Object.assign(new Error("OUTBOX_FENCE_LOST"), { code: "OUTBOX_FENCE_LOST" });
    }
    count += 1;
  }
  return count;
}

export interface ScheduleDefinition { readonly name: string; occurrences(now: Date): readonly ScheduleOccurrence[] }
export async function runScheduler(store: JobStore, schedules: readonly ScheduleDefinition[], now = new Date()): Promise<number> {
  let created = 0;
  for (const schedule of [...schedules].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const occurrence of schedule.occurrences(now)) if (!(await store.materialize(occurrence)).replayed) created += 1;
  }
  return created;
}

export async function appendDurableEvent<T>(store: JobStore, event: DurableEvent<T>, payload: T, idempotencyKey: string) {
  return store.appendOutbox(event, payload, idempotencyKey);
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { consumer, defineFeature, event, object, runtimeRecordId, schedule, string, unit } from "typescript-on-rails";

import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  memoryJobStore,
  runScheduler,
  scheduleRuntimeBinding,
  type DurableEvent,
  type JobHandlerContext,
  type JobStore,
} from "../src/index.js";

function testEvent<T>(definition: { readonly owner: string; readonly name: string; readonly version?: number; readonly parse: (value: unknown) => T }): DurableEvent<T> {
  return Object.freeze({ id: runtimeRecordId("event", definition.owner, definition.name), name: definition.name, version: definition.version ?? 1, parse: definition.parse });
}

function outboxOptions(idempotencyKey: string, occurredAt = new Date(0)) {
  return { idempotencyKey, occurredAt, requestId: `request:${idempotencyKey}`, correlationId: `correlation:${idempotencyKey}` };
}

describe("durable work runtime", () => {
  it("keeps the applied jobs migration source unchanged", async () => {
    const source = await readFile(new URL("../src/postgres.ts", import.meta.url), "utf8");
    const start = source.indexOf("export const jobsMigration: Migration = {");
    const end = source.indexOf("\n\nfunction jobStatus", start);
    assert.ok(start >= 0 && end > start);
    assert.equal(createHash("sha256").update(source.slice(start, end)).digest("hex"), "1bb6081ddcc8b51209bfdcc3e4639b49c98544ba7f1c7f932aff2b1831def2d2");
  });
  it("deduplicates jobs, retries with fencing, and exposes dead letters", async () => {
    let now = new Date(0);
    const store = memoryJobStore(() => now);
    const first = await store.enqueue({ name: "send", payload: { id: 1 }, idempotencyKey: "send:1", maximumAttempts: 2 });
    const replay = await store.enqueue({ name: "send", payload: { id: 1 }, idempotencyKey: "send:1", maximumAttempts: 2 });
    assert.equal(first.replayed, false);
    assert.deepEqual(replay, { id: first.id, replayed: true });
    let calls = 0;
    const worker = createWorker({ store, handlers: { send: () => { calls += 1; throw Object.assign(new Error("no"), { code: "PROVIDER_DOWN" }); } }, now: () => now, baseBackoffMilliseconds: 10 });
    assert.equal(await worker.runOnce(new AbortController().signal), "retry");
    assert.equal(await worker.runOnce(new AbortController().signal), "idle");
    now = new Date(10);
    assert.equal(await worker.runOnce(new AbortController().signal), "dead");
    assert.equal(calls, 2);
    assert.equal((await store.deadLetters())[0]?.lastErrorCode, "PROVIDER_DOWN");
  });

  it("rejects idempotency-key reuse for different work", async () => {
    const store = memoryJobStore(() => new Date(0));
    const first = await store.enqueue({
      name: "send",
      payload: { account: "one", nested: { left: true, right: false } },
      idempotencyKey: "send:stable",
      maximumAttempts: 3,
    });
    assert.deepEqual(
      await store.enqueue({
        name: "send",
        payload: { nested: { right: false, left: true }, account: "one" },
        idempotencyKey: "send:stable",
        maximumAttempts: 3,
      }),
      { id: first.id, replayed: true },
    );
    await assert.rejects(
      store.enqueue({ name: "send", payload: { account: "two" }, idempotencyKey: "send:stable", maximumAttempts: 3 }),
      { code: "JOB_IDEMPOTENCY_CONFLICT" },
    );
    const unicode = await store.enqueue({ name: "unicode", payload: { "é": 1, "é": 2 }, idempotencyKey: "unicode:stable" });
    assert.deepEqual(
      await store.enqueue({ name: "unicode", payload: { "é": 2, "é": 1 }, idempotencyKey: "unicode:stable" }),
      { id: unicode.id, replayed: true },
    );
    await assert.rejects(
      store.enqueue({ name: "invalid", payload: undefined, idempotencyKey: "invalid:payload" }),
      { code: "IDEMPOTENCY_VALUE_NOT_JSON" },
    );

    const ProjectCreated = testEvent({ owner: "tests", name: "ProjectCreated", version: 2, parse: (value: unknown) => value });
    const outbox = await store.appendOutbox(ProjectCreated, { project: { id: "one", active: true } }, outboxOptions("event:stable"));
    assert.deepEqual(
      await store.appendOutbox(ProjectCreated, { project: { active: true, id: "one" } }, outboxOptions("event:stable")),
      { id: outbox.id, replayed: true },
    );
    await assert.rejects(
      store.appendOutbox(ProjectCreated, { project: { id: "two", active: true } }, outboxOptions("event:stable")),
      { code: "OUTBOX_IDEMPOTENCY_CONFLICT" },
    );
    const ProjectCreatedV3 = testEvent({ owner: "tests", name: "ProjectCreated", version: 3, parse: (value: unknown) => value });
    await assert.rejects(
      store.appendOutbox(ProjectCreatedV3, { project: { id: "one", active: true } }, outboxOptions("event:stable")),
      { code: "OUTBOX_IDEMPOTENCY_CONFLICT" },
    );

    const occurrence = {
      schedule: "daily",
      occurrence: "2026-01-01",
      job: { name: "review", payload: { id: "one" }, idempotencyKey: "review:stable" },
    };
    const materialized = await store.materialize(occurrence);
    assert.deepEqual(await store.materialize(occurrence), { id: materialized.id, replayed: true });
    await assert.rejects(
      store.materialize({ ...occurrence, job: { ...occurrence.job, payload: { id: "two" } } }),
      { code: "SCHEDULE_IDEMPOTENCY_CONFLICT" },
    );
  });

  it("rejects expired job and outbox lease owners", async () => {
    let now = new Date(0);
    const store = memoryJobStore(() => now);
    await store.enqueue({ name: "lease", payload: {}, idempotencyKey: "lease:one" });
    const claimed = await store.claim(now, 10);
    assert.ok(claimed?.leaseToken);
    now = new Date(10);
    assert.equal(await store.renew(claimed.id, claimed.leaseToken, 10), false);
    assert.equal(await store.complete(claimed.id, claimed.leaseToken), false);
    assert.equal(await store.fail(claimed.id, claimed.leaseToken, { errorCode: "STALE", availableAt: now, dead: true }), false);
    const replacement = await store.claim(now, 10);
    assert.ok(replacement?.leaseToken);
    assert.notEqual(replacement.leaseToken, claimed.leaseToken);
    assert.equal(await store.complete(claimed.id, claimed.leaseToken), false);
    assert.equal(await store.complete(replacement.id, replacement.leaseToken), true);

    const LeaseEvent = testEvent({ owner: "tests", name: "LeaseEvent", parse: (value: unknown) => value });
    await store.appendOutbox(LeaseEvent, { id: "one" }, outboxOptions("lease:event"));
    const outbox = await store.claimOutbox(now, 10);
    assert.ok(outbox?.leaseToken);
    now = new Date(20);
    assert.equal(await store.settleOutbox(outbox.id, outbox.leaseToken, { kind: "published", at: now }), false);
    const reclaimed = await store.claimOutbox(now, 10);
    assert.ok(reclaimed?.leaseToken);
    assert.notEqual(reclaimed.leaseToken, outbox.leaseToken);
    assert.equal(await store.settleOutbox(outbox.id, outbox.leaseToken, { kind: "published", at: now }), false);
    assert.equal(await store.settleOutbox(reclaimed.id, reclaimed.leaseToken, { kind: "published", at: now }), true);
  });

  it("renews a lease while a slow handler is running", async () => {
    const base = memoryJobStore(() => new Date(0));
    let renewals = 0;
    const store: JobStore = {
      ...base,
      async renew(id, leaseToken, leaseMilliseconds) {
        renewals += 1;
        return base.renew(id, leaseToken, leaseMilliseconds);
      },
    };
    await store.enqueue({ name: "slow", payload: {}, idempotencyKey: "slow:one" });
    const worker = createWorker({
      store,
      handlers: { slow: () => new Promise((resolve) => setTimeout(resolve, 25)) },
      leaseMilliseconds: 10,
      now: () => new Date(0),
    });
    assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
    assert.ok(renewals >= 1);
  });

  it("records external effects once and replays their stored result", async () => {
    const store = memoryJobStore(() => new Date(0));
    await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "charge-job" });
    let effects = 0;
    const values: string[] = [];
    const worker = createWorker({ store, handlers: { charge: async (_payload, context) => { values.push(await context.effect("charge:one", async () => { effects += 1; return { value: "payment_1", providerReference: "payment_1" }; })); } }, now: () => new Date(0) });
    assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
    await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "charge-job-2" });
    assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
    assert.equal(effects, 1);
    assert.deepEqual(values, ["payment_1", "payment_1"]);
  });

  it("lets only one active worker execute a shared external effect", async () => {
    const store = memoryJobStore(() => new Date(0));
    await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "concurrent:one" });
    await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "concurrent:two" });
    let effects = 0;
    let startEffect!: () => void;
    let releaseEffect!: () => void;
    const started = new Promise<void>((resolve) => { startEffect = resolve; });
    const released = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const handler = async (_payload: unknown, context: JobHandlerContext) => {
      await context.effect("charge:concurrent", async () => {
        effects += 1;
        startEffect();
        await released;
        return { value: "payment_concurrent" };
      });
    };
    const firstWorker = createWorker({ store, handlers: { charge: handler }, now: () => new Date(0) });
    const secondWorker = createWorker({ store, handlers: { charge: handler }, now: () => new Date(0) });
    const first = firstWorker.runOnce(new AbortController().signal);
    await started;
    assert.equal(await secondWorker.runOnce(new AbortController().signal), "retry");
    releaseEffect();
    assert.equal(await first, "succeeded");
    assert.equal(effects, 1);
  });

  it("allows only one reconciled-missing worker to reclaim an abandoned effect", async () => {
    let now = new Date(0);
    const store = memoryJobStore(() => now);
    await store.enqueue({ name: "recover", payload: {}, idempotencyKey: "recover:abandoned" });
    const abandoned = await store.claim(now, 1);
    assert.ok(abandoned?.leaseToken);
    const abandonedOwner = { jobId: abandoned.id, leaseToken: abandoned.leaseToken };
    assert.equal((await store.transitionEffect({ kind: "reserve", key: "effect:abandoned", owner: abandonedOwner, updatedAt: now })).applied, true);
    await store.enqueue({ name: "recover", payload: {}, idempotencyKey: "recover:second" });
    now = new Date(1);

    let effects = 0;
    let startEffect!: () => void;
    let releaseEffect!: () => void;
    const started = new Promise<void>((resolve) => { startEffect = resolve; });
    const released = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const handler = async (_payload: unknown, context: JobHandlerContext) => {
      await context.effect(
        "effect:abandoned",
        async () => {
          effects += 1;
          startEffect();
          await released;
          return { value: "recovered" };
        },
        async () => ({ state: "missing" }),
      );
    };
    const firstWorker = createWorker({ store, handlers: { recover: handler }, now: () => now, leaseMilliseconds: 100 });
    const secondWorker = createWorker({ store, handlers: { recover: handler }, now: () => now, leaseMilliseconds: 100 });
    const first = firstWorker.runOnce(new AbortController().signal);
    await started;
    assert.equal(await secondWorker.runOnce(new AbortController().signal), "retry");
    releaseEffect();
    assert.equal(await first, "succeeded");
    assert.equal(effects, 1);
  });

  it("requires reconciliation for an abandoned effect and keeps success terminal", async () => {
    let now = new Date(0);
    const store = memoryJobStore(() => now);
    await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "crashed-effect-job" });
    const abandoned = await store.claim(now, 1);
    assert.ok(abandoned?.leaseToken);
    const owner = { jobId: abandoned.id, leaseToken: abandoned.leaseToken };
    assert.equal((await store.transitionEffect({ kind: "reserve", key: "charge:crashed", owner, updatedAt: now })).applied, true);
    now = new Date(1);
    let calls = 0;
    const worker = createWorker({
      store,
      handlers: {
        charge: async (_payload, context) => {
          await context.effect("charge:crashed", async () => {
            calls += 1;
            return { value: "duplicate" };
          });
        },
      },
      now: () => now,
    });
    assert.equal(await worker.runOnce(new AbortController().signal), "retry");
    assert.equal(calls, 0);

    now = new Date(3_000);
    const replacement = await store.claim(now, 100);
    assert.ok(replacement?.leaseToken);
    assert.equal((await store.transitionEffect({ kind: "reconcile-succeeded", key: "charge:crashed", expectedOwner: owner, owner: { jobId: replacement.id, leaseToken: replacement.leaseToken }, result: null, updatedAt: now })).applied, true);
    const stale = await store.transitionEffect({ kind: "uncertain", key: "charge:crashed", owner, updatedAt: now });
    assert.equal(stale.applied, false);
    assert.equal(stale.receipt?.state, "succeeded");
    assert.equal(stale.receipt?.result, null);
  });

  it("leases one outbox record and reports a lost settlement fence", async () => {
    let now = new Date(0);
    const store = memoryJobStore(() => now);
    const Event = testEvent({ owner: "tests", name: "ProjectCreated", parse: (value: unknown) => value });
    await store.appendOutbox(Event, { id: "one" }, outboxOptions("event:leased"));
    const record = await store.claimOutbox(now, 100);
    assert.ok(record?.leaseToken);
    assert.equal(await store.claimOutbox(new Date(50), 100), undefined);
    assert.equal(await store.settleOutbox(record.id, "wrong-lease", { kind: "published", at: new Date(60) }), false);
    now = new Date(100);
    const reclaimed = await store.claimOutbox(now, 100);
    assert.ok(reclaimed?.leaseToken);
    assert.notEqual(reclaimed.leaseToken, record.leaseToken);
    assert.equal(await store.settleOutbox(reclaimed.id, reclaimed.leaseToken, { kind: "published", at: now }), true);
    await store.appendOutbox(Event, { id: "fence" }, outboxOptions("event:fence", now));

    const fencedStore: JobStore = { ...store, settleOutbox: async () => false };
    const outcome = await dispatchOutbox(fencedStore, { targets: async () => [] }, { now: () => new Date(100) });
    assert.equal(outcome.fenceLost, 1);
    assert.equal(outcome.published, 0);
  });

  it("dispatches outbox work through the exact registered consumer", async () => {
    const ProjectCreated = event({ owner: "projects", name: "ProjectCreated", payload: object({ projectId: string() }) });
    const received: string[] = [];
    const welcome = consumer({
      name: "sendWelcome",
      event: ProjectCreated,
      durable: true,
      handle: ({ projectId }) => { received.push(projectId); },
    });
    const feature = defineFeature({ name: "projects", events: [ProjectCreated], consumers: [welcome] });
    const runtime = createConsumerRuntime([feature]);
    const store = memoryJobStore(() => new Date(0));

    assert.equal(runtime.bindings[0]?.target, welcome);
    assert.deepEqual(Object.keys(runtime.handlers), ["projects.sendWelcome"]);
    await store.appendOutbox(ProjectCreated, { projectId: "one" }, outboxOptions("project-created:one"));
    assert.equal((await dispatchOutbox(store, runtime.publisher(), { now: () => new Date(0) })).published, 1);
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => new Date(0) }).runOnce(new AbortController().signal), "succeeded");
    assert.deepEqual(received, ["one"]);

    const Unknown = testEvent({ owner: "tests", name: "UnknownEvent", parse: (value: unknown) => value });
    await store.appendOutbox(Unknown, {}, outboxOptions("unknown:one"));
    const unknownResult = await dispatchOutbox(store, runtime.publisher(), { now: () => new Date(1) });
    assert.equal(unknownResult.quarantined, 1);
    assert.equal((await store.quarantinedOutbox())[0]?.quarantineReason, "EVENT_NOT_REGISTERED");
  });

  it("materializes a registered schedule into its exact consumer envelope", async () => {
    const ReviewDue = event({ owner: "reviews", name: "ReviewDue", payload: object({ reviewId: string() }) });
    const received: string[] = [];
    const review = consumer({ name: "review", event: ReviewDue, durable: true, handle: ({ reviewId }) => { received.push(reviewId); } });
    const daily = schedule({ name: "daily", feature: "reviews", target: review, occurrences: (now) => [{ occurrence: "2026-01-01", payload: { reviewId: "one" }, dueAt: now }] });
    const feature = defineFeature({ name: "reviews", events: [ReviewDue], consumers: [review], schedules: [daily] });
    const runtime = createConsumerRuntime([feature]);
    const store = memoryJobStore(() => new Date(0));
    assert.equal(scheduleRuntimeBinding(daily).target, daily);
    assert.deepEqual(await runScheduler(store, [daily], new Date(0)), { created: 1, replayed: 0, failed: 0, failureOverflow: 0, cancelled: false, failures: [] });
    assert.deepEqual(await runScheduler(store, [daily], new Date(1_000)), { created: 0, replayed: 1, failed: 0, failureOverflow: 0, cancelled: false, failures: [] });
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => new Date(0) }).runOnce(new AbortController().signal), "succeeded");
    assert.deepEqual(received, ["one"]);
    const Tick = event({ owner: "reviews", name: "Tick", payload: unit() });
    let ticks = 0;
    const tickTarget = consumer({ name: "tick", event: Tick, durable: true, handle: () => { ticks += 1; } });
    const tick = schedule({ name: "tick", feature: "reviews", target: tickTarget, occurrences: (now) => [{ occurrence: "one", payload: undefined, dueAt: now }] });
    const tickStore = memoryJobStore(() => new Date(0));
    assert.equal((await runScheduler(tickStore, [tick], new Date(0))).created, 1);
    assert.equal((await runScheduler(tickStore, [tick], new Date(1_000))).replayed, 1);
    const tickRuntime = createConsumerRuntime([defineFeature({ name: "reviews", events: [Tick], consumers: [tickTarget], schedules: [tick] })]);
    assert.equal(await createWorker({ store: tickStore, handlers: tickRuntime.handlers, now: () => new Date(0) }).runOnce(new AbortController().signal), "succeeded");
    assert.equal(ticks, 1);
  });

  it("materializes one generic schedule occurrence and dispatches outbox records once", async () => {
    const store = memoryJobStore(() => new Date(0));
    const schedule = { name: "daily", occurrences: () => [{ schedule: "daily", occurrence: "2026-01-01", job: { name: "review", payload: {}, idempotencyKey: "review:2026-01-01" } }] };
    assert.deepEqual(await runScheduler(store, [schedule], new Date(0)), { created: 1, replayed: 0, failed: 0, failureOverflow: 0, cancelled: false, failures: [] });
    assert.deepEqual(await runScheduler(store, [schedule], new Date(0)), { created: 0, replayed: 1, failed: 0, failureOverflow: 0, cancelled: false, failures: [] });
    const contained = await runScheduler(store, [
      { name: "bounded", occurrences: () => [{ schedule: "x".repeat(201), occurrence: "one", job: { name: "ignored", payload: {}, idempotencyKey: "bounded" } }] },
      { name: "broken", occurrences: () => { throw Object.assign(new Error("broken"), { code: "BROKEN_SCHEDULE" }); } },
      { name: "later", occurrences: () => [{ schedule: "later", occurrence: "one", job: { name: "later", payload: {}, idempotencyKey: "later:one" } }] },
      { name: "too-long", occurrences: () => [{ schedule: "too-long", occurrence: "x".repeat(101), job: { name: "ignored", payload: {}, idempotencyKey: "ignored" } }] },
    ], new Date(0));
    assert.deepEqual(contained, { created: 1, replayed: 0, failed: 3, failureOverflow: 0, cancelled: false, failures: [
      { schedule: "bounded", occurrence: "one", errorCode: "SCHEDULE_NAME_INVALID" },
      { schedule: "broken", errorCode: "BROKEN_SCHEDULE" },
      { schedule: "too-long", occurrence: "x".repeat(100), errorCode: "SCHEDULE_OCCURRENCE_INVALID" },
    ] });
    const overflow = await runScheduler(store, [{
      name: "overflow",
      occurrences: () => Array.from({ length: 1_001 }, (_, index) => ({ schedule: "overflow", occurrence: `${String(index)}${"x".repeat(101)}`, job: { name: "ignored", payload: {}, idempotencyKey: `ignored:${String(index)}` } })),
    }], new Date(0));
    assert.equal(overflow.failed, 1_001);
    assert.equal(overflow.failures.length, 1_000);
    assert.equal(overflow.failureOverflow, 1);
    assert.equal(overflow.cancelled, false);
    const limited = await runScheduler(store, [{
      name: "limited",
      occurrences: () => [
        { schedule: "limited", occurrence: "one", job: { name: "ignored", payload: {}, idempotencyKey: "limited:one" } },
        { schedule: "limited", occurrence: "two", job: { name: "ignored", payload: {}, idempotencyKey: "limited:two" } },
      ],
    }], new Date(0), { maximumOccurrencesPerSchedule: 1 });
    assert.deepEqual(limited, { created: 0, replayed: 0, failed: 1, failureOverflow: 0, cancelled: false, failures: [{ schedule: "limited", errorCode: "SCHEDULE_OCCURRENCE_LIMIT_EXCEEDED" }] });
    const cancelled = new AbortController();
    cancelled.abort();
    assert.deepEqual(await runScheduler(store, [schedule], new Date(0), { signal: cancelled.signal }), { created: 0, replayed: 0, failed: 0, failureOverflow: 0, cancelled: true, failures: [] });
    const ReviewDue = testEvent({ owner: "tests", name: "ReviewDue", parse: (value: unknown) => { if (typeof value !== "object" || value === null) throw new Error("invalid"); return value; } });
    await store.appendOutbox(ReviewDue, { reviewId: "one" }, outboxOptions("event:one"));
    const published: string[] = [];
    const publisher = { targets: async (record: { readonly id: string }) => { published.push(record.id); return []; } };
    assert.equal((await dispatchOutbox(store, publisher, { now: () => new Date(1) })).published, 1);
    assert.equal((await dispatchOutbox(store, publisher)).published, 0);
    assert.equal(published.length, 1);
  });
});

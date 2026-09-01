import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createWorker,
  dispatchOutbox,
  durableEvent,
  memoryJobStore,
  runScheduler,
  type JobHandlerContext,
  type JobStore,
} from "../src/index.js";

describe("durable work runtime", () => {
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

    const ProjectCreated = durableEvent({ name: "ProjectCreated", version: 2, parse: (value: unknown) => value });
    const outbox = await store.appendOutbox(ProjectCreated, { project: { id: "one", active: true } }, "event:stable");
    assert.deepEqual(
      await store.appendOutbox(ProjectCreated, { project: { active: true, id: "one" } }, "event:stable"),
      { id: outbox.id, replayed: true },
    );
    await assert.rejects(
      store.appendOutbox(ProjectCreated, { project: { id: "two", active: true } }, "event:stable"),
      { code: "OUTBOX_IDEMPOTENCY_CONFLICT" },
    );
    const ProjectCreatedV3 = durableEvent({ name: "ProjectCreated", version: 3, parse: (value: unknown) => value });
    await assert.rejects(
      store.appendOutbox(ProjectCreatedV3, { project: { id: "one", active: true } }, "event:stable"),
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

    const LeaseEvent = durableEvent({ name: "LeaseEvent", parse: (value: unknown) => value });
    await store.appendOutbox(LeaseEvent, { id: "one" }, "lease:event");
    const [outbox] = await store.dueOutbox(1, now, 10);
    assert.ok(outbox?.leaseToken);
    now = new Date(20);
    assert.equal(await store.markPublished(outbox.id, outbox.leaseToken, now), false);
    const [reclaimed] = await store.dueOutbox(1, now, 10);
    assert.ok(reclaimed?.leaseToken);
    assert.notEqual(reclaimed.leaseToken, outbox.leaseToken);
    assert.equal(await store.markPublished(outbox.id, outbox.leaseToken, now), false);
    assert.equal(await store.markPublished(reclaimed.id, reclaimed.leaseToken, now), true);
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

  it("leases outbox records so concurrent dispatchers do not claim the same batch", async () => {
    const store = memoryJobStore(() => new Date(0));
    const Event = durableEvent({ name: "ProjectCreated", parse: (value: unknown) => value });
    await store.appendOutbox(Event, { id: "one" }, "event:leased");
    const [record] = await store.dueOutbox(1, new Date(0), 100);
    assert.ok(record?.leaseToken);
    assert.deepEqual(await store.dueOutbox(1, new Date(50), 100), []);
    assert.equal(await store.markPublished(record.id, "wrong-lease", new Date(60)), false);
    const [reclaimed] = await store.dueOutbox(1, new Date(100), 100);
    assert.ok(reclaimed?.leaseToken);
    assert.notEqual(reclaimed.leaseToken, record.leaseToken);

    await store.appendOutbox(Event, { id: "fence" }, "event:fence");
    const fencedStore: JobStore = { ...store, markPublished: async () => false };
    await assert.rejects(
      dispatchOutbox(fencedStore, { publish: async () => undefined }, { now: () => new Date(200) }),
      { code: "OUTBOX_FENCE_LOST" },
    );
  });

  it("materializes one schedule occurrence and dispatches outbox records once", async () => {
    const store = memoryJobStore(() => new Date(0));
    const schedule = { name: "daily", occurrences: () => [{ schedule: "daily", occurrence: "2026-01-01", job: { name: "review", payload: {}, idempotencyKey: "review:2026-01-01" } }] };
    assert.equal(await runScheduler(store, [schedule], new Date(0)), 1);
    assert.equal(await runScheduler(store, [schedule], new Date(0)), 0);
    const ReviewDue = durableEvent({ name: "ReviewDue", parse: (value: unknown) => { if (typeof value !== "object" || value === null) throw new Error("invalid"); return value; } });
    await store.appendOutbox(ReviewDue, { reviewId: "one" }, "event:one");
    const published: string[] = [];
    assert.equal(await dispatchOutbox(store, { publish: async ({ id }) => { published.push(id); } }, { now: () => new Date(1) }), 1);
    assert.equal(await dispatchOutbox(store, { publish: async ({ id }) => { published.push(id); } }), 0);
    assert.equal(published.length, 1);
  });
});

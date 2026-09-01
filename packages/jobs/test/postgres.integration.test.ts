import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestDatabase, migrateToLatest } from "@typescript-on-rails/postgres";
import { sql } from "kysely";

import {
  createWorker,
  dispatchOutbox,
  durableEvent,
  jobsMigration,
  postgresJobStore,
  type JobDatabase,
  type JobHandlerContext,
} from "../src/index.js";

const connectionString = process.env.TEST_DATABASE_URL;

describe("PostgreSQL durable work", () => {
  it(
    "proves idempotency, leases, schedules, outbox claims, and null effect results",
    { skip: connectionString === undefined },
    async () => {
      const database = await createTestDatabase<JobDatabase>(connectionString ?? "");
      try {
        await migrateToLatest(database.db, [{ name: "001_jobs", up: jobsMigration.up }]);
        const store = postgresJobStore(database.db);
        const first = await store.enqueue({
          name: "review",
          payload: { id: "one" },
          idempotencyKey: "review:one",
        });
        assert.equal(first.replayed, false);
        assert.deepEqual(
          await store.enqueue({ name: "review", payload: { id: "one" }, idempotencyKey: "review:one" }),
          { id: first.id, replayed: true },
        );
        await assert.rejects(
          store.enqueue({ name: "review", payload: {}, idempotencyKey: "review:one" }),
          { code: "JOB_IDEMPOTENCY_CONFLICT" },
        );
        const matching = await Promise.all([
          store.enqueue({ name: "review", payload: { id: "concurrent" }, idempotencyKey: "review:concurrent" }),
          store.enqueue({ name: "review", payload: { id: "concurrent" }, idempotencyKey: "review:concurrent" }),
        ]);
        assert.equal(matching.filter(({ replayed }) => !replayed).length, 1);
        const conflicting = await Promise.allSettled([
          store.enqueue({ name: "review", payload: { id: "left" }, idempotencyKey: "review:collision" }),
          store.enqueue({ name: "review", payload: { id: "right" }, idempotencyKey: "review:collision" }),
        ]);
        assert.equal(conflicting.filter(({ status }) => status === "fulfilled").length, 1);
        const conflict = conflicting.find((result): result is PromiseRejectedResult => result.status === "rejected");
        assert.equal(conflict?.reason?.code, "JOB_IDEMPOTENCY_CONFLICT");

        const claimed = await store.claim(new Date(), 1_000);
        assert.ok(claimed?.leaseToken);
        await sql`update tor_jobs set lease_expires_at = now() where id = ${claimed.id}`.execute(database.db);
        assert.equal(await store.renew(claimed.id, claimed.leaseToken, 1_000), false);
        assert.equal(await store.complete(claimed.id, claimed.leaseToken), false);
        assert.equal(await store.fail(claimed.id, claimed.leaseToken, { errorCode: "STALE", availableAt: new Date(), dead: true }), false);
        const replacement = await store.claim(new Date(), 1_000);
        assert.ok(replacement?.leaseToken);
        assert.notEqual(replacement.leaseToken, claimed.leaseToken);
        assert.equal(await store.complete(replacement.id, replacement.leaseToken), true);

        const occurrences = await Promise.all([
          store.materialize({ schedule: "daily", occurrence: "2026-01-01", job: { name: "daily", payload: {}, idempotencyKey: "daily:2026-01-01" } }),
          store.materialize({ schedule: "daily", occurrence: "2026-01-01", job: { name: "daily", payload: {}, idempotencyKey: "daily:2026-01-01" } }),
        ]);
        assert.equal(occurrences.filter(({ replayed }) => !replayed).length, 1);
        assert.equal(new Set(occurrences.map(({ id }) => id)).size, 1);
        await assert.rejects(
          store.materialize({ schedule: "daily", occurrence: "2026-01-01", job: { name: "daily", payload: { changed: true }, idempotencyKey: "daily:2026-01-01" } }),
          { code: "SCHEDULE_IDEMPOTENCY_CONFLICT" },
        );

        const Created = durableEvent({ name: "ProjectCreated", parse: (value: unknown) => value });
        const created = await store.appendOutbox(Created, { id: "one" }, "created:one");
        assert.deepEqual(await store.appendOutbox(Created, { id: "one" }, "created:one"), { id: created.id, replayed: true });
        await assert.rejects(store.appendOutbox(Created, { id: "two" }, "created:one"), { code: "OUTBOX_IDEMPOTENCY_CONFLICT" });
        const published: string[] = [];
        assert.equal(
          await dispatchOutbox(store, { publish: async ({ id }) => { published.push(id); } }),
          1,
        );
        assert.deepEqual(published.length, 1);

        await store.appendOutbox(Created, { id: "leased" }, "created:leased");
        const [leased] = await store.dueOutbox(1, new Date(), 1_000);
        assert.ok(leased?.leaseToken);
        await sql`update tor_outbox set lease_expires_at = now() where id = ${leased.id}`.execute(database.db);
        assert.equal(await store.markPublished(leased.id, leased.leaseToken, new Date()), false);

        while (true) {
          const pending = await store.claim(new Date(), 1_000);
          if (pending === undefined) break;
          assert.ok(pending.leaseToken);
          assert.equal(await store.complete(pending.id, pending.leaseToken), true);
        }

        await store.enqueue({ name: "terminal", payload: {}, idempotencyKey: "effect:terminal-job" });
        const terminalJob = await store.claim(new Date(), 1_000);
        assert.ok(terminalJob?.leaseToken);
        const terminalOwner = { jobId: terminalJob.id, leaseToken: terminalJob.leaseToken };
        assert.equal((await store.transitionEffect({ kind: "reserve", key: "effect:terminal", owner: terminalOwner, updatedAt: new Date() })).applied, true);
        assert.equal((await store.transitionEffect({ kind: "succeed", key: "effect:terminal", owner: terminalOwner, result: null, updatedAt: new Date() })).applied, true);
        const staleEffect = await store.transitionEffect({ kind: "uncertain", key: "effect:terminal", owner: terminalOwner, updatedAt: new Date() });
        assert.equal(staleEffect.applied, false);
        assert.equal(staleEffect.receipt?.state, "succeeded");
        assert.equal(staleEffect.receipt?.result, null);
        assert.equal(await store.complete(terminalJob.id, terminalJob.leaseToken), true);

        await store.enqueue({ name: "recover", payload: {}, idempotencyKey: "effect:abandoned-job" });
        const abandoned = await store.claim(new Date(), 1_000);
        assert.ok(abandoned?.leaseToken);
        const abandonedOwner = { jobId: abandoned.id, leaseToken: abandoned.leaseToken };
        assert.equal((await store.transitionEffect({ kind: "reserve", key: "effect:abandoned", owner: abandonedOwner, updatedAt: new Date() })).applied, true);
        await sql`update tor_jobs set lease_expires_at = now() where id = ${abandoned.id}`.execute(database.db);
        await store.enqueue({ name: "recover", payload: {}, idempotencyKey: "effect:resolver-job" });
        const resolverA = await store.claim(new Date(), 1_000);
        const resolverB = await store.claim(new Date(), 1_000);
        assert.ok(resolverA?.leaseToken);
        assert.ok(resolverB?.leaseToken);
        const ownerA = { jobId: resolverA.id, leaseToken: resolverA.leaseToken };
        const ownerB = { jobId: resolverB.id, leaseToken: resolverB.leaseToken };
        const reclaims = await Promise.all([
          store.transitionEffect({ kind: "reclaim", key: "effect:abandoned", expectedOwner: abandonedOwner, owner: ownerA, updatedAt: new Date() }),
          store.transitionEffect({ kind: "reclaim", key: "effect:abandoned", expectedOwner: abandonedOwner, owner: ownerB, updatedAt: new Date() }),
        ]);
        assert.equal(reclaims.filter(({ applied }) => applied).length, 1);
        const winningOwner = reclaims[0]?.applied ? ownerA : ownerB;
        assert.equal((await store.transitionEffect({ kind: "succeed", key: "effect:abandoned", owner: winningOwner, result: "recovered", updatedAt: new Date() })).applied, true);
        assert.equal(await store.complete(resolverA.id, resolverA.leaseToken), true);
        assert.equal(await store.complete(resolverB.id, resolverB.leaseToken), true);

        await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "charge:one" });
        await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "charge:two" });
        let effects = 0;
        let startEffect!: () => void;
        let releaseEffect!: () => void;
        const started = new Promise<void>((resolve) => { startEffect = resolve; });
        const released = new Promise<void>((resolve) => { releaseEffect = resolve; });
        const charge = async (_payload: unknown, context: JobHandlerContext) => {
          await context.effect("charge:shared", async () => {
            effects += 1;
            startEffect();
            await released;
            return { value: null };
          });
        };
        const firstWorker = createWorker({ store, handlers: { charge } });
        const secondWorker = createWorker({ store, handlers: { charge } });
        const firstRun = firstWorker.runOnce(new AbortController().signal);
        await started;
        assert.equal(await secondWorker.runOnce(new AbortController().signal), "retry");
        releaseEffect();
        assert.equal(await firstRun, "succeeded");
        assert.equal(effects, 1);
        const replayedEffectJob = await store.enqueue({ name: "charge", payload: {}, idempotencyKey: "charge:three" });
        assert.equal(replayedEffectJob.replayed, false);
        assert.equal(await firstWorker.runOnce(new AbortController().signal), "succeeded");
        assert.equal(effects, 1);
      } finally {
        await database.close();
      }
    },
  );
});

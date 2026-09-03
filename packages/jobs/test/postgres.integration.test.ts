import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestDatabase, migrateToLatest } from "@typescript-on-rails/postgres";
import { sql } from "kysely";
import { consumer, defineFeature, event, object, runtimeRecordId, schedule, string } from "typescript-on-rails";

import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  jobsExpandMigration,
  jobsMigration,
  postgresJobStore,
  postgresJobWriter,
  runScheduler,
  withPostgresRequestUnitOfWork,
  type DurableEvent,
  type JobDatabase,
  type JobHandlerContext,
} from "../src/index.js";

const connectionString = process.env.TEST_DATABASE_URL;

function testEvent<T>(definition: { readonly owner: string; readonly name: string; readonly version?: number; readonly parse: (value: unknown) => T }): DurableEvent<T> {
  return Object.freeze({ id: runtimeRecordId("event", definition.owner, definition.name), name: definition.name, version: definition.version ?? 1, parse: definition.parse });
}

function outboxOptions(idempotencyKey: string, occurredAt = new Date()) {
  return { idempotencyKey, occurredAt, requestId: `request:${idempotencyKey}`, correlationId: `correlation:${idempotencyKey}` };
}

describe("PostgreSQL durable work", () => {
  it(
    "proves idempotency, leases, schedules, outbox claims, and null effect results",
    { skip: connectionString === undefined },
    async () => {
      const database = await createTestDatabase<JobDatabase>(connectionString ?? "");
      try {
        const role = await sql<{ current_user: string; superuser: boolean }>`
          select current_user, (select rolsuper from pg_roles where rolname = current_user) as superuser
        `.execute(database.db);
        assert.equal(role.rows[0]?.superuser, false);
        await migrateToLatest(database.db, [
          { name: "001_jobs", up: jobsMigration.up },
          { name: "002_jobs_expand", up: jobsExpandMigration.up },
        ]);
        const store = postgresJobStore(database.db);
        const Scheduled = event({ owner: "postgres-schedule", name: "Scheduled", payload: object({ id: string() }) });
        const scheduledConsumer = consumer({ name: "target", event: Scheduled, durable: true, handle: () => undefined });
        const registeredSchedule = schedule({ name: "daily", feature: "postgres-schedule", target: scheduledConsumer, occurrences: (now) => [{ occurrence: "stable", payload: { id: "one" }, dueAt: now }] });
        assert.equal((await runScheduler(store, [registeredSchedule], new Date(0))).created, 1);
        assert.equal((await runScheduler(store, [registeredSchedule], new Date(1_000))).replayed, 1);
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

        const Created = testEvent({ owner: "tests", name: "ProjectCreated", parse: (value: unknown) => value });
        const createdOptions = outboxOptions("created:one");
        const created = await store.appendOutbox(Created, { id: "one" }, createdOptions);
        assert.deepEqual(await store.appendOutbox(Created, { id: "one" }, createdOptions), { id: created.id, replayed: true });
        await assert.rejects(store.appendOutbox(Created, { id: "two" }, createdOptions), { code: "OUTBOX_IDEMPOTENCY_CONFLICT" });
        const published: string[] = [];
        assert.equal(
          (await dispatchOutbox(store, { targets: async ({ id }) => { published.push(id); return []; } })).published,
          1,
        );
        assert.deepEqual(published.length, 1);

        const LongIdentity = event({ owner: "x".repeat(4_000), name: "LongIdentity", payload: object({ id: string() }) });
        await store.appendOutbox(LongIdentity, { id: "long" }, outboxOptions("long-event-identity"));
        assert.equal((await dispatchOutbox(store, { targets: async () => [] })).published, 1);

        await store.appendOutbox(Created, { id: "leased" }, outboxOptions("created:leased"));
        const leased = await store.claimOutbox(new Date(0), 1_000);
        assert.ok(leased?.leaseToken);
        await sql`update tor_outbox set lease_expires_at = now() where id = ${leased.id}`.execute(database.db);
        assert.equal(await store.settleOutbox(leased.id, leased.leaseToken, { kind: "published", at: new Date() }), false);

        const SameNameA = testEvent({ owner: "first-owner", name: "SameName", parse: (value: unknown) => value });
        const SameNameB = testEvent({ owner: "second-owner", name: "SameName", parse: (value: unknown) => value });
        await Promise.all([
          store.appendOutbox(SameNameA, { id: "first" }, outboxOptions("same-name:first")),
          store.appendOutbox(SameNameB, { id: "second" }, outboxOptions("same-name:second")),
        ]);
        await assert.rejects(store.assertOutboxCapability("name-only"), /NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN/);
        assert.equal((await store.readMigrationState()).rollbackRestricted, true);
        const concurrentClaims = await Promise.all([
          store.claimOutbox(new Date(0), 10_000),
          store.claimOutbox(new Date(0), 10_000),
        ]);
        assert.equal(new Set(concurrentClaims.map((record) => record?.id)).size, 2);
        for (const record of concurrentClaims) {
          assert.ok(record?.leaseToken);
          assert.equal(await store.settleOutbox(record.id, record.leaseToken, { kind: "published", at: new Date() }), true);
        }
        while (true) {
          const pending = await store.claimOutbox(new Date(0), 10_000);
          if (pending === undefined) break;
          assert.ok(pending.leaseToken);
          assert.equal(await store.settleOutbox(pending.id, pending.leaseToken, { kind: "published", at: new Date() }), true);
        }

        while (true) {
          const pending = await store.claim(new Date(), 1_000);
          if (pending === undefined) break;
          assert.ok(pending.leaseToken);
          assert.equal(await store.complete(pending.id, pending.leaseToken), true);
        }

        const Changed = event({ owner: "postgres-poison", name: "Changed", version: 2, payload: object({ id: string(), label: string() }) });
        let handled = 0;
        const changedConsumer = consumer({ name: "changed", event: Changed, durable: true, handle: () => { handled += 1; } });
        const changedFeature = defineFeature({ name: "postgres-poison", events: [Changed], consumers: [changedConsumer] });
        const changedRuntime = createConsumerRuntime([changedFeature]);
        const HistoricChanged = testEvent({ owner: "postgres-poison", name: "Changed", version: 1, parse: (value: unknown) => value });
        await store.appendOutbox(HistoricChanged, { id: "historic" }, outboxOptions("postgres-poison:historic"));
        await store.appendOutbox(Changed, { id: "current", label: "valid" }, outboxOptions("postgres-poison:valid"));
        const poisonOutcome = await dispatchOutbox(store, changedRuntime.publisher(), { limit: 2 });
        assert.deepEqual({ published: poisonOutcome.published, quarantined: poisonOutcome.quarantined }, { published: 1, quarantined: 1 });
        assert.equal(await createWorker({ store, handlers: changedRuntime.handlers }).runOnce(new AbortController().signal), "succeeded");
        assert.equal(handled, 1);

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

  it(
    "expands legacy rows, resumes graph reconciliation, fences rollback, and rolls back partial fanout",
    { skip: connectionString === undefined },
    async () => {
      const database = await createTestDatabase<JobDatabase>(connectionString ?? "");
      try {
        await migrateToLatest(database.db, [{ name: "001_jobs", up: jobsMigration.up }]);
        for (const [id, eventName] of [["legacy_known", "Known"], ["legacy_unknown", "Unknown"], ["legacy_ambiguous", "Ambiguous"]] as const) {
          await sql`
            insert into tor_outbox
              (id, event, version, payload, idempotency_key, request_digest, published_at, created_at, lease_token, lease_expires_at)
            values (${id}, ${eventName}, 1, ${JSON.stringify({ original: id })}::jsonb, ${`key:${id}`}, ${"0".repeat(64)}, null, now(), null, null)
          `.execute(database.db);
        }
        await migrateToLatest(database.db, [
          { name: "001_jobs", up: jobsMigration.up },
          { name: "002_jobs_expand", up: jobsExpandMigration.up },
        ]);
        const store = postgresJobStore(database.db);
        assert.equal((await store.readMigrationState()).state, "Expanded");
        assert.equal(await store.transitionMigrationState("Expanded", "Dual-write"), true);
        assert.equal(await store.transitionMigrationState("Dual-write", "Reconciling"), true);
        assert.equal(await store.transitionMigrationState("Reconciling", "Cutover"), false);
        const candidates = [
          { eventName: "Known", eventId: "rid1/event/known/Known" },
          { eventName: "Ambiguous", eventId: "rid1/event/left/Ambiguous" },
          { eventName: "Ambiguous", eventId: "rid1/event/right/Ambiguous" },
        ];
        const totals = { resolved: 0, unknown: 0, ambiguous: 0 };
        for (let index = 0; index < 3; index += 1) {
          const result = await store.reconcileLegacyOutbox(candidates, 1);
          totals.resolved += result.resolved;
          totals.unknown += result.unknown;
          totals.ambiguous += result.ambiguous;
        }
        assert.deepEqual(totals, { resolved: 1, unknown: 1, ambiguous: 1 });
        assert.deepEqual(await store.reconcileLegacyOutbox(candidates, 10), { resolved: 0, unknown: 0, ambiguous: 0 });
        await assert.rejects(
          store.reconcileLegacyOutbox([{ eventName: "Known", eventId: "rid1/event/changed/Known" }]),
          /JOBS_RECONCILIATION_GRAPH_CHANGED/,
        );
        const legacy = await sql<{ id: string; payload: unknown; event_id: string | null; state: string }>`select id, payload, event_id, state from tor_outbox order by id`.execute(database.db);
        assert.deepEqual(legacy.rows.find(({ id }) => id === "legacy_known")?.payload, { original: "legacy_known" });
        assert.equal(legacy.rows.find(({ id }) => id === "legacy_known")?.event_id, "rid1/event/known/Known");
        assert.equal(legacy.rows.find(({ id }) => id === "legacy_unknown")?.state, "quarantined");
        assert.equal(legacy.rows.find(({ id }) => id === "legacy_ambiguous")?.state, "quarantined");
        assert.equal((await store.readMigrationState()).rollbackRestricted, true);
        await assert.rejects(store.assertOutboxCapability("name-only"), /NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN/);
        assert.equal(await store.transitionMigrationState("Reconciling", "Cutover"), true);
        await assert.rejects(store.requestOutboxReplay("legacy_unknown", {
          requestId: "unresolved-replay",
          approvedBy: "operator_one",
          reason: "must-not-guess",
          requestedAt: new Date(),
        }), /OUTBOX_IDENTITY_UNRESOLVED/);
        await sql`update tor_outbox set state = 'published', published_at = now() where id = 'legacy_known'`.execute(database.db);

        const Replayable = testEvent({ owner: "replay", name: "Replayable", parse: (value: unknown) => value });
        const replayable = await store.appendOutbox(Replayable, { id: "replay" }, outboxOptions("replay:long-reason"));
        const replayClaim = await store.claimOutbox(new Date(0), 10_000);
        assert.equal(replayClaim?.id, replayable.id);
        assert.ok(replayClaim.leaseToken);
        const replayTarget = { kind: "job" as const, consumerId: "rid1/consumer/replay/target", consumerVersion: 1, jobName: "replay.target", payload: { id: "replay" } };
        assert.equal((await store.materializeFanout(replayClaim, [replayTarget])).succeeded, 1);
        assert.equal(await store.settleOutbox(replayClaim.id, replayClaim.leaseToken, { kind: "quarantine", at: new Date(), reason: "TEST" }), true);
        const replayReason = "r".repeat(300);
        const replayRequest = {
          requestId: "exact-replay",
          approvedBy: "operator_one",
          reason: replayReason,
          requestedAt: new Date(),
        };
        assert.deepEqual(await store.requestOutboxReplay(replayable.id, replayRequest), { replayed: false });
        assert.deepEqual(await store.requestOutboxReplay(replayable.id, replayRequest), { replayed: true });
        await assert.rejects(
          store.requestOutboxReplay(replayable.id, { ...replayRequest, reason: "different" }),
          /REPLAY_REQUEST_CONFLICT/,
        );
        const replayHistory = await store.outboxHistory(replayable.id);
        const replayEntry = replayHistory.find(({ kind }) => kind === "replay_requested");
        assert.equal(replayEntry?.reasonCode, "REPLAY_APPROVED");
        assert.equal((replayEntry?.details as { reason?: string } | undefined)?.reason, replayReason);
        const replayedClaim = await store.claimOutbox(new Date(0), 10_000);
        assert.equal(replayedClaim?.id, replayable.id);
        assert.ok(replayedClaim.leaseToken);
        assert.equal((await store.materializeFanout(replayedClaim, [replayTarget])).succeeded, 1);
        assert.equal(await store.settleOutbox(replayedClaim.id, replayedClaim.leaseToken, { kind: "published", at: new Date() }), true);
        const replayJobs = await sql<{ count: number }>`select count(*)::int as count from tor_jobs where outbox_id = ${replayable.id}`.execute(database.db);
        const replayReceipts = await sql<{ count: number }>`select count(*)::int as count from tor_outbox_delivery_receipts where outbox_id = ${replayable.id}`.execute(database.db);
        assert.equal(replayJobs.rows[0]?.count, 1);
        assert.equal(replayReceipts.rows[0]?.count, 2);

        const Fanout = testEvent({ owner: "fanout", name: "Fanout", parse: (value: unknown) => value });
        const appended = await store.appendOutbox(Fanout, { id: "fanout" }, outboxOptions("fanout:atomic"));
        const claimed = await store.claimOutbox(new Date(), 10_000);
        assert.equal(claimed?.id, appended.id);
        assert.ok(claimed.leaseToken);
        await assert.rejects(store.materializeFanout(claimed, [
          { kind: "job", consumerId: `rid1/consumer/fanout/${"first".repeat(1_600)}`, consumerVersion: 1, jobName: "fanout.first", payload: { id: "ok" } },
          { kind: "job", consumerId: "rid1/consumer/fanout/second", consumerVersion: 1, jobName: "fanout.second", payload: { invalid: 1n } },
        ]), /BigInt|serialize/i);
        const jobs = await sql<{ count: number }>`select count(*)::int as count from tor_jobs where outbox_id = ${appended.id}`.execute(database.db);
        const receipts = await sql<{ count: number }>`select count(*)::int as count from tor_outbox_delivery_receipts where outbox_id = ${appended.id}`.execute(database.db);
        assert.equal(jobs.rows[0]?.count, 0);
        assert.equal(receipts.rows[0]?.count, 0);
        const mixed = await store.materializeFanout(claimed, [
          { kind: "job", consumerId: `rid1/consumer/fanout/${"first".repeat(1_600)}`, consumerVersion: 1, jobName: "fanout.first", payload: { id: "ok" } },
          { kind: "failed", consumerId: "rid1/consumer/fanout/invalid", consumerVersion: 2, errorCode: "EVENT_UPCASTER_MISSING", permanent: true },
        ]);
        assert.deepEqual({ total: mixed.total, succeeded: mixed.succeeded, failed: mixed.failed, permanentFailed: mixed.permanentFailed }, { total: 2, succeeded: 1, failed: 1, permanentFailed: 1 });
        assert.equal(await store.settleOutbox(claimed.id, claimed.leaseToken, { kind: "quarantine", at: new Date(), reason: "EVENT_UPCASTER_MISSING" }), true);
        const mixedJobs = await sql<{ count: number }>`select count(*)::int as count from tor_jobs where outbox_id = ${appended.id}`.execute(database.db);
        const mixedReceipts = await sql<{ count: number }>`select count(*)::int as count from tor_outbox_delivery_receipts where outbox_id = ${appended.id}`.execute(database.db);
        assert.equal(mixedJobs.rows[0]?.count, 1);
        assert.equal(mixedReceipts.rows[0]?.count, 2);

        const Transient = testEvent({ owner: "fanout", name: "Transient", parse: (value: unknown) => value });
        const transient = await store.appendOutbox(Transient, { id: "transient" }, outboxOptions("fanout:transient"));
        const transientClaim = await store.claimOutbox(new Date(0), 10_000);
        assert.equal(transientClaim?.id, transient.id);
        assert.ok(transientClaim.leaseToken);
        const transientId = "rid1/consumer/fanout/transient";
        const failedTransient = await store.materializeFanout(transientClaim, [
          { kind: "failed", consumerId: transientId, consumerVersion: 1, errorCode: "TARGET_TEMPORARY", permanent: false },
        ]);
        assert.equal(failedTransient.permanentFailed, 0);
        assert.equal(await store.settleOutbox(transientClaim.id, transientClaim.leaseToken, { kind: "partial", at: new Date(), availableAt: new Date(0), errorCode: "FANOUT_PARTIAL" }), true);
        const recoveredClaim = await store.claimOutbox(new Date(0), 10_000);
        assert.equal(recoveredClaim?.id, transient.id);
        assert.ok(recoveredClaim.leaseToken);
        const recoveredTransient = await store.materializeFanout(recoveredClaim, [
          { kind: "job", consumerId: transientId, consumerVersion: 1, jobName: "fanout.transient", payload: { id: "transient" } },
        ]);
        assert.deepEqual({ succeeded: recoveredTransient.succeeded, failed: recoveredTransient.failed }, { succeeded: 1, failed: 0 });
        assert.equal(await store.settleOutbox(recoveredClaim.id, recoveredClaim.leaseToken, { kind: "published", at: new Date() }), true);
      } finally {
        await database.close();
      }
    },
  );

  it(
    "allows opposite event append order without transaction deadlock",
    { skip: connectionString === undefined },
    async () => {
      const database = await createTestDatabase<JobDatabase>(connectionString ?? "");
      try {
        await migrateToLatest(database.db, [
          { name: "001_jobs", up: jobsMigration.up },
          { name: "002_jobs_expand", up: jobsExpandMigration.up },
        ]);
        const First = testEvent({ owner: "deadlock", name: "First", parse: (value: unknown) => value });
        const Second = testEvent({ owner: "deadlock", name: "Second", parse: (value: unknown) => value });
        let firstAppends = 0;
        let release!: () => void;
        const bothFirstAppends = new Promise<void>((resolve) => { release = resolve; });
        const appendPair = (first: DurableEvent<unknown>, second: DurableEvent<unknown>, prefix: string) => database.db.transaction().execute(async (transaction) => {
          const writer = postgresJobWriter(transaction);
          await writer.appendOutbox(first, { prefix, order: 1 }, outboxOptions(`${prefix}:first`));
          firstAppends += 1;
          if (firstAppends === 2) release();
          await bothFirstAppends;
          await writer.appendOutbox(second, { prefix, order: 2 }, outboxOptions(`${prefix}:second`));
        });
        const outcomes = await Promise.allSettled([
          appendPair(First, Second, "forward"),
          appendPair(Second, First, "reverse"),
        ]);
        assert.deepEqual(outcomes.map(({ status }) => status), ["fulfilled", "fulfilled"]);
        const store = postgresJobStore(database.db);
        await sql`delete from tor_jobs_migration_state where singleton = 1`.execute(database.db);
        await assert.rejects(store.assertOutboxCapability("exact"), /JOBS_MIGRATION_STATE_MISSING/);
        await assert.rejects(store.assertOutboxCapability("name-only"), /JOBS_MIGRATION_STATE_MISSING/);
      } finally {
        await database.close();
      }
    },
  );

  it(
    "commits business state and outbox together or rolls both back",
    { skip: connectionString === undefined },
    async () => {
      interface RequestDatabase extends JobDatabase {
        projects: { id: string; tenant_id: string; name: string };
      }
      const database = await createTestDatabase<RequestDatabase>(connectionString ?? "");
      try {
        await migrateToLatest(database.db, [
          { name: "001_jobs", up: jobsMigration.up },
          { name: "002_jobs_expand", up: jobsExpandMigration.up },
        ]);
        await database.db.schema
          .createTable("projects")
          .addColumn("id", "varchar(80)", (column) => column.primaryKey())
          .addColumn("tenant_id", "varchar(80)", (column) => column.notNull())
          .addColumn("name", "varchar(200)", (column) => column.notNull())
          .execute();
        const ProjectCreated = testEvent({ owner: "tests", name: "ProjectCreated", parse: (value: unknown) => value });
        const request = { tenantId: "tenant_one", actorId: "actor_one", requestId: "request_one" };

        await assert.rejects(
          withPostgresRequestUnitOfWork(database, request, async (unit) => {
            await unit.transaction.insertInto("projects").values({ id: "rolled_back", tenant_id: "tenant_one", name: "No" }).execute();
            await unit.outbox.appendOutbox(ProjectCreated, { projectId: "rolled_back" }, "project:rolled_back");
            throw new Error("ROLL_BACK_REQUEST");
          }),
          /ROLL_BACK_REQUEST/,
        );
        assert.equal((await database.db.selectFrom("projects").select("id").execute()).length, 0);
        assert.equal((await database.db.selectFrom("tor_outbox").select("id").execute()).length, 0);

        await withPostgresRequestUnitOfWork(database, request, async (unit) => {
          await unit.transaction.insertInto("projects").values({ id: "committed", tenant_id: "tenant_one", name: "Yes" }).execute();
          await unit.outbox.appendOutbox(ProjectCreated, { projectId: "committed" }, "project:committed");
        });
        assert.equal((await database.db.selectFrom("projects").select("id").execute()).length, 1);
        assert.equal((await database.db.selectFrom("tor_outbox").select("id").execute()).length, 1);
      } finally {
        await database.close();
      }
    },
  );
});

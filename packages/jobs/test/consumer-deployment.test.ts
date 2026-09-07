import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTestDatabase } from "@typescript-on-rails/postgres";
import type { Kysely } from "kysely";
import { consumer, defineFeature, event, object, runtimeRecordId, schedule, string } from "typescript-on-rails";

import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  jobsExpandMigration,
  jobsMigration,
  memoryJobStore,
  postgresJobStore,
  runScheduler,
  type DurableConsumerContext,
  type DurableUpcaster,
  type OutboxFanoutTarget,
  type JobDatabase,
  type JobRecord,
  type JobStore,
} from "../src/index.js";

const connectionString = process.env.TEST_DATABASE_URL;
const at = new Date("2026-01-01T00:00:00Z");
const appendOptions = {
  idempotencyKey: "deployment",
  occurredAt: at,
  tenantId: "tenant_one",
  actorId: "actor_one",
  requestId: "request_one",
  correlationId: "correlation_one",
  causationId: "cause_one",
};

for (const backend of ["memory", "postgres"] as const) {
  describe(`${backend} consumer deployments`, { skip: backend === "postgres" && connectionString === undefined }, () => {
    async function withStore(run: (store: JobStore, db?: Kysely<JobDatabase>) => Promise<void>) {
      if (backend === "memory") return run(memoryJobStore(() => new Date()));
      const database = await createTestDatabase<JobDatabase>(connectionString ?? "");
      try {
        await jobsMigration.up(database.db);
        await jobsExpandMigration.up(database.db);
        await run(postgresJobStore(database.db), database.db);
      } finally {
        await database.close();
      }
    }

    it("executes the same v1 queued job with a v2 runtime without changing its historical envelope", async () => {
      await withStore(async (store) => {
        const V1 = event({ owner: "deployment", name: "Changed", payload: object({ id: string() }) });
        const oldTarget = consumer({ name: "changed", event: V1, durable: true, handle: () => assert.fail("old handler") });
        const oldRuntime = createConsumerRuntime([defineFeature({ name: "deployment", events: [V1], consumers: [oldTarget] })]);
        const historicalPayload = { id: "one", permissions: ["admin"], tenantId: "payload-tenant", actorId: "payload-actor" };
        await store.appendOutbox(V1, historicalPayload, appendOptions);
        let persistedJobId: string | undefined;
        const dispatchStore: JobStore = {
          ...store,
          async materializeFanout(record, targets) {
            const result = await store.materializeFanout(record, targets);
            persistedJobId = result.receipts[0]?.jobId;
            return result;
          },
        };
        assert.equal((await dispatchOutbox(dispatchStore, oldRuntime.publisher())).published, 1);
        assert.ok(persistedJobId);

        const V2 = event({ owner: "deployment", name: "Changed", version: 2, payload: object({ id: string(), label: string() }) });
        let handled = 0;
        let upgraded = 0;
        let claimed: JobRecord | undefined;
        const currentTarget = consumer({
          name: "changed", event: V2, durable: true,
          handle(payload, context: DurableConsumerContext<unknown>) {
            assert.equal(context.job.jobId, persistedJobId);
            assert.deepEqual(payload, { id: "one", label: "upgraded" });
            handled += 1;
          },
        });
        const current = createConsumerRuntime([defineFeature({ name: "deployment", events: [V2], consumers: [currentTarget] })], {
          upcasters: [{ event: V2, from: 1, to: 2, upcast(value) { upgraded += 1; return { ...value as object, label: "upgraded" }; } }],
          authorize({ envelope }) {
            assert.equal(envelope.schemaVersion, 1);
            assert.equal("payload" in envelope, false);
            for (const key of ["tenantId", "actorId", "requestId", "correlationId", "causationId"] as const) {
              assert.equal(envelope[key], appendOptions[key]);
            }
          },
        });
        const executionStore: JobStore = { ...store, async claim(now, lease) { claimed = await store.claim(now, lease); return claimed; } };
        assert.equal(await createWorker({ store: executionStore, handlers: current.handlers }).runOnce(new AbortController().signal), "succeeded");
        assert.equal(handled, 1);
        assert.equal(upgraded, 1);
        assert.equal(claimed?.id, persistedJobId);
        assert.deepEqual((claimed?.payload as { envelope: { payload: unknown } }).envelope.payload, historicalPayload);
        assert.deepEqual((claimed?.payload as { payload: unknown }).payload, { id: "one" });
        assert.equal(await createWorker({ store, handlers: current.handlers }).runOnce(new AbortController().signal), "idle");
      });
    });
    it("uses the original delivery version after replay and reloads authority on retries without repeating effects", async () => {
      await withStore(async (store, db) => {
        const V1 = event({ owner: "deployment", name: "Changed", payload: object({ id: string() }) });
        const V2 = event({ owner: "deployment", name: "Changed", version: 2, payload: object({ id: string(), trail: string() }) });
        const oldTarget = consumer({ name: "changed", event: V2, durable: true, handle: () => undefined });
        let earlyUpcasts = 0;
        const earlyEdge: DurableUpcaster = { event: V2, from: 1, to: 2, upcast(value) { earlyUpcasts += 1; return { ...value as object, trail: "12" }; } };
        const oldRuntime = createConsumerRuntime([defineFeature({ name: "deployment", events: [V2], consumers: [oldTarget] })], { upcasters: [earlyEdge] });
        const appended = await store.appendOutbox(V1, { id: "one" }, appendOptions);
        let originalJobId: string | undefined;
        const dispatchStore: JobStore = { ...store, async materializeFanout(record, targets) {
          const result = await store.materializeFanout(record, targets);
          originalJobId ??= result.receipts.find(({ jobId }) => jobId !== undefined)?.jobId;
          return result;
        } };
        const failingPublisher = { async targets(record: Parameters<ReturnType<typeof oldRuntime.publisher>["targets"]>[0]) {
          return [...await oldRuntime.publisher().targets(record), { kind: "failed" as const, consumerId: "other-consumer", consumerVersion: 2, permanent: true, errorCode: "TEMPORARILY_UNSUPPORTED" }];
        } };
        assert.equal((await dispatchOutbox(dispatchStore, failingPublisher)).quarantined, 1);
        assert.equal(earlyUpcasts, 1);
        assert.ok(originalJobId);

        const V4 = event({ owner: "deployment", name: "Changed", version: 4, payload: object({ id: string(), trail: string() }) });
        let allowed = true;
        let permission = "initial";
        const attempts: number[] = [];
        const contexts: string[] = [];
        let effects = 0;
        let handled = 0;
        const upgradedInputs: string[] = [];
        const target = consumer({ name: "changed", event: V4, durable: true,
          async handle(payload, context: DurableConsumerContext<{ permission: string }>) {
            assert.deepEqual(payload, { id: "one", trail: "1234" });
            assert.equal(context.job.jobId, originalJobId);
            contexts.push(context.application.permission);
            assert.equal(await context.job.effect("deployment-effect", async () => { effects += 1; return { value: "sent" }; }), "sent");
            handled += 1;
            if (handled === 1) throw Object.assign(new Error("retry"), { code: "TRANSIENT" });
          },
        });
        const current = createConsumerRuntime([defineFeature({ name: "deployment", events: [V4], consumers: [target] })], {
          upcasters: [earlyEdge,
            { event: V4, from: 2, to: 3, upcast(value) { const payload = value as { trail: string }; upgradedInputs.push(payload.trail); payload.trail += "3"; return payload; } },
            { event: V4, from: 3, to: 4, upcast(value) { (value as { trail: string }).trail += "4"; return value; } },
          ],
          authorize({ envelope, attempt }) {
            attempts.push(attempt);
            assert.equal(envelope.schemaVersion, 1);
            assert.equal("payload" in envelope, false);
            for (const key of ["tenantId", "actorId", "requestId", "correlationId", "causationId"] as const) assert.equal(envelope[key], appendOptions[key]);
            if (!allowed) throw Object.assign(new Error("denied"), { code: "AUTHORITY_DENIED" });
          },
          context: () => ({ permission }),
        });
        await store.requestOutboxReplay(appended.id, { requestId: "replay", approvedBy: "operator", reason: "new deployment", requestedAt: new Date() });
        assert.equal((await dispatchOutbox(dispatchStore, current.publisher())).published, 1);
        assert.equal(earlyUpcasts, 2); // Replay uses history; execution must not use this edge again.
        upgradedInputs.length = 0;
        const worker = createWorker({ store, handlers: current.handlers, baseBackoffMilliseconds: 0 });
        assert.equal(await worker.runOnce(new AbortController().signal), "retry");
        allowed = false;
        permission = "revoked";
        assert.equal(await worker.runOnce(new AbortController().signal), "retry");
        allowed = true;
        permission = "restored";
        assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
        assert.equal(await worker.runOnce(new AbortController().signal), "idle");
        assert.equal(earlyUpcasts, 2);
        assert.deepEqual(upgradedInputs, ["12", "12", "12"]);
        assert.deepEqual(attempts, [1, 2, 3]);
        assert.deepEqual(contexts, ["initial", "restored"]);
        assert.equal(effects, 1);
        if (db !== undefined) {
          const receipts = await db.selectFrom("tor_outbox_delivery_receipts").select(["consumer_version", "replay_generation", "job_id"]).where("job_id", "=", originalJobId).orderBy("replay_generation").execute();
          assert.deepEqual(receipts, [
            { consumer_version: 2, replay_generation: 0, job_id: originalJobId },
            { consumer_version: 4, replay_generation: 1, job_id: originalJobId },
          ]);
          const job = await db.selectFrom("tor_jobs").select(["payload", "status", "attempts", "replay_generation"]).where("id", "=", originalJobId).executeTakeFirstOrThrow();
          assert.equal(job.status, "succeeded");
          assert.equal(job.attempts, 3);
          assert.equal(job.replay_generation, 0);
          assert.deepEqual((job.payload as { payload: unknown }).payload, { id: "one", trail: "12" });
          assert.deepEqual((job.payload as { envelope: { payload: unknown } }).envelope.payload, { id: "one" });
        }
      });
    });

    for (const fault of ["missing", "ambiguous", "throwing", "invalid", "future", "event", "event-name", "consumer", "job-name", "payload-version", "occurrence", "no-receipt"] as const) {
      it(`terminalizes ${fault} delivery before authority or context, while valid work progresses`, async () => {
        await withStore(async (store) => {
          const V1 = event({ owner: "deployment", name: "Changed", payload: object({ id: string() }) });
          const oldTarget = consumer({ name: "changed", event: V1, durable: true, handle: () => undefined });
          const old = createConsumerRuntime([defineFeature({ name: "deployment", events: [V1], consumers: [oldTarget] })]);
          const original = await store.appendOutbox(V1, { id: "poison" }, appendOptions);
          let materialized: Extract<OutboxFanoutTarget, { kind: "job" }> | undefined;
          const publisher = { async targets(record: Parameters<ReturnType<typeof old.publisher>["targets"]>[0]) {
            const targets = await old.publisher().targets(record);
            const target = targets[0];
            assert.equal(target?.kind, "job");
            if (target?.kind !== "job") throw new Error("missing target");
            const value = structuredClone(target.payload) as { envelope: { eventId: string; eventName: string; occurrenceId: string }; payload: unknown; payloadVersion?: number };
            if (fault === "event") value.envelope.eventId = runtimeRecordId("event", "wrong-owner", "Changed");
            if (fault === "event-name") value.envelope.eventName = "Wrong";
            if (fault === "occurrence") value.envelope.occurrenceId = "wrong";
            if (fault === "invalid") value.payload = { id: 1 };
            if (fault === "payload-version") value.payloadVersion = 2;
            materialized = { ...target, payload: value,
              jobName: fault === "job-name" ? "deployment.wrong" : target.jobName,
              consumerId: fault === "consumer" ? runtimeRecordId("consumer", "wrong-owner", "changed") : target.consumerId,
              consumerVersion: fault === "future" ? 4 : target.consumerVersion,
            };
            return fault === "no-receipt" ? [] : [materialized];
          } };
          assert.equal((await dispatchOutbox(store, publisher)).published, 1);
          assert.ok(materialized);
          if (fault === "no-receipt") await store.enqueue({ name: materialized.jobName, payload: materialized.payload, consumerId: materialized.consumerId, outboxId: original.id, idempotencyKey: "missing-receipt" });

          const V3 = event({ owner: "deployment", name: "Changed", version: 3, payload: object({ id: string() }) });
          let authorized = 0;
          let contexts = 0;
          const handled: string[] = [];
          const target = consumer({ name: "changed", event: V3, durable: true, handle: ({ id }) => { handled.push(id); } });
          const edge: DurableUpcaster = { event: V3, from: 1, to: 2, upcast(value) { if (fault === "throwing") throw new Error("bad migration"); return value; } };
          const current = createConsumerRuntime([defineFeature({ name: "deployment", events: [V3], consumers: [target] })], {
            upcasters: [edge, ...(fault === "ambiguous" ? [edge] : []), ...(fault === "missing" ? [] : [{ event: V3, from: 2, to: 3, upcast: (value: unknown) => value }])],
            authorize: () => { authorized += 1; }, context: () => { contexts += 1; },
          });
          await store.appendOutbox(V3, { id: "valid" }, { ...appendOptions, idempotencyKey: "valid" });
          assert.equal((await dispatchOutbox(store, current.publisher())).published, 1);
          const handler = current.handlers["deployment.changed"];
          assert.ok(handler);
          const worker = createWorker({ store, handlers: { ...current.handlers, "deployment.wrong": handler } });
          const results = [await worker.runOnce(new AbortController().signal), await worker.runOnce(new AbortController().signal)];
          assert.deepEqual(results.sort(), ["dead", "succeeded"]);
          assert.deepEqual(handled, ["valid"]);
          assert.equal(authorized, 1);
          assert.equal(contexts, 1);
          const codes = { missing: "EVENT_UPCASTER_MISSING", ambiguous: "EVENT_UPCASTER_AMBIGUOUS", throwing: "EVENT_UPCAST_FAILED", invalid: "EVENT_PAYLOAD_INVALID", future: "EVENT_VERSION_FROM_FUTURE", event: "DURABLE_EVENT_IDENTITY_MISMATCH", "event-name": "DURABLE_EVENT_IDENTITY_MISMATCH", consumer: "DURABLE_CONSUMER_IDENTITY_MISMATCH", "job-name": "DURABLE_CONSUMER_IDENTITY_MISMATCH", "payload-version": "EVENT_PAYLOAD_VERSION_INVALID", occurrence: "DURABLE_CONSUMER_IDENTITY_MISMATCH", "no-receipt": "EVENT_PAYLOAD_VERSION_INVALID" };
          const dead = await store.deadLetters();
          assert.equal(dead.length, 1);
          assert.equal(dead[0]?.attempts, 1);
          assert.equal(dead[0]?.lastErrorCode, codes[fault]);
        });
      });
    }

    for (const fault of ["unequal-copies", "wrong-version", "wrong-consumer", "unlinked", "ambiguous-link"] as const) {
      it(`rejects a ${fault} scheduled delivery before authorization`, async () => {
        await withStore(async (store) => {
          const V1 = event({ owner: "deployment", name: "Changed", payload: object({ id: string() }) });
          const target = consumer({ name: "changed", event: V1, durable: true, handle: () => assert.fail("invalid schedule ran") });
          let authorized = 0;
          const runtime = createConsumerRuntime([defineFeature({ name: "deployment", events: [V1], consumers: [target] })], { authorize: () => { authorized += 1; } });
          const daily = schedule({ name: "daily", feature: "deployment", target, occurrences: () => [{ occurrence: "one", payload: { id: "one" }, dueAt: at }] });
          const scheduleStore: JobStore = { ...store, async materialize(input) {
            const payload = structuredClone(input.job.payload) as { payload: unknown; payloadVersion?: number };
            // Legacy schedules have no version field; unequal historical copies must not qualify.
            if (fault === "unequal-copies") { delete payload.payloadVersion; payload.payload = { id: "other" }; }
            if (fault === "wrong-version") payload.payloadVersion = 2;
            const job = { ...input.job, payload, ...(fault === "wrong-consumer" ? { consumerId: "wrong" } : {}) };
            if (fault === "unlinked") return store.enqueue(job);
            const result = await store.materialize({ ...input, job });
            if (fault === "ambiguous-link") await store.materialize({ ...input, schedule: "other-schedule", job });
            return result;
          } };
          assert.equal((await runScheduler(scheduleStore, [daily], at)).created, 1);
          assert.equal(await createWorker({ store, handlers: runtime.handlers }).runOnce(new AbortController().signal), "dead");
          assert.equal(authorized, 0);
          assert.equal((await store.deadLetters())[0]?.attempts, 1);
          assert.equal((await store.deadLetters())[0]?.lastErrorCode, fault === "wrong-consumer" ? "DURABLE_CONSUMER_IDENTITY_MISMATCH" : "EVENT_PAYLOAD_VERSION_INVALID");
        });
      });
    }

    for (const legacy of [false, true]) {
      it(`upgrades a ${legacy ? "pre-change" : "current"} persisted schedule without guessing a materialized version`, async () => {
        await withStore(async (store, db) => {
          const V1 = event({ owner: "deployment", name: "Changed", payload: object({ id: string() }) });
          const oldTarget = consumer({ name: "changed", event: V1, durable: true, handle: () => undefined });
          const daily = schedule({ name: "daily", feature: "deployment", target: oldTarget, occurrences: () => [{ occurrence: "one", payload: { id: "one" }, dueAt: at }] });
          let scheduledJobId: string | undefined;
          const scheduleStore: JobStore = { ...store, async materialize(input) {
            // Reproduce the exact pre-change persisted shape, not a guessed version.
            const payload = { ...input.job.payload as Record<string, unknown> };
            const { consumerId: _consumer, ...job } = input.job;
            if (legacy) delete payload.payloadVersion;
            const result = await store.materialize(legacy ? { ...input, job: { ...job, payload } } : input);
            scheduledJobId = result.id;
            return result;
          } };
          assert.equal((await runScheduler(scheduleStore, [daily], at)).created, 1);
          assert.equal((await runScheduler(scheduleStore, [daily], at)).replayed, 1);
          assert.ok(scheduledJobId);
          if (db !== undefined && legacy) {
            const row = await db.selectFrom("tor_jobs").select(["consumer_id", "payload"]).where("id", "=", scheduledJobId).executeTakeFirstOrThrow();
            assert.equal(row.consumer_id, null);
            assert.equal("payloadVersion" in (row.payload as object), false);
          }
          const V2 = event({ owner: "deployment", name: "Changed", version: 2, payload: object({ id: string(), label: string() }) });
          let calls = 0;
          const target = consumer({ name: "changed", event: V2, durable: true, handle(payload, context: DurableConsumerContext<unknown>) {
            assert.deepEqual(payload, { id: "one", label: "scheduled" });
            assert.equal(context.job.jobId, scheduledJobId);
            calls += 1;
          } });
          const current = createConsumerRuntime([defineFeature({ name: "deployment", events: [V2], consumers: [target] })], {
            upcasters: [{ event: V2, from: 1, to: 2, upcast: (value) => ({ ...value as object, label: "scheduled" }) }],
          });
          assert.equal(await createWorker({ store, handlers: current.handlers }).runOnce(new AbortController().signal), "succeeded");
          assert.equal(calls, 1);
        });
      });
    }
  });
}

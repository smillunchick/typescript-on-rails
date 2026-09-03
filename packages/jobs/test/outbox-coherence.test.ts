import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumer, defineFeature, event, object, runtimeRecordId, string } from "typescript-on-rails";

import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  memoryJobStore,
  outboxDeliveryIdempotencyKey,
  type DurableConsumerContext,
  type OutboxRecord,
} from "../src/index.js";

const at = new Date("2026-01-01T00:00:00.000Z");

function appendOptions(idempotencyKey: string) {
  return {
    idempotencyKey,
    occurredAt: at,
    requestId: `request:${idempotencyKey}`,
    correlationId: `correlation:${idempotencyKey}`,
    tenantId: "tenant_one",
    actorId: "actor_one",
  };
}

async function failedTargetCode(value: Promise<readonly { readonly kind: string; readonly errorCode?: string }[]>): Promise<string | undefined> {
  const targets = await value;
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.kind, "failed");
  return targets[0]?.errorCode;
}

describe("coherent durable outbox", () => {
  it("uses owner-qualified event identities and rejects conflicting event ownership", () => {
    const Shared = event({ owner: "left", name: "Changed", version: 2, payload: object({ id: string() }) });
    defineFeature({ name: "left", events: [Shared] });
    assert.equal(Shared.id, runtimeRecordId("event", "left", "Changed"));
    assert.equal(Shared.version, 2);
    assert.throws(() => event({ name: "Invalid", version: 0, payload: object({ id: string() }) }), /EVENT_VERSION_MUST_BE_A_POSITIVE_INTEGER/);
    assert.throws(() => defineFeature({ name: "right", events: [Shared] }), /EVENT_OWNER_CONFLICT/);

    const Unowned = event({ name: "Unowned", payload: object({ id: string() }) });
    const AlreadyOwned = event({ owner: "existing", name: "AlreadyOwned", payload: object({ id: string() }) });
    defineFeature({ name: "existing", events: [AlreadyOwned] });
    assert.throws(
      () => defineFeature({ name: "failed", events: [Unowned, AlreadyOwned] }),
      /EVENT_OWNER_CONFLICT/,
    );
    const recovered = defineFeature({ name: "recovered", events: [Unowned] });
    assert.equal(recovered.events[0], Unowned);
  });

  it("dispatches same-named events by exact identity and supplies separate app and job contexts", async () => {
    const LeftChanged = event({ owner: "left", name: "Changed", version: 2, payload: object({ id: string() }) });
    const RightChanged = event({ owner: "right", name: "Changed", payload: object({ id: string() }) });
    const received: Array<{ id: string; application: unknown; jobId: string; attempt: number }> = [];
    const leftConsumer = consumer({
      name: "projectChanged",
      event: LeftChanged,
      durable: true,
      async handle({ id }, context: DurableConsumerContext<{ readonly source: string }>) {
        received.push({ id, application: context.application, jobId: context.job.jobId, attempt: context.job.attempt });
      },
    });
    const rightConsumer = consumer({ name: "projectChanged", event: RightChanged, durable: true, handle: () => { throw new Error("wrong target"); } });
    const left = defineFeature({ name: "left", events: [LeftChanged], consumers: [leftConsumer] });
    const right = defineFeature({ name: "right", events: [RightChanged], consumers: [rightConsumer] });
    const runtime = createConsumerRuntime([left, right], {
      context: async ({ envelope, attempt }) => ({ source: `${envelope.tenantId}:${attempt}` }),
    });
    const store = memoryJobStore(() => at);
    await assert.rejects(
      store.appendOutbox({ id: "event:left:Changed", name: "Changed", version: 1, parse: (value: unknown) => value }, { id: "invalid" }, appendOptions("invalid-event-id")),
      { code: "DURABLE_EVENT_ID_INVALID" },
    );
    await store.appendOutbox(LeftChanged, { id: "one" }, appendOptions("changed:one"));
    const result = await dispatchOutbox(store, runtime.publisher(), { now: () => at });
    assert.deepEqual(result, { claimed: 1, published: 1, partial: 0, retried: 0, quarantined: 0, fenceLost: 0, cancelled: 0 });
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => at }).runOnce(new AbortController().signal), "succeeded");
    assert.deepEqual(received, [{ id: "one", application: { source: "tenant_one:1" }, jobId: received[0]?.jobId, attempt: 1 }]);
    await store.enqueue({
      name: "left.projectChanged",
      payload: {
        envelope: {
          occurrenceId: "corrupt_occurrence",
          eventId: LeftChanged.id,
          eventName: LeftChanged.name,
          schemaVersion: LeftChanged.version,
          payload: { id: 1 },
          occurredAt: at,
          requestId: "corrupt_request",
          correlationId: "corrupt_correlation",
        },
        payload: { id: 1 },
      },
      idempotencyKey: "corrupt-consumer-payload",
      maximumAttempts: 1,
    });
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => at }).runOnce(new AbortController().signal), "dead");
    assert.equal(received.length, 1);
  });

  it("upcasts a temporary payload and quarantines poison records without blocking valid work", async () => {
    const Changed = event({ owner: "items", name: "Changed", version: 2, payload: object({ id: string(), label: string() }) });
    const seen: unknown[] = [];
    const target = consumer({ name: "changed", event: Changed, durable: true, handle: (payload) => { seen.push(payload); } });
    const feature = defineFeature({ name: "items", events: [Changed], consumers: [target] });
    const runtime = createConsumerRuntime([feature], {
      upcasters: [{ event: Changed, from: 1, to: 2, upcast: (value) => { (value as { label?: string }).label = "historic"; return value; } }],
    });
    const store = memoryJobStore(() => at);
    const historicPayload = { id: "old" };
    await store.appendOutbox({ ...Changed, version: 1, parse: (value: unknown) => value as { id: string } }, historicPayload, appendOptions("old"));
    historicPayload.id = "changed-after-append";
    await store.appendOutbox({ id: runtimeRecordId("event", "missing", "Changed"), name: "Changed", version: 1, parse: (value: unknown) => value as { id: string } }, { id: "poison" }, appendOptions("poison"));
    const result = await dispatchOutbox(store, runtime.publisher(), { now: () => at, limit: 2 });
    assert.equal(result.published, 1);
    assert.equal(result.quarantined, 1);
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => at }).runOnce(new AbortController().signal), "succeeded");
    assert.deepEqual(seen, [{ id: "old", label: "historic" }]);
    const quarantined = await store.quarantinedOutbox();
    assert.equal(quarantined[0]?.payload instanceof Object, true);
    assert.equal(quarantined[0]?.quarantineReason, "EVENT_NOT_REGISTERED");
  });

  it("reloads current authority on each attempt and denies protected work before the handler", async () => {
    const Changed = event({ owner: "protected", name: "Changed", payload: object({ id: string() }) });
    let authorityChecks = 0;
    let handled = 0;
    const target = consumer({ name: "protected", event: Changed, durable: true, handle: () => { handled += 1; } });
    const feature = defineFeature({ name: "protected", events: [Changed], consumers: [target] });
    const runtime = createConsumerRuntime([feature], {
      authorize: ({ envelope, attempt }) => {
        authorityChecks += 1;
        assert.equal(envelope.tenantId, "tenant_one");
        assert.equal(attempt, 1);
        throw Object.assign(new Error("denied"), { code: "AUTHORITY_DENIED" });
      },
    });
    const store = memoryJobStore(() => at);
    await store.appendOutbox(Changed, { id: "one" }, appendOptions("protected"));
    assert.equal((await dispatchOutbox(store, runtime.publisher(), { now: () => at })).published, 1);
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => at }).runOnce(new AbortController().signal), "retry");
    assert.equal(authorityChecks, 1);
    assert.equal(handled, 0);
  });

  it("rejects competing or non-adjacent upcasters at construction", () => {
    const Changed = event({ owner: "upcast-validation", name: "Changed", version: 2, payload: object({ id: string() }) });
    const target = consumer({ name: "changed", event: Changed, durable: true, handle: () => undefined });
    const feature = defineFeature({ name: "upcast-validation", events: [Changed], consumers: [target] });
    assert.throws(() => createConsumerRuntime([feature], { upcasters: [{ event: Changed, from: 1, to: 3, upcast: (value) => value }] }), /UPCASTER_MUST_BE_ADJACENT/);
    assert.throws(() => createConsumerRuntime([feature], { upcasters: [
      { event: Changed, from: 1, to: 2, upcast: (value) => value },
      { event: Changed, from: 1, to: 2, upcast: (value) => value },
    ] }), /DUPLICATE_UPCASTER_EDGE/);
  });

  it("fails closed for every unsupported or malformed historic payload", async () => {
    const Changed = event({ owner: "payload-errors", name: "Changed", version: 2, payload: object({ id: string(), label: string() }) });
    const target = consumer({ name: "changed", event: Changed, durable: true, handle: () => undefined });
    const feature = defineFeature({ name: "payload-errors", events: [Changed], consumers: [target] });
    const withoutUpcaster = createConsumerRuntime([feature]).publisher();
    const throwingUpcaster = createConsumerRuntime([feature], {
      upcasters: [{ event: Changed, from: 1, to: 2, upcast: () => { throw new Error("bad historic payload"); } }],
    }).publisher();
    const record: OutboxRecord = {
      id: "outbox_payload_errors",
      occurrenceId: "outbox_payload_errors",
      eventId: Changed.id,
      eventName: Changed.name,
      schemaVersion: 2,
      event: Changed.name,
      version: 2,
      payload: { id: "one", label: "current" },
      occurredAt: at,
      requestId: "request_payload_errors",
      correlationId: "correlation_payload_errors",
      idempotencyKey: "payload-errors",
      state: "claimed",
      attempts: 1,
      maximumAttempts: 5,
      availableAt: at,
      replayGeneration: 0,
      leaseToken: "lease",
      leaseExpiresAt: new Date(at.getTime() + 1_000),
    };
    assert.equal(await failedTargetCode(withoutUpcaster.targets({ ...record, schemaVersion: 3, version: 3 })), "EVENT_VERSION_FROM_FUTURE");
    assert.equal(await failedTargetCode(withoutUpcaster.targets({ ...record, schemaVersion: 1, version: 1, payload: { id: "old" } })), "EVENT_UPCASTER_MISSING");
    assert.equal(await failedTargetCode(withoutUpcaster.targets({ ...record, payload: { id: "missing-label" } })), "EVENT_PAYLOAD_INVALID");
    assert.equal(await failedTargetCode(withoutUpcaster.targets({ ...record, payload: { id: "one", label: "current", invalid: () => undefined } })), "EVENT_PAYLOAD_NOT_CLONEABLE");
    assert.equal(await failedTargetCode(throwingUpcaster.targets({ ...record, schemaVersion: 1, version: 1, payload: { id: "old" } })), "EVENT_UPCAST_FAILED");
  });

  it("claims one record at a time, retries transient failures, and keeps unrelated progress", async () => {
    const Changed = event({ owner: "items", name: "Changed", payload: object({ id: string() }) });
    const target = consumer({ name: "changed", event: Changed, durable: true, handle: () => undefined });
    const feature = defineFeature({ name: "items", events: [Changed], consumers: [target] });
    const runtime = createConsumerRuntime([feature]);
    const store = memoryJobStore(() => at);
    await store.appendOutbox(Changed, { id: "one" }, appendOptions("one"));
    await store.appendOutbox(Changed, { id: "two" }, appendOptions("two"));
    let calls = 0;
    const publisher = {
      async targets(record: OutboxRecord) {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("temporary"), { code: "TRANSIENT" });
        return runtime.publisher().targets(record);
      },
    };
    const result = await dispatchOutbox(store, publisher, { now: () => at, limit: 2, jitter: () => 0 });
    assert.equal(result.retried, 1);
    assert.equal(result.published, 1);
    assert.equal(await store.claimOutbox(at, 100), undefined);
    assert.ok(await store.claimOutbox(new Date(at.getTime() + 1_000), 100));
  });

  it("keeps successful receipts and quarantines a deterministic target conflict", async () => {
    const Changed = event({ owner: "partial", name: "Changed", payload: object({ id: string() }) });
    const first = consumer({ name: "first", event: Changed, durable: true, handle: () => undefined });
    const second = consumer({ name: "second", event: Changed, durable: true, handle: () => undefined });
    const feature = defineFeature({ name: "partial", events: [Changed], consumers: [first, second] });
    const runtime = createConsumerRuntime([feature]);
    const store = memoryJobStore(() => at);
    const appended = await store.appendOutbox(Changed, { id: "one" }, appendOptions("partial"));
    const firstId = runtimeRecordId("consumer", "partial", "first");
    await store.enqueue({ name: "conflict", payload: { changed: true }, idempotencyKey: outboxDeliveryIdempotencyKey(appended.id, firstId) });
    const claimed = await store.claimOutbox(at, 1_000);
    assert.ok(claimed?.leaseToken);
    const snapshot = await store.materializeFanout(claimed, await runtime.publisher().targets(claimed));
    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.succeeded, 1);
    assert.equal(snapshot.failed, 1);
    assert.equal(snapshot.permanentFailed, 1);
    assert.equal(await store.settleOutbox(claimed.id, claimed.leaseToken, { kind: "quarantine", at, reason: "JOB_IDEMPOTENCY_CONFLICT" }), true);
    assert.equal((await store.quarantinedOutbox())[0]?.quarantineReason, "JOB_IDEMPOTENCY_CONFLICT");
  });

  it("retries a transient target receipt without duplicating successful targets", async () => {
    let now = at;
    const store = memoryJobStore(() => now);
    const Event = {
      id: runtimeRecordId("event", "transient-target", "Changed"),
      name: "Changed",
      version: 1,
      parse: (value: unknown) => value,
    };
    await store.appendOutbox(Event, { id: "one" }, appendOptions("transient-target"));
    const successfulId = runtimeRecordId("consumer", "transient-target", "successful");
    const recoveringId = runtimeRecordId("consumer", "transient-target", "recovering");
    let attempts = 0;
    const publisher = {
      async targets() {
        attempts += 1;
        return Object.freeze([
          { kind: "job" as const, consumerId: successfulId, consumerVersion: 1, jobName: "transient.successful", payload: { id: "one" } },
          attempts === 1
            ? { kind: "failed" as const, consumerId: recoveringId, consumerVersion: 1, errorCode: "TARGET_TEMPORARY", permanent: false }
            : { kind: "job" as const, consumerId: recoveringId, consumerVersion: 1, jobName: "transient.recovering", payload: { id: "one" } },
        ]);
      },
    };
    const partial = await dispatchOutbox(store, publisher, { now: () => now, jitter: () => 0 });
    assert.equal(partial.partial, 1);
    now = new Date(at.getTime() + 1_000);
    const recovered = await dispatchOutbox(store, publisher, { now: () => now, jitter: () => 0 });
    assert.equal(recovered.published, 1);
    assert.equal(await createWorker({ store, handlers: { "transient.successful": () => undefined, "transient.recovering": () => undefined }, now: () => now }).runOnce(new AbortController().signal), "succeeded");
    assert.equal(await createWorker({ store, handlers: { "transient.successful": () => undefined, "transient.recovering": () => undefined }, now: () => now }).runOnce(new AbortController().signal), "succeeded");
    assert.equal(await createWorker({ store, handlers: { "transient.successful": () => undefined, "transient.recovering": () => undefined }, now: () => now }).runOnce(new AbortController().signal), "idle");
  });

  it("keeps valid target work when another target fails permanently", async () => {
    const Changed = event({ owner: "mixed-targets", name: "Changed", payload: object({ id: string() }) });
    let handled = 0;
    const valid = consumer({ name: "valid", event: Changed, durable: true, handle: () => { handled += 1; } });
    const feature = defineFeature({ name: "mixed-targets", events: [Changed], consumers: [valid] });
    const runtime = createConsumerRuntime([feature]);
    const store = memoryJobStore(() => at);
    await store.appendOutbox(Changed, { id: "one" }, appendOptions("mixed-targets"));
    const publisher = {
      async targets(record: OutboxRecord) {
        return Object.freeze([
          ...await runtime.publisher().targets(record),
          Object.freeze({
            kind: "failed" as const,
            consumerId: runtimeRecordId("consumer", "mixed-targets", "invalid"),
            consumerVersion: 1,
            errorCode: "EVENT_UPCASTER_MISSING",
            permanent: true,
          }),
        ]);
      },
    };
    const outcome = await dispatchOutbox(store, publisher, { now: () => at });
    assert.equal(outcome.quarantined, 1);
    assert.equal(await createWorker({ store, handlers: runtime.handlers, now: () => at }).runOnce(new AbortController().signal), "succeeded");
    assert.equal(handled, 1);
  });

  it("quarantines exhaustion, accepts accountable replay once, and keeps append-only history", async () => {
    let now = at;
    const store = memoryJobStore(() => now);
    const Unknown = {
      id: runtimeRecordId("event", "missing", "Unknown"),
      name: "Unknown",
      version: 1,
      parse: (value: unknown) => value,
    };
    const appended = await store.appendOutbox(Unknown, { original: true }, { ...appendOptions("unknown-replay"), maximumAttempts: 1 });
    const publisher = { targets: async () => { throw Object.assign(new Error("temporary"), { code: "TRANSIENT" }); } };
    const exhausted = await dispatchOutbox(store, publisher, { now: () => now, jitter: () => 0 });
    assert.equal(exhausted.quarantined, 1);
    assert.equal((await store.quarantinedOutbox())[0]?.quarantineReason, "EXHAUSTED");
    const replay = { requestId: "replay_one", approvedBy: "operator_one", reason: "provider-restored", requestedAt: now };
    assert.deepEqual(await store.requestOutboxReplay(appended.id, replay), { replayed: false });
    assert.deepEqual(await store.requestOutboxReplay(appended.id, replay), { replayed: true });
    await assert.rejects(
      store.requestOutboxReplay(appended.id, { ...replay, reason: "different-reason" }),
      /REPLAY_REQUEST_CONFLICT/,
    );
    const failedReplay = await dispatchOutbox(store, publisher, { now: () => now, jitter: () => 0 });
    assert.equal(failedReplay.quarantined, 1);
    const secondReplay = { requestId: "replay_two", approvedBy: "operator_two", reason: "use-corrected-publisher", requestedAt: now };
    assert.deepEqual(await store.requestOutboxReplay(appended.id, secondReplay), { replayed: false });
    assert.equal((await dispatchOutbox(store, { targets: async () => [] }, { now: () => now })).published, 1);
    const history = await store.outboxHistory(appended.id);
    assert.deepEqual(history.map(({ kind }) => kind), ["appended", "claimed", "quarantined", "replay_requested", "claimed", "quarantined", "replay_requested", "claimed", "published"]);
    assert.equal(history.find(({ kind }) => kind === "replay_requested")?.actorId, "operator_one");
    const latest = await store.outboxHistory(appended.id, { limit: 2 });
    assert.deepEqual(latest.map(({ kind }) => kind), ["claimed", "published"]);
    assert.ok(latest[0]);
    assert.deepEqual((await store.outboxHistory(appended.id, { limit: 2, beforeSequence: latest[0].sequence })).map(({ kind }) => kind), ["quarantined", "replay_requested"]);
  });

  it("copies durable times, validates replay approval, and fences same-name exact identities", async () => {
    let now = at;
    const store = memoryJobStore(() => now);
    const First = {
      id: runtimeRecordId("event", "first-owner", "Shared"),
      name: "Shared",
      version: 1,
      parse: (value: unknown) => value,
    };
    const Second = { ...First, id: runtimeRecordId("event", "second-owner", "Shared") };
    const occurredAt = new Date(at);
    const first = await store.appendOutbox(First, { original: true }, {
      ...appendOptions("immutable-time"),
      occurredAt,
      maximumAttempts: 1,
    });
    occurredAt.setUTCFullYear(2030);
    const claimed = await store.claimOutbox(now, 100);
    assert.equal(claimed?.id, first.id);
    assert.equal(claimed.occurredAt.toISOString(), at.toISOString());
    claimed.occurredAt.setUTCFullYear(2040);
    claimed.availableAt.setUTCFullYear(2040);
    assert.ok(claimed.leaseToken);
    assert.equal(await store.settleOutbox(claimed.id, claimed.leaseToken, { kind: "quarantine", at: now, reason: "TEST" }), true);
    assert.equal((await store.quarantinedOutbox())[0]?.occurredAt.toISOString(), at.toISOString());

    await assert.rejects(
      store.requestOutboxReplay(first.id, { requestId: "", approvedBy: "operator", reason: "reason", requestedAt: now }),
      { code: "REPLAY_REQUEST_ID_INVALID" },
    );
    await assert.rejects(
      store.requestOutboxReplay(first.id, { requestId: "valid", approvedBy: "", reason: "reason", requestedAt: now }),
      { code: "REPLAY_APPROVER_INVALID" },
    );
    await assert.rejects(
      store.requestOutboxReplay(first.id, { requestId: "valid", approvedBy: "operator", reason: "", requestedAt: now }),
      { code: "REPLAY_REASON_INVALID" },
    );
    await assert.rejects(
      store.requestOutboxReplay(first.id, { requestId: "valid", approvedBy: "operator", reason: "reason", requestedAt: new Date(Number.NaN) }),
      { code: "REPLAY_REQUESTED_AT_INVALID" },
    );
    const requestedAt = new Date(now);
    assert.deepEqual(await store.requestOutboxReplay(first.id, {
      requestId: "valid",
      approvedBy: "operator",
      reason: "r".repeat(300),
      requestedAt,
    }), { replayed: false });
    requestedAt.setUTCFullYear(2050);
    const replayed = await store.claimOutbox(now, 100);
    assert.equal(replayed?.id, first.id);

    await store.appendOutbox(Second, { original: true }, appendOptions("same-name-second"));
    await assert.rejects(store.assertOutboxCapability("name-only"), /NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN/);
  });

  it("settles a claim released by cancellation and replays a permanent target conflict", async () => {
    const Changed = event({ owner: "cancel-partial", name: "Changed", payload: object({ id: string() }) });
    const first = consumer({ name: "first", event: Changed, durable: true, handle: () => undefined });
    const feature = defineFeature({ name: "cancel-partial", events: [Changed], consumers: [first] });
    const runtime = createConsumerRuntime([feature]);
    const base = memoryJobStore(() => at);
    const cancelRecord = await base.appendOutbox(Changed, { id: "cancel" }, appendOptions("cancel-after-claim"));
    const controller = new AbortController();
    const cancelling: typeof base = {
      ...base,
      async claimOutbox(now, leaseMilliseconds) {
        const record = await base.claimOutbox(now, leaseMilliseconds);
        if (record !== undefined) controller.abort();
        return record;
      },
    };
    const cancelled = await dispatchOutbox(cancelling, runtime.publisher(), { now: () => at, signal: controller.signal });
    assert.equal(cancelled.cancelled, 1);
    assert.deepEqual((await base.outboxHistory(cancelRecord.id)).map(({ kind }) => kind), ["appended", "claimed", "retry_scheduled"]);

    const partialStore = memoryJobStore(() => at);
    const appended = await partialStore.appendOutbox(Changed, { id: "partial" }, {
      ...appendOptions("partial-exhaustion"),
      maximumAttempts: 1,
    });
    const consumerId = runtimeRecordId("consumer", "cancel-partial", "first");
    await partialStore.enqueue({
      name: "conflict",
      payload: { conflict: true },
      idempotencyKey: outboxDeliveryIdempotencyKey(appended.id, consumerId),
    });
    const outcome = await dispatchOutbox(partialStore, runtime.publisher(), { now: () => at, jitter: () => 0 });
    assert.equal(outcome.quarantined, 1);
    assert.equal((await partialStore.quarantinedOutbox())[0]?.quarantineReason, "JOB_IDEMPOTENCY_CONFLICT");
    assert.deepEqual(await partialStore.requestOutboxReplay(appended.id, {
      requestId: "partial-replay",
      approvedBy: "operator",
      reason: "retry-with-new-generation",
      requestedAt: at,
    }), { replayed: false });
    const replayed = await dispatchOutbox(partialStore, runtime.publisher(), { now: () => at, jitter: () => 0 });
    assert.equal(replayed.published, 1);
    assert.deepEqual((await partialStore.outboxHistory(appended.id)).map(({ kind }) => kind), [
      "appended",
      "claimed",
      "quarantined",
      "replay_requested",
      "claimed",
      "published",
    ]);
  });

  it("stops new claims on cancellation and enforces migration rollback fences", async () => {
    const store = memoryJobStore(() => at);
    const controller = new AbortController();
    controller.abort();
    const result = await dispatchOutbox(store, { targets: async () => [] }, { signal: controller.signal });
    assert.equal(result.cancelled, 1);
    await assert.rejects(dispatchOutbox(store, { targets: async () => [] }, { limit: 0 }), /OUTBOX_DISPATCH_LIMIT_INVALID/);
    await assert.rejects(dispatchOutbox(store, { targets: async () => [] }, { baseBackoffMilliseconds: 10, maximumBackoffMilliseconds: 1 }), /OUTBOX_DISPATCH_BACKOFF_INVALID/);
    const migrationStore = memoryJobStore(() => at, {
      legacyOutbox: [
        { id: "legacy_known", eventName: "Known", schemaVersion: 1, payload: { original: "known" }, idempotencyKey: "legacy:known", createdAt: at },
        { id: "legacy_unknown", eventName: "Unknown", schemaVersion: 1, payload: { original: "unknown" }, idempotencyKey: "legacy:unknown", createdAt: at },
        { id: "legacy_ambiguous", eventName: "Ambiguous", schemaVersion: 1, payload: { original: "ambiguous" }, idempotencyKey: "legacy:ambiguous", createdAt: at },
      ],
    });
    assert.equal((await migrationStore.readMigrationState()).state, "Expanded");
    assert.equal(await migrationStore.claimOutbox(at, 100), undefined);
    assert.equal(await migrationStore.transitionMigrationState("Expanded", "Cutover"), false);
    assert.equal(await migrationStore.transitionMigrationState("Expanded", "Dual-write"), true);
    assert.equal(await migrationStore.transitionMigrationState("Dual-write", "Reconciling"), true);
    assert.equal(await migrationStore.transitionMigrationState("Reconciling", "Cutover"), false);
    const candidates = [
      { eventName: "Known", eventId: "rid1/event/known/Known" },
      { eventName: "Ambiguous", eventId: "rid1/event/left/Ambiguous" },
      { eventName: "Ambiguous", eventId: "rid1/event/right/Ambiguous" },
    ];
    const totals = { resolved: 0, unknown: 0, ambiguous: 0 };
    for (let index = 0; index < 3; index += 1) {
      const batch = await migrationStore.reconcileLegacyOutbox(candidates, 1);
      totals.resolved += batch.resolved;
      totals.unknown += batch.unknown;
      totals.ambiguous += batch.ambiguous;
    }
    assert.deepEqual(totals, { resolved: 1, unknown: 1, ambiguous: 1 });
    const resolvedLegacy = await migrationStore.claimOutbox(at, 100);
    assert.equal(resolvedLegacy?.id, "legacy_known");
    assert.ok(resolvedLegacy.leaseToken);
    assert.equal(await migrationStore.settleOutbox(resolvedLegacy.id, resolvedLegacy.leaseToken, { kind: "published", at }), true);
    await assert.rejects(
      migrationStore.reconcileLegacyOutbox([{ eventName: "Known", eventId: "rid1/event/changed/Known" }]),
      /JOBS_RECONCILIATION_GRAPH_CHANGED/,
    );
    assert.deepEqual((await migrationStore.quarantinedOutbox()).map(({ id }) => id).sort(), ["legacy_ambiguous", "legacy_unknown"]);
    assert.equal((await migrationStore.quarantinedOutbox()).find(({ id }) => id === "legacy_unknown")?.payload instanceof Object, true);
    assert.equal(await migrationStore.transitionMigrationState("Reconciling", "Cutover"), true);
    await assert.rejects(migrationStore.assertOutboxCapability("name-only"), /NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN/);
    await migrationStore.assertOutboxCapability("exact");
  });
});

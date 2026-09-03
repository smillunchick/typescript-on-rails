import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  consumer,
  defineApp,
  defineFeature,
  entrypoint,
  event,
  object,
  runtimeBinding,
  runtimeRecordId,
  schedule,
  string,
} from "../src/index.js";

describe("registered schedules", () => {
  it("links a feature schedule to its exact durable target and scheduler entrypoint", () => {
    const Due = event({ owner: "billing", name: "InvoiceDue", payload: object({ invoiceId: string() }) });
    const collect = consumer({ name: "collect", event: Due, durable: true, handle: () => undefined });
    const daily = schedule({
      name: "daily-collection",
      feature: "billing",
      target: collect,
      occurrences: (now) => [{ occurrence: now.toISOString().slice(0, 10), payload: { invoiceId: "invoice_1" }, dueAt: now }],
    });
    const application = defineApp({
      features: [defineFeature({ name: "billing", events: [Due], consumers: [collect], schedules: [daily] })],
      entrypoints: {
        worker: entrypoint({ name: "worker", process: "worker", bindings: [runtimeBinding({ name: "billing.collect", protocol: "jobs.consumer/v1", process: "worker", target: collect })], run: () => undefined }),
        scheduler: entrypoint({ name: "scheduler", process: "scheduler", bindings: [runtimeBinding({ name: "billing.daily-collection", protocol: "jobs.schedule/v1", process: "scheduler", target: daily })], run: () => undefined }),
      },
    });
    assert.equal(application.graph.schedules[0]?.definition, daily);
    assert.deepEqual(application.graph.links, [
      { kind: "consumer-event", from: runtimeRecordId("consumer", "billing", "collect"), to: runtimeRecordId("event", "billing", "InvoiceDue") },
      { kind: "entrypoint-consumer", from: runtimeRecordId("entrypoint", "application", "worker"), to: runtimeRecordId("consumer", "billing", "collect"), protocol: "jobs.consumer/v1" },
      { kind: "entrypoint-schedule", from: runtimeRecordId("entrypoint", "application", "scheduler"), to: runtimeRecordId("schedule", "billing", "daily-collection"), protocol: "jobs.schedule/v1" },
      { kind: "schedule-consumer", from: runtimeRecordId("schedule", "billing", "daily-collection"), to: runtimeRecordId("consumer", "billing", "collect"), protocol: "jobs.schedule/v1" },
    ]);
    assert.equal(Object.isFrozen(daily), true);
    assert.equal(Object.isFrozen(daily.metadata), true);
    assert.equal(Object.isFrozen(application.graph.schedules[0]), true);
  });

  it("rejects duplicate, unregistered, and cross-owner schedule targets", () => {
    const BillingDue = event({ owner: "billing", name: "BillingDue", payload: object({ id: string() }) });
    const billingTarget = consumer({ name: "target", event: BillingDue, durable: true, handle: () => undefined });
    const first = schedule({ name: "daily", feature: "billing", target: billingTarget, occurrences: () => [] });
    const second = schedule({ name: "daily", feature: "billing", target: billingTarget, occurrences: () => [] });
    const volatileTarget = consumer({ name: "volatile", event: BillingDue, handle: () => undefined });
    assert.throws(() => schedule({ name: "volatile", feature: "billing", target: volatileTarget, occurrences: () => [] }), /SCHEDULE_TARGET_NOT_DURABLE/);
    assert.throws(() => schedule({ name: "invalid", feature: "billing", target: billingTarget, occurrences: undefined as never }), /SCHEDULE_OCCURRENCES_INVALID/);
    assert.throws(() => defineFeature({ name: "billing", schedules: [first, second] }), /DUPLICATE_SCHEDULE/);
    assert.throws(() => defineApp({ features: [defineFeature({ name: "billing", schedules: [first] })] }), /UNREGISTERED_SCHEDULE_TARGET/);

    const OtherDue = event({ owner: "other", name: "OtherDue", payload: object({ id: string() }) });
    const otherTarget = consumer({ name: "other", event: OtherDue, durable: true, handle: () => undefined });
    assert.throws(
      () => schedule({ name: "wrong", feature: "billing", target: otherTarget, occurrences: () => [] }),
      /SCHEDULE_EVENT_OWNER_CONFLICT/,
    );

    const CrossOwnerDue = event({ name: "CrossOwnerDue", payload: object({ id: string() }) });
    const crossOwnerTarget = consumer({ name: "cross-owner", event: CrossOwnerDue, durable: true, handle: () => undefined });
    const wrong = schedule({ name: "wrong", feature: "billing", target: crossOwnerTarget, occurrences: () => [] });
    assert.throws(() => defineApp({ features: [
      defineFeature({ name: "billing", schedules: [wrong] }),
      defineFeature({ name: "other", events: [CrossOwnerDue], consumers: [crossOwnerTarget] }),
    ] }), /CROSS_OWNER_SCHEDULE_TARGET/);
    const Unowned = event({ name: "Unowned", payload: object({ id: string() }) });
    const unownedTarget = consumer({ name: "unowned", event: Unowned, durable: true, handle: () => undefined });
    const unownedSchedule = schedule({ name: "unowned", feature: "billing", target: unownedTarget, occurrences: () => [] });
    assert.throws(() => defineApp({ features: [
      defineFeature({ name: "billing", consumers: [unownedTarget], schedules: [unownedSchedule] }),
      defineFeature({ name: "other", events: [Unowned] }),
    ] }), /CROSS_OWNER_SCHEDULE_EVENT/);
  });
});

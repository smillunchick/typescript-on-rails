import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidInput, Unexpected, adaptSchema, createEventBus, event, object, string } from "../src/index.js";

describe("events", () => {
  const UserCreated = event({
    name: "UserCreated",
    payload: object({ userId: string() }),
  });

  it("validates and delivers events in subscription order", async () => {
    const bus = createEventBus();
    const received: string[] = [];
    bus.on(UserCreated, ({ userId }) => {
      received.push(`first:${userId}`);
    });
    bus.on(UserCreated, async ({ userId }) => {
      await Promise.resolve();
      received.push(`second:${userId}`);
    });

    await bus.emit(UserCreated, { userId: "u1" });
    assert.deepEqual(received, ["first:u1", "second:u1"]);
  });

  it("keeps subscriptions instance-local and supports unsubscribe", async () => {
    const first = createEventBus();
    const second = createEventBus();
    let calls = 0;
    const unsubscribe = first.on(UserCreated, () => {
      calls += 1;
    });

    await second.emit(UserCreated, { userId: "u1" });
    unsubscribe();
    await first.emit(UserCreated, { userId: "u1" });
    assert.equal(calls, 0);
  });

  it("rejects invalid payloads before delivery", async () => {
    const bus = createEventBus();
    let called = false;
    bus.on(UserCreated, () => {
      called = true;
    });

    await assert.rejects(
      // @ts-expect-error Exercise runtime validation for an untyped event producer.
      () => bus.emit(UserCreated, { userId: 1 }),
      InvalidInput,
    );
    assert.equal(called, false);
  });

  it("parses once at emit and once for each subscriber", async () => {
    let parseCalls = 0;
    const payload = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (value: unknown) => {
        parseCalls += 1;
        return { success: true as const, value: String(value) };
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    const Counted = event({ name: "Counted", payload });
    const bus = createEventBus();

    await bus.emit(Counted, "unobserved");
    assert.equal(parseCalls, 1);

    const received: string[] = [];
    bus.on(Counted, (value) => { received.push(`first:${value}`); });
    bus.on(Counted, (value) => { received.push(`second:${value}`); });
    await bus.emit(Counted, "observed");
    assert.equal(parseCalls, 4);
    assert.deepEqual(received, ["first:observed", "second:observed"]);
  });

  it("normalizes adapted payloads and rejects thenables before subscribers run", async () => {
    const adaptedPayload = adaptSchema({
      metadata: { kind: "object", fields: { userId: { kind: "id", entity: "User" } } } as const,
      parse: (value: unknown) => typeof (value as { userId?: unknown })?.userId === "string"
        ? { success: true as const, value: value as { userId: string } }
        : { success: false as const, error: value },
      mapError: () => [{ path: ["userId"], code: "invalid_type", expected: "string", received: "number" }],
    });
    const Adapted = event({ name: "Adapted", payload: adaptedPayload });
    const bus = createEventBus();
    const received: string[] = [];
    bus.on(Adapted, ({ userId }) => {
      received.push(userId);
    });

    await bus.emit(Adapted, { userId: "u1" });
    assert.deepEqual(received, ["u1"]);
    assert.deepEqual(Adapted.metadata.payload, adaptedPayload.metadata);

    const asynchronous = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => Promise.resolve({ success: true as const, value: "late" })) as unknown as () => { readonly success: true; readonly value: string },
      mapError: () => [{ code: "invalid_value" }],
    });
    const Async = event({ name: "Async", payload: asynchronous });
    let calls = 0;
    bus.on(Async, () => { calls += 1; });
    await assert.rejects(() => bus.emit(Async, "value"), Unexpected);
    assert.equal(calls, 0);
  });

  it("attempts every subscriber and aggregates delivery failures", async () => {
    const bus = createEventBus();
    const received: string[] = [];
    bus.on(UserCreated, () => {
      throw new Error("first subscriber failed");
    });
    bus.on(UserCreated, ({ userId }) => {
      received.push(userId);
    });

    await assert.rejects(
      () => bus.emit(UserCreated, { userId: "u1" }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /UserCreated/);
        assert.equal(error.errors[0]?.message, "first subscriber failed");
        return true;
      },
    );
    assert.deepEqual(received, ["u1"]);
  });
});

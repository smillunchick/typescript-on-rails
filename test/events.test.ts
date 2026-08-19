import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InvalidInput, createEventBus, event, object, string } from "../src/index.js";

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

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidInput,
  boolean,
  defineAdapterContract,
  defineApp,
  implementAdapter,
  object,
  string,
} from "../src/index.js";

describe("adapters and app configuration", () => {
  const Email = defineAdapterContract({
    name: "Email",
    operations: {
      send: {
        input: object({ to: string(), body: string() }),
        output: boolean(),
      },
    },
  });

  it("retains typed implementations and serializable contract metadata", async () => {
    const memoryEmail = implementAdapter(Email, {
      send: ({ to, body }) => Promise.resolve(to.length > 0 && body.length > 0),
    });

    assert.equal(await memoryEmail.operations.send({ to: "a@example.com", body: "Hi" }), true);
    assert.deepEqual(memoryEmail.metadata, {
      kind: "adapter",
      name: "Email",
      operations: {
        send: {
          input: Email.operations.send.input.metadata,
          output: Email.operations.send.output.metadata,
        },
      },
    });
  });

  it("enforces contract schemas and supports concurrent first use", async () => {
    let invalidInputCalls = 0;
    const validatedEmail = implementAdapter(Email, {
      send: () => {
        invalidInputCalls += 1;
        return true;
      },
    });
    await assert.rejects(
      // @ts-expect-error Exercise input validation for an untyped adapter caller.
      async () => validatedEmail.operations.send({ to: "a@example.com" }),
      InvalidInput,
    );
    assert.equal(invalidInputCalls, 0);

    let concurrentCalls = 0;
    let releaseGate = (): void => {
      throw new Error("Adapter gate was not initialized");
    };
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const concurrentEmail = implementAdapter(Email, {
      send: async ({ to, body }) => {
        concurrentCalls += 1;
        await gate;
        return to.length > 0 && body.length > 0;
      },
    });
    const first = concurrentEmail.operations.send({ to: "a@example.com", body: "One" });
    const second = concurrentEmail.operations.send({ to: "b@example.com", body: "Two" });
    assert.equal(concurrentCalls, 2);
    releaseGate();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);

    assert.throws(
      // @ts-expect-error Exercise the runtime guard for an untyped adapter implementation.
      () => implementAdapter(Email, {}),
      /Adapter Email must implement operation send/,
    );

    const invalidOutput = implementAdapter(Email, {
      // @ts-expect-error Exercise output validation for an untyped adapter implementation.
      send: () => "accepted",
    });
    await assert.rejects(
      async () => invalidOutput.operations.send({ to: "a@example.com", body: "Hi" }),
      InvalidInput,
    );
  });

  it("preserves explicit adapter configuration in an app", () => {
    const email = implementAdapter(Email, { send: () => true });
    const app = defineApp({ adapters: { email } });

    assert.equal(app.adapters.email, email);
    assert.deepEqual(app.metadata, {
      kind: "app",
      adapters: { email: "Email" },
    });
  });
});

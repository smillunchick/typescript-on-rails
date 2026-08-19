import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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

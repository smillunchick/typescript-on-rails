import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Conflict,
  Forbidden,
  InvalidInput,
  Unexpected,
  action,
  number,
  object,
  query,
  route,
  string,
  type ExecutionContext,
} from "../src/index.js";

const anonymous: ExecutionContext = { permissions: new Set() };

describe("actions, queries, and routes", () => {
  it("validates input and output for a public action", async () => {
    const double = action({
      input: object({ value: number() }),
      output: number(),
      public: true,
      run: ({ value }) => value * 2,
    });

    assert.equal(await double.execute({ value: 3 }, anonymous), 6);
    await assert.rejects(() => double.execute({ value: "3" }, anonymous), InvalidInput);
  });

  it("enforces permission access", async () => {
    const secret = query({
      input: object({ key: string() }),
      permission: "secret.read",
      run: ({ key }) => `value:${key}`,
    });

    await assert.rejects(() => secret.execute({ key: "a" }, anonymous), Forbidden);
    assert.equal(
      await secret.execute({ key: "a" }, { permissions: new Set(["secret.read"]) }),
      "value:a",
    );
  });

  it("supports contextual authorization", async () => {
    interface OwnerContext extends ExecutionContext {
      userId: string;
    }

    const update = action({
      input: object({ ownerId: string() }),
      authorize: (input, context: OwnerContext) => input.ownerId === context.userId,
      run: ({ ownerId }, context) => `${ownerId}:${context.userId}`,
    });

    await assert.rejects(
      () => update.execute({ ownerId: "u2" }, { userId: "u1", permissions: new Set() }),
      Forbidden,
    );
  });

  it("normalizes unknown failures and preserves framework errors", async () => {
    const unknownFailure = action({
      input: object({}),
      public: true,
      run: () => {
        throw new Error("database leaked detail");
      },
    });
    const knownFailure = action({
      input: object({}),
      public: true,
      run: () => {
        throw new Conflict("Already exists");
      },
    });

    await assert.rejects(() => unknownFailure.execute({}, anonymous), Unexpected);
    await assert.rejects(
      () => knownFailure.execute({}, anonymous),
      (error: unknown) => error instanceof Conflict && error.message === "Already exists",
    );
  });

  it("validates declared output", async () => {
    const broken = query({
      input: object({}),
      output: number(),
      public: true,
      // @ts-expect-error Exercise runtime output validation for untyped callers.
      run: () => "not a number",
    });

    await assert.rejects(() => broken.execute({}, anonymous), InvalidInput);
  });

  it("executes a route with the same explicit access contract", async () => {
    const show = route({
      method: "GET",
      path: "/hello/:name",
      input: object({ name: string() }),
      output: string(),
      public: true,
      handler: ({ name }) => `Hello, ${name}`,
    });

    assert.equal(await show.execute({ name: "Ada" }, anonymous), "Hello, Ada");
    assert.equal(show.metadata.kind, "route");
  });

  it("allows a route with no input declaration", async () => {
    const health = route({
      method: "GET",
      path: "/health",
      output: string(),
      public: true,
      handler: () => "ok",
    });

    assert.equal(await health.execute(undefined, anonymous), "ok");
    assert.equal(health.metadata.input, undefined);
  });

  it("rejects definitions with zero or multiple access decisions", () => {
    const unsafeAction = {
      input: object({}),
      run: () => undefined,
    };
    const ambiguousAction = {
      input: object({}),
      public: true as const,
      permission: "thing.do",
      run: () => undefined,
    };

    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => action(unsafeAction), InvalidInput);
    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => action(ambiguousAction), InvalidInput);
  });
});

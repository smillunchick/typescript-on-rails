import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  Conflict,
  Forbidden,
  InvalidInput,
  Unexpected,
  action,
  adaptSchema,
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

  it("enforces route permission access", async () => {
    const show = route({
      method: "GET",
      path: "/secret/:key",
      input: object({ key: string() }),
      permission: "secret.read",
      handler: ({ key }) => `value:${key}`,
    });

    await assert.rejects(() => show.execute({ key: "a" }, anonymous), Forbidden);
    assert.equal(
      await show.execute({ key: "a" }, { permissions: new Set(["secret.read"]) }),
      "value:a",
    );
  });

  it("allows and denies contextual route authorization", async () => {
    interface OwnerContext extends ExecutionContext {
      readonly userId: string;
    }

    const show = route({
      method: "GET",
      path: "/owners/:ownerId",
      input: object({ ownerId: string() }),
      authorize: (input, context: OwnerContext) => input.ownerId === context.userId,
      handler: ({ ownerId }, context) => `${ownerId}:${context.userId}`,
    });
    const ownerContext = { userId: "u1", permissions: new Set<string>() };

    await assert.rejects(
      () => show.execute({ ownerId: "u2" }, ownerContext),
      Forbidden,
    );
    assert.equal(await show.execute({ ownerId: "u1" }, ownerContext), "u1:u1");
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

  it("uses adapted schemas for actions, queries, and routes", async () => {
    const input = adaptSchema({
      metadata: { kind: "object", fields: { value: { kind: "number" } } } as const,
      parse: (value: unknown) => {
        const candidate = value as { value?: unknown };
        return typeof candidate?.value === "number"
          ? { success: true as const, value: { value: candidate.value } }
          : { success: false as const, error: candidate?.value };
      },
      mapError: () => [{ path: ["value"], code: "invalid_type", expected: "number", received: "string" }],
    });
    const adaptedAction = action({ input, public: true, run: ({ value }) => value + 1 });
    const adaptedQuery = query({ input, public: true, run: ({ value }) => value + 2 });
    const adaptedRoute = route({ method: "POST", path: "/adapted", input, public: true, handler: ({ value }) => value + 3 });

    assert.equal(await adaptedAction.execute({ value: 1 }, anonymous), 2);
    assert.equal(await adaptedQuery.execute({ value: 1 }, anonymous), 3);
    assert.equal(await adaptedRoute.execute({ value: 1 }, anonymous), 4);
    await assert.rejects(() => adaptedAction.execute({ value: "secret" }, anonymous), InvalidInput);
    assert.deepEqual(adaptedRoute.metadata.input, input.metadata);
  });

  it("checks permissions before parsing and parses once for contextual authorization", async () => {
    let permissionParses = 0;
    const permissionInput = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (value: unknown) => {
        permissionParses += 1;
        return { success: true as const, value: String(value) };
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    const protectedAction = action({ input: permissionInput, permission: "thing.read", run: (value) => value });
    const protectedRoute = route({ method: "GET", path: "/thing", input: permissionInput, permission: "thing.read", handler: (value) => value });

    await assert.rejects(() => protectedAction.execute("secret", anonymous), Forbidden);
    await assert.rejects(() => protectedRoute.execute("secret", anonymous), Forbidden);
    assert.equal(permissionParses, 0);
    const permitted = { permissions: new Set(["thing.read"]) };
    assert.equal(await protectedAction.execute("action", permitted), "action");
    assert.equal(await protectedRoute.execute("route", permitted), "route");
    assert.equal(permissionParses, 2);

    let contextualParses = 0;
    const contextualInput = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (value: unknown) => {
        contextualParses += 1;
        return { success: true as const, value: String(value) };
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    const contextual = action({
      input: contextualInput,
      authorize: (value) => value === "allowed",
      run: (value) => value,
    });
    await assert.rejects(() => contextual.execute("denied", anonymous), Forbidden);
    assert.equal(await contextual.execute("allowed", anonymous), "allowed");
    assert.equal(contextualParses, 2);
  });

  it("rejects parser thenables before operation and route code receives input", async () => {
    const asynchronous = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => Promise.resolve({ success: true as const, value: "late" })) as unknown as () => { readonly success: true; readonly value: string },
      mapError: () => [{ code: "invalid_value" }],
    });
    let actionCalls = 0;
    let queryCalls = 0;
    let routeCalls = 0;
    const adaptedAction = action({ input: asynchronous, public: true, run: () => { actionCalls += 1; return true; } });
    const adaptedQuery = query({ input: asynchronous, public: true, run: () => { queryCalls += 1; return true; } });
    const adaptedRoute = route({ method: "POST", path: "/async", input: asynchronous, public: true, handler: () => { routeCalls += 1; return true; } });

    await assert.rejects(() => adaptedAction.execute("value", anonymous), Unexpected);
    await assert.rejects(() => adaptedQuery.execute("value", anonymous), Unexpected);
    await assert.rejects(() => adaptedRoute.execute("value", anonymous), Unexpected);
    assert.deepEqual([actionCalls, queryCalls, routeCalls], [0, 0, 0]);
  });

  it("rejects operation and route definitions with zero or multiple access decisions", () => {
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
    const unsafeRoute = {
      method: "GET" as const,
      path: "/unsafe",
      handler: () => undefined,
    };
    const ambiguousRoute = {
      method: "GET" as const,
      path: "/ambiguous",
      public: true as const,
      permission: "thing.read",
      handler: () => undefined,
    };

    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => action(unsafeAction), InvalidInput);
    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => action(ambiguousAction), InvalidInput);
    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => route(unsafeRoute), InvalidInput);
    // @ts-expect-error Exercise runtime protection for an untyped caller.
    assert.throws(() => route(ambiguousRoute), InvalidInput);
  });
});

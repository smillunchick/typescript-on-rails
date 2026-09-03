import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidInput,
  Unexpected,
  action,
  adaptSchema,
  assertRuntimeSuitability,
  boolean,
  consumer,
  createEventBus,
  defineAdapterContract,
  defineApp,
  defineFeature,
  defineModel,
  event,
  implementAdapter,
  object,
  operationRoute,
  parseRuntimeRecordId,
  query,
  route,
  runtimeBinding,
  runtimeRecordId,
  string,
  entrypoint,
} from "../src/index.js";

describe("adapters and app configuration", () => {
  const adapterOptions = { provider: "test", suitability: "production" } as const;
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
    }, adapterOptions);

    assert.equal(await memoryEmail.operations.send({ to: "a@example.com", body: "Hi" }), true);
    assert.deepEqual(memoryEmail.metadata, {
      kind: "adapter",
      name: "Email",
      provider: "test",
      suitability: "production",
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
    }, adapterOptions);
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
    }, adapterOptions);
    const first = concurrentEmail.operations.send({ to: "a@example.com", body: "One" });
    const second = concurrentEmail.operations.send({ to: "b@example.com", body: "Two" });
    assert.equal(concurrentCalls, 2);
    releaseGate();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);

    assert.throws(
      // @ts-expect-error Exercise the runtime guard for an untyped adapter implementation.
      () => implementAdapter(Email, {}, adapterOptions),
      /Adapter Email must implement operation send/,
    );

    const invalidOutput = implementAdapter(Email, {
      // @ts-expect-error Exercise output validation for an untyped adapter implementation.
      send: () => "accepted",
    }, adapterOptions);
    await assert.rejects(
      async () => invalidOutput.operations.send({ to: "a@example.com", body: "Hi" }),
      InvalidInput,
    );
  });

  it("normalizes adapted operation schemas and rejects thenables before adapter code", async () => {
    const adaptedInput = adaptSchema({
      metadata: { kind: "object", fields: { to: { kind: "string" } } } as const,
      parse: (value: unknown) => typeof (value as { to?: unknown })?.to === "string"
        ? { success: true as const, value: value as { to: string } }
        : { success: false as const, error: value },
      mapError: () => [{ path: ["to"], code: "invalid_type", expected: "string", received: "number" }],
    });
    const adaptedOutput = adaptSchema({
      metadata: { kind: "boolean" } as const,
      parse: (value: unknown) => typeof value === "boolean"
        ? { success: true as const, value }
        : { success: false as const, error: value },
      mapError: () => [{ code: "invalid_type", expected: "boolean", received: "string" }],
    });
    const External = defineAdapterContract({
      name: "External",
      operations: { send: { input: adaptedInput, output: adaptedOutput } },
    });
    let calls = 0;
    const external = implementAdapter(External, { send: ({ to }) => { calls += 1; return to.length > 0; } }, adapterOptions);

    assert.equal(await external.operations.send({ to: "a@example.com" }), true);
    await assert.rejects(
      // @ts-expect-error Exercise adapted input validation for an untyped caller.
      () => external.operations.send({ to: 1 }),
      InvalidInput,
    );
    assert.equal(calls, 1);
    assert.deepEqual(External.metadata.operations.send?.input, adaptedInput.metadata);

    const thenableInput = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => ({ then: () => undefined })) as unknown as () => { readonly success: true; readonly value: string },
      mapError: () => [{ code: "invalid_value" }],
    });
    const Async = defineAdapterContract({
      name: "Async",
      operations: { send: { input: thenableInput, output: adaptedOutput } },
    });
    let asyncCalls = 0;
    const asynchronous = implementAdapter(Async, { send: () => { asyncCalls += 1; return true; } }, adapterOptions);
    await assert.rejects(async () => asynchronous.operations.send("value"), Unexpected);
    assert.equal(asyncCalls, 0);
  });

  it("uses one canonical adapted schema through every runtime consumer", async () => {
    interface ExternalValue {
      readonly ownerId: string;
      readonly amount: number;
      readonly reference: string;
    }
    const metadata = {
      kind: "object",
      fields: {
        ownerId: { kind: "id", entity: "User" },
        amount: { kind: "money", currency: "minor-unit" },
        reference: {
          kind: "extension",
          namespace: "example.test",
          name: "reference",
          version: "1",
          payload: { format: "external-reference" },
          underlying: { kind: "string" },
        },
      },
    } as const;
    const shared = adaptSchema({
      metadata,
      parse: (value: unknown) => {
        const candidate = value as Partial<ExternalValue> | null;
        const valid = candidate !== null
          && typeof candidate === "object"
          && typeof candidate.ownerId === "string"
          && Number.isSafeInteger(candidate.amount)
          && (candidate.amount ?? -1) >= 0
          && typeof candidate.reference === "string";
        return valid
          ? { success: true as const, value: candidate as ExternalValue }
          : { success: false as const, error: value };
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    const SharedModel = defineModel({ name: "Shared", fields: { value: shared } });
    const sharedAction = action({ input: shared, public: true, run: () => true });
    const sharedQuery = query({ input: shared, public: true, run: () => true });
    const sharedRoute = route({ method: "POST", path: "/shared", input: shared, public: true, handler: () => true });
    const SharedEvent = event({ name: "SharedEvent", payload: shared });
    const SharedAdapter = defineAdapterContract({
      name: "SharedAdapter",
      operations: { send: { input: shared, output: boolean() } },
    });
    const sharedAdapter = implementAdapter(SharedAdapter, { send: () => true }, adapterOptions);
    const context = { permissions: new Set<string>() };
    const valid: ExternalValue = { ownerId: "user_1", amount: 100, reference: "ref_1" };
    const invalid = { ownerId: 1, amount: -1, reference: null };
    const eventValues: ExternalValue[] = [];
    const bus = createEventBus();
    bus.on(SharedEvent, (value) => { eventValues.push(value); });

    assert.deepEqual(SharedModel.parse({ value: valid }), { value: valid });
    assert.equal(await sharedAction.execute(valid, context), true);
    assert.equal(await sharedQuery.execute(valid, context), true);
    assert.equal(await sharedRoute.execute(valid, context), true);
    await bus.emit(SharedEvent, valid);
    assert.deepEqual(eventValues, [valid]);
    assert.equal(await sharedAdapter.operations.send(valid), true);

    assert.throws(() => SharedModel.parse({ value: invalid }), InvalidInput);
    await assert.rejects(() => sharedAction.execute(invalid, context), InvalidInput);
    await assert.rejects(() => sharedQuery.execute(invalid, context), InvalidInput);
    await assert.rejects(() => sharedRoute.execute(invalid, context), InvalidInput);
    await assert.rejects(
      // @ts-expect-error Exercise invalid adapted event data from an untyped producer.
      () => bus.emit(SharedEvent, invalid),
      InvalidInput,
    );
    await assert.rejects(
      // @ts-expect-error Exercise invalid adapted adapter data from an untyped caller.
      async () => sharedAdapter.operations.send(invalid),
      InvalidInput,
    );

    assert.deepEqual(SharedModel.metadata.fields.value, shared.metadata);
    assert.deepEqual(sharedAction.metadata.input, shared.metadata);
    assert.deepEqual(sharedQuery.metadata.input, shared.metadata);
    assert.deepEqual(sharedRoute.metadata.input, shared.metadata);
    assert.deepEqual(SharedEvent.metadata.payload, shared.metadata);
    assert.deepEqual(SharedAdapter.metadata.operations.send?.input, shared.metadata);
    assert.deepEqual(sharedAdapter.metadata.operations.send?.input, shared.metadata);
  });

  it("compiles identity-verified runtime links from the exact registered objects", () => {
    const createProject = action({
      input: object({ id: string() }),
      permission: "project.create",
      run: ({ id }) => ({ id }),
    });
    const createProjectRoute = operationRoute({
      method: "POST",
      path: "/projects",
      operation: createProject,
    });
    const ProjectCreated = event({ name: "ProjectCreated", payload: object({ id: string() }) });
    const projectCreatedConsumer = consumer({
      name: "sendProjectWelcome",
      event: ProjectCreated,
      durable: true,
      handle: () => undefined,
    });
    const feature = defineFeature({
      name: "projects",
      operations: { createProject },
      routes: [createProjectRoute],
      events: [ProjectCreated],
      consumers: [projectCreatedConsumer],
    });
    const webBinding = runtimeBinding({
      name: "projects.create",
      protocol: "web.route/v1",
      process: "web",
      target: createProjectRoute,
    });
    const workerBinding = runtimeBinding({
      name: "projects.sendProjectWelcome",
      protocol: "jobs.consumer/v1",
      process: "worker",
      target: projectCreatedConsumer,
    });
    const app = defineApp({
      features: [feature],
      entrypoints: {
        web: entrypoint({ name: "web", process: "web", bindings: [webBinding], run: () => undefined }),
        worker: entrypoint({ name: "worker", process: "worker", bindings: [workerBinding], run: () => undefined }),
      },
    });

    assert.equal(app.graph.routes[0]?.definition, createProjectRoute);
    assert.equal(app.graph.consumers[0]?.definition, projectCreatedConsumer);
    assert.deepEqual(app.graph.links.map(({ kind }) => kind), [
      "consumer-event",
      "entrypoint-consumer",
      "entrypoint-route",
      "route-operation",
    ]);
    assert.throws(
      () => defineApp({
        features: [feature],
        entrypoints: {
          web: entrypoint({
            name: "invalid",
            process: "web",
            bindings: [runtimeBinding({ name: "invalid", protocol: "web.route/v1", process: "web", target: {} })],
            run: () => undefined,
          }),
        },
      }),
      /UNREGISTERED_RUNTIME_BINDING_TARGET/,
    );
  });

  it("indexes models and rejects duplicate semantic identities and test owners", () => {
    const Project = defineModel({ name: "Project", fields: { id: string() } });
    const firstCreated = event({ name: "ProjectCreated", payload: object({ id: string() }) });
    const secondCreated = event({ name: "ProjectCreated", payload: object({ id: string() }) });
    const feature = defineFeature({
      name: "projects",
      models: [Project],
      events: [firstCreated],
      tests: ["test/projects.test.ts"],
    });
    const app = defineApp({
      features: [feature],
      tests: [{ feature: "projects", files: ["test/projects.test.ts"] }],
    });

    assert.equal(app.graph.models[0]?.definition, Project);
    assert.equal(runtimeRecordId("event", "billing/ops", "Paid 100%"), "rid1/event/billing%2Fops/Paid%20100%25");
    assert.deepEqual(parseRuntimeRecordId("rid1/event/billing%2Fops/Paid%20100%25"), {
      version: 1,
      kind: "event",
      owner: "billing/ops",
      name: "Paid 100%",
    });
    assert.throws(() => parseRuntimeRecordId("rid1/event/billing%2fops/Paid%20100%25"), /INVALID_RUNTIME_RECORD_ID/);
    assert.throws(
      () => defineApp({ features: [defineFeature({ name: "projects", events: [firstCreated, secondCreated] })] }),
      /DUPLICATE_RUNTIME_SEMANTIC_ID.*ProjectCreated/,
    );
    assert.throws(
      () => defineApp({
        features: [
          defineFeature({ name: "projects", routes: [route({ method: "GET", path: "/shared", public: true, handler: () => "projects" })] }),
          defineFeature({ name: "billing", routes: [route({ method: "GET", path: "/shared", public: true, handler: () => "billing" })] }),
        ],
      }),
      /DUPLICATE_ROUTE_ENDPOINT.*GET \/shared/,
    );
    assert.throws(
      () => defineApp({
        features: [
          defineFeature({ name: "projects", tests: ["test/shared.test.ts"] }),
          defineFeature({ name: "billing", tests: ["./test/shared.test.ts"] }),
        ],
      }),
      /DUPLICATE_TEST_OWNERSHIP.*test\/shared\.test\.ts/,
    );
    assert.doesNotThrow(() => defineApp({
      features: [defineFeature({ name: "projects" }), defineFeature({ name: "billing" })],
      tests: [{ suite: "reference", features: ["projects", "billing"], files: ["test/reference.test.ts"] }],
    }));
  });

  it("registers exact adapter requirements, instances, links, and suitability", () => {
    const email = implementAdapter(Email, { send: () => true }, { provider: "local-memory", suitability: "local-only" });
    const feature = defineFeature({ name: "access", adapters: [Email] });
    const reports = defineFeature({ name: "reports", adapters: [Email] });
    const app = defineApp({ features: [feature, reports], adapters: { email } });

    assert.equal(app.adapters.email, email);
    assert.equal(app.graph.adapters[0]?.definition, email);
    assert.equal(app.graph.adapterRequirements[0]?.definition, Email);
    assert.deepEqual(app.graph.links.filter(({ kind }) => kind === "feature-adapter"), [
      {
        kind: "feature-adapter",
        from: runtimeRecordId("adapter", "access", "Email"),
        to: runtimeRecordId("adapter", "application", "Email"),
      },
      {
        kind: "feature-adapter",
        from: runtimeRecordId("adapter", "reports", "Email"),
        to: runtimeRecordId("adapter", "application", "Email"),
      },
    ]);
    assert.deepEqual(app.metadata, { kind: "app", graphProtocolVersion: 2, adapters: { email: "Email" } });
    assert.throws(() => assertRuntimeSuitability(app, "production"), /ADAPTER_NOT_PRODUCTION_SUITABLE:Email/);
    assert.doesNotThrow(() => assertRuntimeSuitability(app, "local-only"));
    const productionEmail = implementAdapter(Email, { send: () => true }, { provider: "provider", suitability: "production" });
    const productionApp = defineApp({ features: [feature], adapters: { email: productionEmail } });
    assert.doesNotThrow(() => assertRuntimeSuitability(productionApp, "production"));
    assert.equal(Object.isFrozen(Email), true);
    assert.equal(Object.isFrozen(email), true);
  });

  it("rejects every incoherent adapter registration before graph links", () => {
    const local = implementAdapter(Email, { send: () => true }, { provider: "local-memory", suitability: "local-only" });
    const rebuilt = defineAdapterContract({ name: "Email", operations: Email.operations });
    const wrong = implementAdapter(rebuilt, { send: () => true }, { provider: "other", suitability: "production" });
    const required = defineFeature({ name: "access", adapters: [Email] });
    assert.throws(() => defineApp({ features: [required] }), /ADAPTER_CONTRACT_NOT_REGISTERED/);
    assert.throws(() => defineApp({ features: [required], adapters: { wrong } }), /ADAPTER_CONTRACT_IDENTITY_MISMATCH/);
    assert.throws(() => defineApp({ features: [required], adapters: { first: local, second: local } }), /DUPLICATE_ADAPTER_CONTRACT/);
    assert.throws(() => defineApp({ adapters: { email: local } }), /UNUSED_ADAPTER/);
    assert.throws(() => defineFeature({ name: "duplicate", adapters: [Email, Email] }), /DUPLICATE_ADAPTER_REQUIREMENT/);
    assert.throws(() => defineFeature({ name: "application" }), /RESERVED_FEATURE_NAME/);
    assert.throws(() => defineApp({ features: [required], adapters: { email: { contract: Email, operations: {} } as never } }), /ADAPTER_INSTANCE_INVALID/);
  });
});

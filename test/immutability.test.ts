import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  action,
  analyzeApplicationV3,
  boolean,
  consumer,
  defineAdapterContract,
  defineApp,
  defineFeature,
  defineModel,
  defineRepository,
  entrypoint,
  event,
  implementAdapter,
  invariant,
  object,
  operationRoute,
  route,
  runtimeBinding,
  schedule,
  string,
} from "../src/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

describe("framework-owned immutability", () => {
  it("copies and freezes executable graph definitions without freezing opaque values", () => {
    const operation = action({ input: object({ value: string() }), public: true, run: ({ value }) => ({ value }) });
    const directRoute = route({ method: "GET", path: "/direct", public: true, handler: () => true });
    const boundRoute = operationRoute({ method: "POST", path: "/bound", operation });
    const Event = event({ owner: "feature", name: "Occurred", payload: object({ value: string() }) });
    const target = consumer({ name: "target", event: Event, durable: true, handle: () => undefined });
    const scheduled = schedule({ name: "daily", feature: "feature", target, occurrences: () => [] });
    const repository = defineRepository({ name: "records", feature: "feature", relations: ["app.records"] });
    const contract = defineAdapterContract({ name: "service", operations: { run: { input: object({ value: string() }), output: boolean() } } });
    const adapter = implementAdapter(contract, { run: () => true }, { provider: "test", suitability: "production" });
    const rules = [invariant<{ readonly id: string }>("id", ({ id }) => id.length > 0)];
    const fields = { id: string() };
    const model = defineModel({ name: "Record", fields, invariants: rules });
    rules.push(invariant("late", () => false));
    const bindings = [runtimeBinding({ name: "feature.target", protocol: "jobs.consumer/v1", process: "worker", target })];
    const featureItems = [model];
    const feature = defineFeature({
      name: "feature",
      models: featureItems,
      operations: { operation },
      routes: [directRoute, boundRoute],
      events: [Event],
      consumers: [target],
      adapters: [contract],
      repositories: [repository],
      schedules: [scheduled],
    });
    featureItems.length = 0;
    const worker = entrypoint({ name: "worker", process: "worker", bindings, run: () => undefined });
    bindings.length = 0;
    const app = defineApp({ features: [feature], adapters: { service: adapter }, entrypoints: { worker } });

    for (const value of [operation, operation.metadata, operation.metadata.access, directRoute, directRoute.metadata, boundRoute, boundRoute.metadata, Event, Event.metadata, target, target.metadata, scheduled, scheduled.metadata, repository, repository.metadata, repository.relations, contract, contract.metadata, contract.operations, adapter, adapter.metadata, adapter.operations, model, model.metadata, model.fields, rules[0], feature, feature.models, feature.operations, worker, worker.metadata, worker.bindings, app, app.metadata, app.graph, app.graph.models, app.graph.models[0]]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.equal(feature.models.length, 1);
    assert.equal(worker.bindings.length, 1);
    assert.deepEqual(model.metadata.invariants, ["id"]);
    assert.throws(() => { (directRoute.metadata as { path: string }).path = "/changed"; }, TypeError);
    const opaque = { nested: true };
    assert.equal(operation.execute({ value: "ok" }, { permissions: new Set() }) instanceof Promise, true);
    assert.equal(Object.isFrozen(opaque), false);
  });

  it("freezes Manifest v3 records and detail collections", async () => {
    const fixture = await createAppFixture({ "src/features/feature/index.ts": "export const value = true;\n" });
    try {
      const Record = defineModel({ name: "Record", fields: { id: string() } });
      const app = defineApp({ features: [defineFeature({ name: "feature", models: [Record] })] });
      const manifest = analyzeApplicationV3(fixture.root, { application: app });
      const feature = manifest.composition.find(({ kind }) => kind === "feature");
      const model = manifest.composition.find(({ kind }) => kind === "model");
      assert.ok(feature);
      assert.equal(Object.isFrozen(manifest), true);
      assert.equal(Object.isFrozen(manifest.composition), true);
      assert.equal(Object.isFrozen(feature), true);
      assert.ok(model?.detail);
      assert.equal(Object.isFrozen(model), true);
      assert.equal(Object.isFrozen(model.detail), true);
      assert.equal(Object.isFrozen(model.detail.fields), true);
    } finally { await fixture.cleanup(); }
  });
});

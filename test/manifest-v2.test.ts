import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import {
  analyzeApplication,
  type ArchitectureManifest,
} from "../src/features/architecture/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

async function analyze(files: Readonly<Record<string, string>>): Promise<ArchitectureManifest> {
  const fixture = await createAppFixture(files);
  fixtures.push(fixture);
  return analyzeApplication(fixture.root);
}

describe("manifest v2 semantic identities", () => {
  it("emits owner-qualified records, structured facets, and exact compiler metadata", async () => {
    const source = (feature: string) => `
import { action, object, string } from "typescript-on-rails";
export const list = action({ input: object({ id: string() }), public: true, run: async ({ id }) => ({ id }) });
`;
    const manifest = await analyze({
      "src/features/billing/index.ts": source("billing"),
      "src/features/reports/index.ts": source("reports"),
    });
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.operations.map((entry) => entry.id), [
      "sid1/operation/feature/billing/list",
      "sid1/operation/feature/reports/list",
    ]);
    assert.ok(manifest.operations.every((entry) => !("contract" in entry)));
    assert.ok(manifest.operations.every((entry) => entry.input.staticType.status === "resolved"));
    assert.ok(manifest.operations.every((entry) => entry.output.staticType.status === "resolved"
      && entry.output.staticType.provenance === "inferred-typescript"));
    assert.ok(manifest.operations.every((entry) => entry.output.runtimeSchema.status === "not-declared"
      && entry.output.runtimeSchema.validator === "not-declared"));
    assert.equal(ts.version, "5.9.3");
    assert.deepEqual(manifest.compiler, {
      manifestVersion: 2,
      typescriptVersion: "5.9.3",
      schemaProtocolVersion: "1",
      canonicalSchemaVersion: "1",
      typeContractVersion: 1,
    });
    assert.equal("root" in manifest, false);
  });

  it("resolves immutable config aliases, shorthand members, method callbacks, and literal aliases", async () => {
    const manifest = await analyze({
      "src/features/contracts/config.ts": `
import { boolean, object, string } from "typescript-on-rails";
export const permission = "contracts:read" as const;
export const method = "POST" as const;
export const path = "/contracts" as const;
const input = object({ value: string() });
const output = string();
const payload = boolean();
const operations = { send: { input, output } };
export const actionConfig = ({ input, output, permission, run({ value }: { value: string }) { return value; } } as const) satisfies object;
export const routeConfig = { method, path, input, output, permission, authorize() { return true; }, handler({ value }: { value: string }) { return value; } } as const;
export const eventConfig = { payload } as const;
export const adapterConfig = { operations } as const;
export const modelConfig = { fields: { value: string() } } as const;
`,
      "src/features/contracts/index.ts": `
import { action, defineAdapterContract, defineModel, event, route } from "typescript-on-rails";
import { actionConfig as importedAction, adapterConfig, eventConfig, modelConfig, routeConfig } from "./config.js";
const fields = modelConfig.fields;
export const Record = defineModel(({ fields }) as const);
export const submit = action(importedAction);
export const endpoint = route(routeConfig);
export const notice = event(eventConfig);
export const Gateway = defineAdapterContract(adapterConfig);
`,
    });

    assert.equal(manifest.models.find((entry) => entry.name === "Record")?.fields.status, "resolved");
    const operation = manifest.operations.find((entry) => entry.name === "submit");
    assert.equal(operation?.input.runtimeSchema.status, "resolved");
    assert.equal(operation?.output.runtimeSchema.status, "resolved");
    assert.equal(operation?.permission, "contracts:read");
    assert.equal(operation?.access, "permission");
    assert.equal(operation?.input.staticType.status, "resolved");
    assert.equal(operation?.output.staticType.status, "resolved");
    const endpoint = manifest.routes.find((entry) => entry.name === "endpoint");
    assert.equal(endpoint?.method, "POST");
    assert.equal(endpoint?.path, "/contracts");
    assert.equal(endpoint?.access, "permission");
    assert.equal(endpoint?.input.staticType.status, "resolved");
    assert.equal(endpoint?.output.staticType.status, "resolved");
    assert.equal(manifest.events.find((entry) => entry.name === "notice")?.payload.status, "resolved");
    const adapter = manifest.adapters.find((entry) => entry.name === "Gateway");
    assert.ok(adapter?.kind === "contract");
    assert.equal(adapter.operations.status, "resolved");
    assert.deepEqual(manifest.permissions, ["contracts:read"]);
  });

  it("does not resolve a plain const config after mutation before the call", async () => {
    const manifest = await analyze({
      "src/features/contracts/index.ts": `
import { action, string } from "typescript-on-rails";
const config = { input: string(), permission: "read", run(value: string) { return value; } };
config.permission = "write";
export const changed = action(config);
`,
    });

    const operation = manifest.operations.find((entry) => entry.name === "changed");
    assert.ok(operation);
    assert.equal(operation.access, "missing");
    assert.equal("permission" in operation, false);
    assert.equal(operation.input.staticType.status, "unresolved");
    assert.equal(operation.output.staticType.status, "unresolved");
    if (operation.input.staticType.status === "unresolved") assert.equal(operation.input.staticType.diagnostic.code, "TC009");
    if (operation.output.staticType.status === "unresolved") assert.equal(operation.output.staticType.diagnostic.code, "TC009");
    assert.equal(operation.input.runtimeSchema.status, "unresolved");
    if (operation.input.runtimeSchema.status === "unresolved") assert.equal(operation.input.runtimeSchema.diagnostic.code, "SC004");
    assert.deepEqual(manifest.permissions, []);
  });

  it("does not resolve const-asserted config after an outer mutable assertion and mutation", async () => {
    const manifest = await analyze({
      "src/features/contracts/index.ts": `
import { action, string } from "typescript-on-rails";
interface MutableConfig {
  input: ReturnType<typeof string>;
  permission: string;
  run(value: string): string;
}
const config = ({ input: string(), permission: "read", run(value: string) { return value; } } as const) as MutableConfig;
config.permission = "write";
export const changed = action(config);
`,
    });

    const operation = manifest.operations.find((entry) => entry.name === "changed");
    assert.ok(operation);
    assert.equal(operation.access, "missing");
    assert.equal("permission" in operation, false);
    assert.equal(operation.input.staticType.status, "unresolved");
    assert.equal(operation.output.staticType.status, "unresolved");
    assert.equal(operation.input.runtimeSchema.status, "unresolved");
    assert.deepEqual(manifest.permissions, []);
  });

  it("retains recognized declarations when config resolution fails", async () => {
    const manifest = await analyze({
      "src/features/broken/index.ts": `
import { action, defineAdapterContract, defineModel, event, query, route } from "typescript-on-rails";
declare function config(): unknown;
let mutable = { public: true, run(value: unknown) { return value; } };
export const Model = defineModel(config() as never);
export const act = action(mutable);
export const ask = query(config() as never);
export const endpoint = route(config() as never);
export const notice = event(config() as never);
export const Gateway = defineAdapterContract(config() as never);
`,
    });

    assert.equal(manifest.models.find((entry) => entry.name === "Model")?.fields.status, "unresolved");
    for (const name of ["act", "ask"]) {
      const operation = manifest.operations.find((entry) => entry.name === name);
      assert.equal(operation?.input.staticType.status, "unresolved");
      assert.equal(operation?.output.staticType.status, "unresolved");
      if (operation?.input.staticType.status === "unresolved") assert.equal(operation.input.staticType.diagnostic.code, "TC009");
      if (operation?.output.staticType.status === "unresolved") assert.equal(operation.output.staticType.diagnostic.code, "TC009");
    }
    const endpoint = manifest.routes.find((entry) => entry.name === "endpoint");
    assert.equal(endpoint?.input.staticType.status, "unresolved");
    assert.equal(endpoint?.output.staticType.status, "unresolved");
    assert.equal(manifest.events.find((entry) => entry.name === "notice")?.payload.status, "unresolved");
    const adapter = manifest.adapters.find((entry) => entry.name === "Gateway");
    assert.ok(adapter?.kind === "contract");
    assert.equal(adapter.operations.status, "unresolved");
    assert.ok(manifest.diagnostics.some((entry) => entry.code === "ARCH016" && entry.target === "sid1/operation/feature/broken/act"));
  });

  it("links adapter aliases by symbol and retains unresolved inline links", async () => {
    const manifest = await analyze({
      "src/infra/contracts.ts": `
import { boolean, defineAdapterContract, object, string } from "typescript-on-rails";
export const Email = defineAdapterContract({ name: "Email", operations: { send: { input: object({ to: string() }), output: boolean() } } });
`,
      "src/infra/adapters.ts": `
import { boolean, defineAdapterContract, implementAdapter, object, string } from "typescript-on-rails";
import { Email as ImportedEmail } from "./contracts.js";
const LocalEmail = ImportedEmail;
export const email = implementAdapter((LocalEmail satisfies typeof LocalEmail), { send: async () => true });
export const inline = implementAdapter(
  defineAdapterContract({ name: "Inline", operations: { send: { input: object({ to: string() }), output: boolean() } } }),
  { send: async () => true },
);
`,
    });

    const resolved = manifest.adapters.find((entry) => entry.kind === "implementation" && entry.name === "email");
    assert.ok(resolved?.kind === "implementation");
    assert.equal(resolved.contractId, "sid1/adapter-contract/infra/_/Email");
    const unresolved = manifest.adapters.find((entry) => entry.kind === "implementation" && entry.name === "inline");
    assert.ok(unresolved?.kind === "implementation");
    assert.equal(unresolved.contractId, null);
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "adapter-link" && entry.target === unresolved.id));
  });

  it("retains blank declared names with null IDs and checks global model ownership by semantic name", async () => {
    const manifest = await analyze({
      "src/features/a/index.ts": `
import { defineModel, string } from "typescript-on-rails";
const MODEL_NAME = "Other";
export const blank = defineModel({ name: "", fields: { value: string() } });
export const Invoice = defineModel({ name: "Invoice", fields: { value: string() } });
export const LocalInvoice = defineModel({ name: MODEL_NAME, fields: { value: string() } });
`,
      "src/features/b/index.ts": `
import { defineModel, string } from "typescript-on-rails";
export const Invoice = defineModel({ name: "Invoice", fields: { value: string() } });
`,
    });

    const blank = manifest.models.find((entry) => entry.name === "");
    assert.ok(blank);
    assert.equal(blank.id, null);
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "semantic-identity" && entry.file === blank.file));
    assert.equal(manifest.models.find((entry) => entry.name === "LocalInvoice")?.id, "sid1/model/feature/a/LocalInvoice");
    assert.deepEqual(manifest.models.filter((entry) => entry.name === "Invoice").map((entry) => entry.id), [
      "sid1/model/feature/a/Invoice",
      "sid1/model/feature/b/Invoice",
    ]);
    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "data-owner").length, 2);
  });

  it("retains same-owner duplicate IDs and reports every location", async () => {
    const manifest = await analyze({
      "src/features/billing/index.ts": `export { first, second } from "./actions.js";`,
      "src/features/billing/actions.ts": `
import { action, object, string } from "typescript-on-rails";
export const first = action({ input: object({ id: string() }), public: true, run: ({ id }) => id });
export { first as second };
`,
      "src/features/billing/duplicate.ts": `
import { action, object, string } from "typescript-on-rails";
const first = action({ input: object({ id: string() }), public: true, run: ({ id }) => id });
export { first };
`,
    });
    const duplicates = manifest.operations.filter((entry) => entry.id === "sid1/operation/feature/billing/first");
    assert.equal(duplicates.length, 2);
    const diagnostic = manifest.diagnostics.find((entry) => entry.rule === "duplicate-semantic-id");
    assert.ok(diagnostic);
    assert.equal(diagnostic.related?.length, 2);
  });

  it("qualifies same local names by feature for each semantic declaration category", async () => {
    const source = `
import { action, defineAdapterContract, event, object, route, string } from "typescript-on-rails";
export const shared = action({ input: object({ value: string() }), public: true, run: ({ value }) => value });
export const endpoint = route({ method: "GET", path: "/shared", public: true, handler: () => "ok" });
export const notice = event({ name: "notice", payload: string() });
export const Gateway = defineAdapterContract({ name: "Gateway", operations: { send: { input: string(), output: string() } } });
`;
    const manifest = await analyze({
      "src/features/alpha/index.ts": source,
      "src/features/beta/index.ts": source,
    });

    const pairs = [
      manifest.operations.filter((entry) => entry.name === "shared"),
      manifest.routes.filter((entry) => entry.name === "endpoint"),
      manifest.events.filter((entry) => entry.name === "notice"),
      manifest.adapters.filter((entry) => entry.kind === "contract" && entry.name === "Gateway"),
    ];
    for (const records of pairs) {
      assert.equal(records.length, 2);
      assert.equal(new Set(records.map((entry) => entry.id)).size, 2);
      assert.deepEqual(records.map((entry) => entry.owner.name), ["alpha", "beta"]);
    }
  });

  it("keeps IDs and canonical facets stable across file, line, body, and key-order movement", async () => {
    const before = await analyze({
      "src/features/billing/first.ts": `
import { action, object, string } from "typescript-on-rails";
export const submit = action({ input: object({ z: string(), a: string() }), output: object({ y: string(), b: string() }), public: true, run: ({ a, z }) => ({ y: z, b: a }) });
`,
    });
    const after = await analyze({
      "src/features/billing/moved.ts": `


import { action, object, string } from "typescript-on-rails";
export const submit = action({ public: true, output: object({ b: string(), y: string() }), run: (value) => ({ b: value.a, y: value.z }), input: object({ a: string(), z: string() }) });
`,
    });
    const left = before.operations[0]!;
    const right = after.operations[0]!;
    assert.equal(left.id, right.id);
    assert.deepEqual(left.owner, right.owner);
    assert.deepEqual(left.input, right.input);
    assert.deepEqual(left.output, right.output);
  });

  it("changes IDs only for owner or declaration renames, not mutable operation and route fields", async () => {
    const source = (operation: "action" | "query", operationName: string, method: string, routePath: string) => `
import { ${operation}, object, route, string } from "typescript-on-rails";
export const ${operationName} = ${operation}({ input: object({ value: string() }), public: true, run: ({ value }) => value });
export const endpoint = route({ method: "${method}", path: "${routePath}", public: true, handler: () => "ok" });
`;
    const before = await analyze({ "src/features/billing/index.ts": source("action", "submit", "GET", "/old") });
    const mutable = await analyze({ "src/features/billing/index.ts": source("query", "submit", "POST", "/new") });
    const renamed = await analyze({ "src/features/billing/index.ts": source("action", "send", "GET", "/old") });
    const movedOwner = await analyze({ "src/features/accounts/index.ts": source("action", "submit", "GET", "/old") });

    assert.equal(before.operations[0]!.id, mutable.operations[0]!.id);
    assert.notEqual(before.operations[0]!.kind, mutable.operations[0]!.kind);
    assert.equal(before.routes[0]!.id, mutable.routes[0]!.id);
    assert.notEqual(before.routes[0]!.method, mutable.routes[0]!.method);
    assert.notEqual(before.routes[0]!.path, mutable.routes[0]!.path);
    assert.notEqual(before.operations[0]!.id, renamed.operations[0]!.id);
    assert.notEqual(before.operations[0]!.id, movedOwner.operations[0]!.id);
    assert.notEqual(before.routes[0]!.id, movedOwner.routes[0]!.id);
  });

  it("reports inferred output without a validator beside resolved declared output", async () => {
    const manifest = await analyze({
      "src/features/billing/index.ts": `
import { action, object, string } from "typescript-on-rails";
export const inferred = action({ input: object({ value: string() }), public: true, run: ({ value }) => value });
export const declared = action({ input: object({ value: string() }), output: string(), public: true, run: ({ value }) => value });
`,
    });
    const inferred = manifest.operations.find((entry) => entry.name === "inferred")!;
    const declared = manifest.operations.find((entry) => entry.name === "declared")!;
    assert.equal(inferred.output.staticType.status, "resolved");
    assert.deepEqual(inferred.output.runtimeSchema, { status: "not-declared", validator: "not-declared" });
    assert.equal(declared.output.staticType.status, "resolved");
    assert.equal(declared.output.runtimeSchema.status, "resolved");
    assert.equal(declared.output.runtimeSchema.validator, "declared");
  });

  it("resolves imported schema aliases without execution and retains widened schemas", async () => {
    const manifest = await analyze({
      "src/features/billing/schemas.ts": `
import { object, string, type Schema } from "typescript-on-rails";
export const exact = object({ value: string() });
export const widened: Schema<unknown> = string();
throw new Error("the analyzer must not execute source");
`,
      "src/features/billing/index.ts": `
import { action } from "typescript-on-rails";
import { exact as aliased, widened } from "./schemas.js";
export const valid = action({ input: aliased, public: true, run: ({ value }) => value });
export const opaque = action({ input: widened, public: true, run: (value) => value });
`,
    });
    const valid = manifest.operations.find((entry) => entry.name === "valid")!;
    const opaque = manifest.operations.find((entry) => entry.name === "opaque")!;
    assert.equal(valid.input.runtimeSchema.status, "resolved");
    assert.equal(opaque.input.runtimeSchema.status, "unresolved");
    assert.ok(manifest.diagnostics.some((entry) => entry.code === "ARCH016" && entry.target === opaque.id));
  });

  it("retains missing required schemas as unresolved and not declared", async () => {
    const manifest = await analyze({
      "src/features/broken/index.ts": `
import { action, defineModel, event } from "typescript-on-rails";
export const brokenAction = action({ public: true, run: (value: unknown) => value });
export const BrokenModel = defineModel({ name: "BrokenModel" });
export const brokenEvent = event({ name: "brokenEvent" });
`,
    });
    const operation = manifest.operations.find((entry) => entry.name === "brokenAction")!;
    const model = manifest.models.find((entry) => entry.name === "BrokenModel")!;
    const event = manifest.events.find((entry) => entry.name === "brokenEvent")!;
    const records = [
      { id: operation.id, facet: operation.input.runtimeSchema },
      { id: model.id, facet: model.fields },
      { id: event.id, facet: event.payload },
    ];
    for (const record of records) {
      assert.equal(record.facet.status, "unresolved");
      assert.equal(record.facet.validator, "not-declared");
      assert.equal("provenance" in record.facet, false);
      assert.ok(manifest.diagnostics.some((entry) => entry.code === "ARCH016" && entry.target === record.id));
    }
  });

  it("retains declarations whose canonical identity encoding fails", async () => {
    const manifest = await analyze({
      "src/features/_/index.ts": `
import { action, object, string } from "typescript-on-rails";
export const validSourceName = action({ input: object({ value: string() }), public: true, run: ({ value }) => value });
`,
      "src/features/billing/index.ts": `
import { defineModel, string } from "typescript-on-rails";
export const escaped = defineModel({ name: "\\uD800", fields: { value: string() } });
`,
    });
    const operation = manifest.operations.find((entry) => entry.name === "validSourceName")!;
    const model = manifest.models.find((entry) => entry.name.length === 1)!;
    assert.equal(operation.id, null);
    assert.equal(model.id, null);
    assert.ok(manifest.diagnostics.some((entry) => entry.code === "ARCH014" && entry.file === operation.file));
    assert.ok(manifest.diagnostics.some((entry) => entry.code === "ARCH014" && entry.file === model.file));
  });
});

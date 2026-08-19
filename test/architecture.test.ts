import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { analyzeApplication, type ArchitectureManifest } from "../src/features/architecture/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function analyze(files: Readonly<Record<string, string>>): Promise<ArchitectureManifest> {
  const fixture = await createAppFixture(files);
  fixtures.push(fixture);
  return analyzeApplication(fixture.root);
}

function rules(manifest: ArchitectureManifest): string[] {
  return manifest.diagnostics.map((diagnostic) => diagnostic.rule);
}

const billingModel = `
import { defineModel, id, string } from "typescript-on-rails";
export const Invoice = defineModel({ name: "Invoice", fields: { id: id("Invoice"), title: string() } });
`;

const emptyBoundary = "export {};\n";

describe("architecture analyzer", () => {
  it("extracts a stable application manifest through aliases and type-only imports", async () => {
    const files = {
      "src/features/billing/model.ts": billingModel,
      "src/features/billing/actions.ts": `
import type { Buffer } from "node:buffer";
import { action as command, event, object, route, string } from "typescript-on-rails";
export const approveInvoice = command({ input: object({ id: string() }), permission: "invoice.approve", run: ({ id }) => id });
export const invoiceRoute = route({ method: "GET", path: "/invoices/:id", input: object({ id: string() }), permission: "invoice.read", handler: ({ id }) => id });
export const InvoicePaid = event({ name: "InvoicePaid", payload: object({ id: string() }) });
`,
      "src/features/billing/queries.ts": `
import { query, object, string } from "typescript-on-rails";
export const getInvoice = query({ input: object({ id: string() }), permission: "invoice.read", run: ({ id }) => id });
`,
      "src/features/billing/index.ts": `export { Invoice } from "./model.js"; export { approveInvoice, invoiceRoute, InvoicePaid } from "./actions.js"; export { getInvoice } from "./queries.js";`,
      "src/features/reports/index.ts": `import { getInvoice } from "@/features/billing"; export const report = getInvoice;`,
      "src/infra/email.ts": `
import { boolean, defineAdapterContract, implementAdapter, object, string } from "typescript-on-rails";
export const Email = defineAdapterContract({ name: "Email", operations: { send: { input: object({ to: string() }), output: boolean() } } });
export const email = implementAdapter(Email, { send: () => true });
`,
    };
    const first = await analyze(files);
    const second = await analyze(files);

    assert.equal(first.version, 1);
    assert.deepEqual(first.features.map((feature) => feature.name), ["billing", "reports"]);
    assert.deepEqual(first.models.map(({ name, feature }) => ({ name, feature })), [{ name: "Invoice", feature: "billing" }]);
    assert.deepEqual(first.operations.map(({ name, kind }) => ({ name, kind })), [
      { name: "approveInvoice", kind: "action" },
      { name: "getInvoice", kind: "query" },
    ]);
    assert.deepEqual(first.routes.map(({ name, method, path }) => ({ name, method, path })), [
      { name: "invoiceRoute", method: "GET", path: "/invoices/:id" },
    ]);
    assert.deepEqual(first.events.map(({ name }) => name), ["InvoicePaid"]);
    assert.deepEqual(first.adapters.map(({ name, kind }) => ({ name, kind })), [
      { name: "Email", kind: "contract" },
      { name: "email", kind: "implementation" },
    ]);
    assert.deepEqual(first.permissions, ["invoice.approve", "invoice.read"]);
    assert.deepEqual(first.dependencies.map(({ from, to }) => ({ from, to })), [{ from: "reports", to: "billing" }]);
    assert.ok(first.features.find((feature) => feature.name === "billing")?.exports.some((entry) => entry.name === "approveInvoice"));
    assert.deepEqual(first.diagnostics, []);
    assert.deepEqual({ ...first, root: "<root>" }, { ...second, root: "<root>" });
  });

  it("reports private feature imports with a public-boundary suggestion", async () => {
    const manifest = await analyze({
      "src/features/billing/index.ts": emptyBoundary,
      "src/features/billing/model.ts": billingModel,
      "src/features/reports/index.ts": `import { Invoice } from "../billing/model.js"; export { Invoice };`,
    });
    const diagnostic = manifest.diagnostics.find((entry) => entry.rule === "feature-boundary");
    assert.ok(diagnostic);
    assert.match(diagnostic.suggestion ?? "", /@\/features\/billing/);
  });

  it("enforces named, star, and external-package re-exports", async () => {
    const manifest = await analyze({
      "node_modules/vendor-sdk/package.json": `{"name":"vendor-sdk","types":"index.d.ts"}`,
      "node_modules/vendor-sdk/index.d.ts": `export declare const vendorValue: string;`,
      "node_modules/vendor-types/package.json": `{"name":"vendor-types","types":"index.d.ts"}`,
      "node_modules/vendor-types/index.d.ts": `export interface VendorType { readonly value: string }`,
      "src/features/billing/index.ts": emptyBoundary,
      "src/features/billing/actions.ts": `export const invoice = true; export const refund = true;`,
      "src/features/named/index.ts": `export { invoice as publicInvoice } from "../billing/actions.js";`,
      "src/features/named/view.client.ts": `export { refund } from "../billing/actions.js";`,
      "src/features/star/index.ts": `export * from "../billing/actions.js";`,
      "src/features/vendor/index.ts": `export { vendorValue } from "vendor-sdk";`,
      "src/features/types/index.ts": `export type { VendorType } from "vendor-types";`,
    });

    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-boundary" && entry.file.includes("features/named")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-boundary" && entry.file.includes("features/star")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.file.includes("view.client")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "external-io" && entry.target === "vendor-sdk"));
    assert.ok(!manifest.diagnostics.some((entry) => entry.rule === "external-io" && entry.target === "vendor-types"));
    assert.deepEqual(manifest.dependencies.map(({ from, to, symbols }) => ({ from, to, symbols })), [
      { from: "named", to: "billing", symbols: ["invoice", "refund"] },
      { from: "star", to: "billing", symbols: ["*"] },
    ]);
  });

  it("reports full feature cycles and missing public boundaries", async () => {
    const manifest = await analyze({
      "src/features/a/index.ts": `import "@/features/b"; export const a = 1;`,
      "src/features/b/index.ts": `import "@/features/c"; export const b = 1;`,
      "src/features/c/index.ts": `import "@/features/a"; export const c = 1;`,
      "src/features/orphan/model.ts": billingModel,
    });
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-cycle" && /a -> b -> c -> a/.test(entry.message)));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "public-boundary" && entry.file.endsWith("src/features/orphan")));
  });

  it("enforces runtime, domain/UI, and external IO boundaries", async () => {
    const manifest = await analyze({
      "src/features/account/index.ts": emptyBoundary,
      "src/features/account/view.client.ts": `import "./secret.server.js"; import "node:fs"; import { changeBilling } from "@/features/billing"; export const view = changeBilling;`,
      "src/features/account/namespace.client.ts": `import * as billing from "@/features/billing"; export const namespace = billing;`,
      "src/features/account/secret.server.ts": `export const secret = true;`,
      "src/features/billing/actions.ts": `import { action, object } from "typescript-on-rails"; export const changeBilling = action({ input: object({}), public: true, run: () => true });`,
      "src/features/billing/index.ts": `export { changeBilling } from "./actions.js";`,
      "src/features/account/model.ts": `import "./ui/card.js"; import vendor from "vendor-sdk"; export const value = vendor;`,
      "src/features/account/ui/card.ts": `export const card = true;`,
    });
    assert.ok(rules(manifest).includes("runtime-boundary"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.target === "@/features/billing"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.file.endsWith("namespace.client.ts")));
    assert.ok(rules(manifest).includes("domain-ui"));
    assert.ok(rules(manifest).includes("external-io"));
  });

  it("restricts privileged Node IO while allowing pure and type-only imports", async () => {
    const manifest = await analyze({
      "src/features/account/index.ts": `
import type { PathLike } from "node:fs";
import path from "node:path";
import fs from "node:fs";
import childProcess from "node:child_process";
export { path, fs, childProcess };
export type { PathLike };
`,
    });
    const targets = manifest.diagnostics.filter((entry) => entry.rule === "external-io").map((entry) => entry.target);
    assert.deepEqual(targets, ["node:fs", "node:child_process"]);
    assert.ok(!targets.includes("node:path"));
  });

  it("extracts deterministic static contracts and ignores object order and implementation bodies", async () => {
    const first = await analyze({
      "src/features/billing/index.ts": `
import { action, boolean, defineAdapterContract, defineModel, event, id, object, string } from "typescript-on-rails";
export const Invoice = defineModel({ name: "Invoice", fields: { title: string(), id: id("Invoice") } });
export const approve = action({ permission: "invoice.approve", input: object({ id: string() }), output: boolean(), run: () => true });
export const Paid = event({ name: "Paid", payload: object({ id: string() }) });
export const Payments = defineAdapterContract({ name: "Payments", operations: { charge: { output: boolean(), input: object({ id: string() }) } } });
`,
    });
    const second = await analyze({
      "src/features/billing/index.ts": `
import { action, boolean, defineAdapterContract, defineModel, event, id, object, string } from "typescript-on-rails";
export const Invoice = defineModel({ fields: { id: id("Invoice"), title: string() }, name: "Invoice" });
export const approve = action({ input: object({ id: string() }), output: boolean(), permission: "invoice.approve", run: () => false });
export const Paid = event({ payload: object({ id: string() }), name: "Paid" });
export const Payments = defineAdapterContract({ operations: { charge: { input: object({ id: string() }), output: boolean() } }, name: "Payments" });
`,
    });
    assert.deepEqual(first.models.map((entry) => entry.contract), second.models.map((entry) => entry.contract));
    assert.deepEqual(first.operations.map((entry) => entry.contract), second.operations.map((entry) => entry.contract));
    assert.deepEqual(first.events.map((entry) => entry.contract), second.events.map((entry) => entry.contract));
    assert.deepEqual(first.adapters.map((entry) => entry.contract), second.adapters.map((entry) => entry.contract));
    assert.equal(first.models[0]?.contract, `{fields:{"id":id("Invoice"),"title":string()}}`);
    assert.equal(first.operations[0]?.contract, `{input:object({"id":string()}),output:boolean(),access:permission:"invoice.approve"}`);
    assert.equal(first.events[0]?.contract, `{payload:object({"id":string()})}`);
    assert.equal(first.adapters[0]?.contract, `{operations:{"charge":{"input":object({"id":string()}),"output":boolean()}}}`);
  });

  it("rejects non-boring TypeScript constructs", async () => {
    const manifest = await analyze({
      "src/features/unsafe/index.ts": emptyBoundary,
      "src/features/unsafe/unsafe.ts": `
let loose: any;
const sure = loose!;
const cast = loose as string;
const later = import("./other.js");
const old = require("./other.js");
function mark<T extends new (...args: never[]) => object>(value: T): T { return value; }
@mark class Decorated {}
export { loose, sure, cast, later, old, Decorated };
`,
      "src/features/unsafe/other.ts": `export const other = true;`,
    });
    const boring = manifest.diagnostics.filter((entry) => entry.rule === "boring-typescript");
    assert.ok(boring.length >= 6);
    assert.ok(boring.some((entry) => /Decorators/.test(entry.message)));
  });

  it("reports public any types, vendor type leakage, and duplicate model owners", async () => {
    const manifest = await analyze({
      "node_modules/vendor-sdk/package.json": `{"name":"vendor-sdk","types":"index.d.ts"}`,
      "node_modules/vendor-sdk/index.d.ts": `export interface VendorResult { token: string } export function fetchResult(): VendorResult;`,
      "src/infra/vendor.ts": `import { fetchResult } from "vendor-sdk"; export const fetchVendor = fetchResult;`,
      "src/features/a/model.ts": billingModel,
      "src/features/a/index.ts": `export const unsafe: any = 1; export { fetchVendor } from "../../infra/vendor.js"; export { Invoice } from "./model.js";`,
      "src/features/b/model.ts": billingModel,
      "src/features/b/index.ts": `export { Invoice } from "./model.js";`,
    });
    assert.ok(rules(manifest).includes("public-api-type"));
    assert.ok(rules(manifest).includes("vendor-type-leak"));
    assert.ok(rules(manifest).includes("data-owner"));
  });

  it("applies only valid, exact, file-local architecture allowances", async () => {
    const manifest = await analyze({
      "src/features/account/index.ts": emptyBoundary,
      "src/features/account/suppressed.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "external-io", reason: "Required vendor boundary during migration", target: "vendor-ok" });
import ok from "vendor-ok";
import bad from "vendor-bad";
export { ok, bad };
`,
      "src/features/account/expired.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "external-io", reason: "Old migration", expires: "2000-01-01" });
import old from "vendor-old";
export { old };
`,
      "src/features/account/bad-reason.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "external-io", reason: "   " });
import nope from "vendor-nope";
export { nope };
`,
      "src/features/account/impossible-date.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "external-io", reason: "Impossible date", expires: "2099-02-30" });
import future from "vendor-future";
export { future };
`,
    });
    const externalTargets = manifest.diagnostics
      .filter((entry) => entry.rule === "external-io")
      .map((entry) => entry.target);
    assert.ok(!externalTargets.includes("vendor-ok"));
    assert.ok(externalTargets.includes("vendor-bad"));
    assert.ok(externalTargets.includes("vendor-old"));
    assert.ok(externalTargets.includes("vendor-nope"));
    assert.ok(externalTargets.includes("vendor-future"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "architecture-allowance" && /valid YYYY-MM-DD/.test(entry.message)));
    assert.equal(manifest.exceptions.length, 4);
    assert.equal(manifest.exceptions.filter((entry) => entry.valid).length, 1);
  });

  it("does not classify the installed framework's declarations as vendor types", async () => {
    const fixture = await createAppFixture({
      "node_modules/typescript-on-rails/package.json": `{"name":"typescript-on-rails","type":"module","types":"index.d.ts"}`,
      "node_modules/typescript-on-rails/index.d.ts": `
export interface FrameworkOperation {
  readonly kind: "operation";
  execute(input: unknown): Promise<unknown>;
}
export function object(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
export function action(definition: {
  readonly input: unknown;
  readonly public: true;
  readonly run: () => unknown;
}): FrameworkOperation;
`,
      "src/features/health/index.ts": `
import { action, object } from "typescript-on-rails";
export const health = action({ input: object({}), public: true, run: () => "ok" });
`,
    });
    fixtures.push(fixture);
    await fixture.write("tsconfig.json", `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2)}\n`);

    const manifest = analyzeApplication(fixture.root);

    assert.ok(!manifest.diagnostics.some((entry) => (
      entry.rule === "vendor-type-leak" && entry.target === "health"
    )));
  });

  it("traces public vendor types without an arbitrary depth limit", async () => {
    const manifest = await analyze({
      "node_modules/vendor-sdk/package.json": `{"name":"vendor-sdk","types":"index.d.ts"}`,
      "node_modules/vendor-sdk/index.d.ts": `export interface VendorResult { token: string }`,
      "src/features/deep/index.ts": `
import type { VendorResult } from "vendor-sdk";
interface LevelEight { value: VendorResult }
interface LevelSeven { value: LevelEight }
interface LevelSix { value: LevelSeven }
interface LevelFive { value: LevelSix }
interface LevelFour { value: LevelFive }
interface LevelThree { value: LevelFour }
interface LevelTwo { value: LevelThree }
interface LevelOne { value: LevelTwo }
export const deepLeak: LevelOne = { value: { value: { value: { value: { value: { value: { value: { value: { token: "secret" } } } } } } } } };
`,
    });

    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "vendor-type-leak" && entry.target === "deepLeak"));
  });

  it("captures concise TypeScript diagnostics", async () => {
    const manifest = await analyze({
      "src/features/broken/index.ts": `export const count: number = "wrong";`,
    });
    const diagnostic = manifest.diagnostics.find((entry) => entry.rule === "typescript");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /not assignable to type 'number'/);
  });
});

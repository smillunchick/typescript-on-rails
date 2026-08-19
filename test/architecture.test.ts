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
      "src/features/account/secret.server.ts": `export const secret = true;`,
      "src/features/billing/actions.ts": `import { action, object } from "typescript-on-rails"; export const changeBilling = action({ input: object({}), public: true, run: () => true });`,
      "src/features/billing/index.ts": `export { changeBilling } from "./actions.js";`,
      "src/features/account/model.ts": `import "./ui/card.js"; import vendor from "vendor-sdk"; export const value = vendor;`,
      "src/features/account/ui/card.ts": `export const card = true;`,
    });
    assert.ok(rules(manifest).includes("runtime-boundary"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.target === "@/features/billing"));
    assert.ok(rules(manifest).includes("domain-ui"));
    assert.ok(rules(manifest).includes("external-io"));
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
    });
    const externalTargets = manifest.diagnostics
      .filter((entry) => entry.rule === "external-io")
      .map((entry) => entry.target);
    assert.ok(!externalTargets.includes("vendor-ok"));
    assert.ok(externalTargets.includes("vendor-bad"));
    assert.ok(externalTargets.includes("vendor-old"));
    assert.ok(externalTargets.includes("vendor-nope"));
    assert.ok(manifest.diagnostics.filter((entry) => entry.rule === "architecture-allowance").length >= 2);
    assert.equal(manifest.exceptions.length, 3);
    assert.equal(manifest.exceptions.filter((entry) => entry.valid).length, 1);
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

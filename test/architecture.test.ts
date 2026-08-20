import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import {
  analyzeApplication,
  type AnalyzeApplicationOptions,
  type ArchitectureManifest,
  type PackageCapability,
} from "../src/features/architecture/index.js";
import { resolveSourceRole } from "../src/infra/typescript/source-role.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function analyze(
  files: Readonly<Record<string, string>>,
  options?: AnalyzeApplicationOptions,
): Promise<ArchitectureManifest> {
  const fixture = await createAppFixture(files);
  fixtures.push(fixture);
  return analyzeApplication(fixture.root, options);
}

function policyPackageJson(packageCapabilities: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ private: true, typescriptOnRails: { packageCapabilities } });
}

function capabilities(entries: Readonly<Record<string, PackageCapability>>): AnalyzeApplicationOptions {
  return { packageCapabilities: entries };
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

    assert.equal(first.version, 2);
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
    assert.deepEqual(first, second);
    assert.equal("root" in first, false);
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
    }, capabilities({ "vendor-sdk": "external-system" }));

    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-boundary" && entry.file.includes("features/named")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-boundary" && entry.file.includes("features/star")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.file.includes("view.client")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "package-capability" && entry.target === "vendor-sdk"));
    assert.ok(!manifest.diagnostics.some((entry) => entry.rule === "package-capability" && entry.target === "vendor-types"));
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
    assert.ok(rules(manifest).includes("package-capability"));
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
    const targets = manifest.diagnostics.filter((entry) => entry.rule === "package-capability").map((entry) => entry.target);
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
    assert.deepEqual(first.models.map((entry) => entry.fields), second.models.map((entry) => entry.fields));
    assert.deepEqual(first.operations.map(({ input, output, access }) => ({ input, output, access })), second.operations.map(({ input, output, access }) => ({ input, output, access })));
    assert.deepEqual(first.events.map((entry) => entry.payload), second.events.map((entry) => entry.payload));
    assert.deepEqual(first.adapters, second.adapters);
    assert.ok([...first.models, ...first.operations, ...first.events, ...first.adapters].every((entry) => !("contract" in entry)));
    assert.equal(first.models[0]?.fields.status, "resolved");
    assert.equal(first.operations[0]?.input.runtimeSchema.status, "resolved");
    assert.equal(first.operations[0]?.output.runtimeSchema.status, "resolved");
    assert.equal(first.operations[0]?.access, "permission");
    assert.equal(first.events[0]?.payload.status, "resolved");
    assert.equal(first.adapters[0]?.kind, "contract");
    if (first.adapters[0]?.kind === "contract") assert.equal(first.adapters[0].operations.status, "resolved");
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
    assert.ok(boring.length >= 5);
    assert.ok(boring.some((entry) => /Decorators/.test(entry.message)));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "dynamic-import"));
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
architecture.allow({ rule: "package-capability", reason: "Required vendor boundary during migration", target: "vendor-ok" });
import ok from "vendor-ok";
import bad from "vendor-bad";
export { ok, bad };
`,
      "src/features/account/expired.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "package-capability", reason: "Old migration", expires: "2000-01-01" });
import old from "vendor-old";
export { old };
`,
      "src/features/account/bad-reason.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "package-capability", reason: "   " });
import nope from "vendor-nope";
export { nope };
`,
      "src/features/account/impossible-date.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "package-capability", reason: "Impossible date", expires: "2099-02-30" });
import future from "vendor-future";
export { future };
`,
    }, capabilities({
      "vendor-ok": "external-system",
      "vendor-bad": "external-system",
      "vendor-old": "external-system",
      "vendor-nope": "external-system",
      "vendor-future": "external-system",
    }));
    const externalTargets = manifest.diagnostics
      .filter((entry) => entry.rule === "package-capability")
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

  it("applies pure, UI, external-system, and host-I/O boundaries by current role", async () => {
    const manifest = await analyze({
      "src/features/orders/index.ts": emptyBoundary,
      "src/features/orders/model.ts": `
import dateLibrary from "date-library";
import stripeLike from "stripe-like";
export const values = [dateLibrary, stripeLike];
`,
      "src/features/orders/ui/view.ts": `import uiLibrary from "ui-library"; export const view = uiLibrary;`,
      "src/infra/gateway.ts": `import stripeLike from "stripe-like"; import hostTool from "host-tool"; export { stripeLike, hostTool };`,
      "src/app.ts": `
import hostTool from "host-tool";
import uiLibrary from "ui-library";
export { hostTool, uiLibrary };
`,
    }, capabilities({
      "date-library": "pure",
      "ui-library": "ui",
      "stripe-like": "external-system",
      "host-tool": "host-io",
    }));

    const denials = manifest.diagnostics.filter((entry) => entry.rule === "package-capability");
    assert.deepEqual(denials.map((entry) => entry.target), ["host-tool", "ui-library", "stripe-like"]);
    assert.match(denials.find((entry) => entry.target === "stripe-like")?.message ?? "", /external-system.*domain.*infrastructure code only/);
    assert.match(denials.find((entry) => entry.target === "ui-library")?.message ?? "", /ui.*application.*UI\/client code only/);
    assert.deepEqual(manifest.packagePolicy, [
      { package: "date-library", capability: "pure" },
      { package: "host-tool", capability: "host-io" },
      { package: "stripe-like", capability: "external-system" },
      { package: "ui-library", capability: "ui" },
    ]);
    assert.ok(manifest.packageUses.some((entry) => entry.package === "date-library" && entry.capability === "pure"));
    assert.ok(manifest.packageUses.some((entry) => entry.package === "stripe-like" && entry.file === "src/infra/gateway.ts"));
  });

  it("uses exactly one policy source and treats a present empty option as a full replacement", async () => {
    const files = {
      "package.json": policyPackageJson({ "date-library": "pure" }),
      "src/features/dates/index.ts": `import dateLibrary from "date-library"; export { dateLibrary };`,
    };
    const filePolicy = await analyze(files);
    const emptyReplacement = await analyze(files, capabilities({}));
    const nonemptyReplacement = await analyze(files, capabilities({ "other-library": "pure" }));

    assert.deepEqual(filePolicy.packagePolicy, [{ package: "date-library", capability: "pure" }]);
    assert.deepEqual(filePolicy.diagnostics.filter((entry) => entry.rule === "package-capability"), []);
    assert.deepEqual(emptyReplacement.packagePolicy, []);
    assert.deepEqual(nonemptyReplacement.packagePolicy, [{ package: "other-library", capability: "pure" }]);
    assert.ok(nonemptyReplacement.diagnostics.some((entry) => (
      entry.packageCapabilityMigration?.inventory.some((item) => item.package === "date-library") === true
    )));
    const migration = emptyReplacement.diagnostics.find((entry) => entry.packageCapabilityMigration !== undefined);
    assert.deepEqual(migration?.packageCapabilityMigration?.inventory.map((entry) => entry.package), ["date-library"]);

    const malformedFile = await analyze({
      "package.json": "not json",
      "src/features/health/index.ts": emptyBoundary,
    }, capabilities({}));
    assert.ok(!malformedFile.diagnostics.some((entry) => entry.rule === "package-policy"));
  });

  it("normalizes scoped roots and gives an exact scoped subpath policy precedence", async () => {
    const manifest = await analyze({
      "src/features/ui/index.ts": `
import root from "@scope/library";
import browser from "@scope/library/browser";
import server from "@scope/library/server";
export { root, browser, server };
`,
    }, capabilities({
      "@scope/library": "pure",
      "@scope/library/server": "external-system",
    }));

    assert.deepEqual(manifest.packageUses.map(({ package: packageName, capability }) => ({ package: packageName, capability })), [
      { package: "@scope/library", capability: "pure" },
      { package: "@scope/library/browser", capability: "pure" },
      { package: "@scope/library/server", capability: "external-system" },
    ]);
    assert.ok(manifest.diagnostics.some((entry) => entry.target === "@scope/library/server"));
    assert.ok(!manifest.diagnostics.some((entry) => entry.rule === "package-policy"));
  });

  it("checks all supported static value import and export forms but excludes type-only forms", async () => {
    const manifest = await analyze({
      "src/features/forms/index.ts": `
import defaultValue from "default-package";
import * as namespaceValue from "namespace-package";
import defaultWithType, { type DefaultCompanion } from "default-companion-package";
import { type MixedType, mixedValue } from "mixed-package";
import "side-effect-package";
import type TypeDefault from "type-default-package";
export { namedValue } from "named-export-package";
export * from "star-export-package";
export * as exportedNamespace from "namespace-export-package";
export type { TypeOnly } from "type-export-package";
export { type TypeOnly as AnotherType } from "type-export-package";
export { defaultValue, defaultWithType, namespaceValue, mixedValue };
export type { DefaultCompanion, MixedType, TypeDefault };
`,
    }, capabilities({
      "default-package": "pure",
      "default-companion-package": "pure",
      "namespace-package": "pure",
      "mixed-package": "pure",
      "side-effect-package": "pure",
      "named-export-package": "pure",
      "star-export-package": "pure",
      "namespace-export-package": "pure",
    }));

    assert.deepEqual(manifest.packageUses.map((entry) => entry.package), [
      "default-companion-package",
      "default-package",
      "mixed-package",
      "named-export-package",
      "namespace-export-package",
      "namespace-package",
      "side-effect-package",
      "star-export-package",
    ]);
    assert.ok(!manifest.packageUses.some((entry) => entry.package.includes("type-")));
    assert.ok(!manifest.diagnostics.some((entry) => entry.packageCapabilityMigration !== undefined));
  });

  it("canonicalizes Node identities and keeps framework-owned capabilities authoritative", async () => {
    const manifest = await analyze({
      "src/features/node/index.ts": `
import fsBare from "fs";
import fsNode from "node:fs";
import pathBare from "path";
import pathNode from "node:path";
export { fsBare, fsNode, pathBare, pathNode };
`,
    }, capabilities({
      fs: "pure",
      path: "pure",
      "node:path": "pure",
    }));

    assert.deepEqual(manifest.packagePolicy, [{ package: "node:path", capability: "pure" }]);
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "package-policy" && /framework-owned node:fs/.test(entry.message)));
    assert.deepEqual(manifest.packageUses.map(({ package: packageName, capability }) => ({ package: packageName, capability })), [
      { package: "node:fs", capability: "host-io" },
      { package: "node:fs", capability: "host-io" },
      { package: "node:path", capability: "pure" },
      { package: "node:path", capability: "pure" },
    ]);
    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "package-capability" && entry.target === "node:fs").length, 2);
    assert.ok(!manifest.diagnostics.some((entry) => entry.rule === "package-capability" && entry.target === "node:path"));
  });

  it("retains external package evidence at a local barrel origin", async () => {
    const manifest = await analyze({
      "src/shared/vendor.ts": `export { externalValue } from "external-package/subpath";`,
      "src/features/barrel/index.ts": `export { externalValue } from "../../shared/vendor.js";`,
    }, capabilities({ "external-package": "pure" }));

    assert.deepEqual(manifest.packageUses, [{
      package: "external-package/subpath",
      capability: "pure",
      file: "src/shared/vendor.ts",
      line: 1,
    }]);
  });

  it("reports distinct source and validation failures without granting invalid entries", async () => {
    const missingFixture = await createAppFixture({ "src/features/health/index.ts": emptyBoundary }, { packageJson: "missing" });
    fixtures.push(missingFixture);
    const missingPackage = analyzeApplication(missingFixture.root);
    const malformedJson = await analyze({ "package.json": "{", "src/features/health/index.ts": emptyBoundary });
    const missingPolicy = await analyze({ "package.json": `{ "private": true }`, "src/features/health/index.ts": emptyBoundary });
    const malformedPolicy = await analyze({
      "package.json": JSON.stringify({ typescriptOnRails: { packageCapabilities: [] } }),
      "src/features/health/index.ts": emptyBoundary,
    });
    const invalidEntries = await analyze({
      "package.json": policyPackageJson({
        "bad key": "pure",
        "root-package": "pure",
        "root-package/blocked": "maybe",
        vendor: "maybe",
        fs: "host-io",
        "node:fs": "pure",
      }),
      "src/features/vendor/index.ts": `
import fs from "node:fs";
import blocked from "root-package/blocked";
import hidden from "#external-package";
import unknown from "unknown-package";
import vendor from "vendor";
export { fs, blocked, hidden, unknown, vendor };
`,
    });

    assert.match(missingPackage.diagnostics.find((entry) => entry.rule === "package-policy")?.message ?? "", /package.json was not found/);
    assert.match(malformedJson.diagnostics.find((entry) => entry.rule === "package-policy")?.message ?? "", /not valid JSON/);
    assert.match(missingPolicy.diagnostics.find((entry) => entry.rule === "package-policy")?.message ?? "", /policy is missing/);
    assert.match(malformedPolicy.diagnostics.find((entry) => entry.rule === "package-policy")?.message ?? "", /packageCapabilities must be an object/);
    assert.ok(invalidEntries.diagnostics.some((entry) => entry.rule === "package-policy" && /Invalid package capability key/.test(entry.message)));
    assert.ok(invalidEntries.diagnostics.some((entry) => entry.rule === "package-policy" && /Invalid capability/.test(entry.message)));
    assert.ok(invalidEntries.diagnostics.some((entry) => entry.rule === "package-policy" && /Conflicting package capability keys/.test(entry.message)));
    assert.ok(invalidEntries.diagnostics.some((entry) => (
      entry.rule === "package-capability"
      && entry.target === "#external-package"
      && /cannot be mapped to an exact package capability key/.test(entry.message)
    )));
    assert.ok(invalidEntries.diagnostics.some((entry) => entry.packageCapabilityMigration?.inventory.some((item) => item.package === "unknown-package") === true));
    assert.ok(!invalidEntries.packageUses.some((entry) => entry.package === "vendor"));
    assert.ok(!invalidEntries.packageUses.some((entry) => entry.package === "root-package/blocked"));
    assert.ok(invalidEntries.packageUses.some((entry) => (
      entry.package === "node:fs" && entry.capability === "host-io"
    )));
  });

  it("guides callers away from the removed option and emits a deterministic non-writing starter map", async () => {
    const fixture = await createAppFixture({
      "src/features/unknown/index.ts": `
import { architecture } from "typescript-on-rails";
architecture.allow({ rule: "package-capability", reason: "An unknown effect cannot be waived" });
import second from "zeta/subpath";
import first from "alpha";
import again from "zeta/other";
export { second, first, again };
`,
    });
    fixtures.push(fixture);
    const packageFile = path.join(fixture.root, "package.json");
    const before = await readFile(packageFile, "utf8");
    const legacyOptions: AnalyzeApplicationOptions & { readonly allowedExternalPackages: readonly string[] } = {
      packageCapabilities: {},
      allowedExternalPackages: ["alpha"],
    };
    const manifest = analyzeApplication(fixture.root, legacyOptions);
    const after = await readFile(packageFile, "utf8");

    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "package-policy" && /allowedExternalPackages was removed/.test(entry.message)));
    const migration = manifest.diagnostics.find((entry) => entry.packageCapabilityMigration !== undefined)?.packageCapabilityMigration;
    assert.deepEqual(migration?.inventory, [
      { package: "alpha", uses: [{ file: "src/features/unknown/index.ts", line: 5 }] },
      { package: "zeta", uses: [
        { file: "src/features/unknown/index.ts", line: 4 },
        { file: "src/features/unknown/index.ts", line: 6 },
      ] },
    ]);
    assert.deepEqual(migration?.packageCapabilities, {
      alpha: "CHOOSE: pure | ui | external-system | host-io",
      zeta: "CHOOSE: pure | ui | external-system | host-io",
    });
    assert.equal(before, after);
  });

  it("scopes source-role path signals to the application root", () => {
    const sourceFile = ts.createSourceFile(
      "/workspace/ui/application/src/app.ts",
      "export const app = true;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    assert.deepEqual(resolveSourceRole("/workspace/ui/application", sourceFile).effectiveRoles, ["application"]);
  });

  it("allows literal dynamic imports in UI and infrastructure and records namespace dependencies, packages, and cycles", async () => {
    const manifest = await analyze({
      "src/features/a/index.ts": emptyBoundary,
      "src/features/a/ui/view.ts": `void import("@/features/b"); void import("ui-library");`,
      "src/features/b/index.ts": emptyBoundary,
      "src/features/b/view.client.ts": "void import(`@/features/a`);",
      "src/infra/lazy.ts": "void import(`external-library`);",
    }, capabilities({
      "ui-library": "ui",
      "external-library": "external-system",
    }));

    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "dynamic-import").length, 0);
    assert.deepEqual(manifest.dependencies.map(({ from, to, symbols }) => ({ from, to, symbols })), [
      { from: "a", to: "b", symbols: ["*"] },
      { from: "b", to: "a", symbols: ["*"] },
    ]);
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-cycle" && /a -> b -> a/.test(entry.message)));
    assert.deepEqual(manifest.packageUses.map((entry) => entry.package), ["external-library", "ui-library"]);
  });

  it("denies literal dynamic imports in domain and application roles and rejects every computed form in every role", async () => {
    const computed = `
const part = "target";
void import(\`./\${part}.js\`);
void import("./" + part);
void import(part);
void import();
`;
    const manifest = await analyze({
      "src/features/roles/index.ts": emptyBoundary,
      "src/features/roles/model.ts": `void import("./target.js"); ${computed}`,
      "src/features/roles/ui/view.ts": computed,
      "src/infra/computed.ts": computed,
      "src/app.ts": `void import("./target.js"); ${computed}`,
      "src/features/roles/target.ts": `export const target = true;`,
    });

    const dynamic = manifest.diagnostics.filter((entry) => entry.rule === "dynamic-import");
    assert.equal(dynamic.filter((entry) => /not allowed for source role/.test(entry.message)).length, 2);
    assert.equal(dynamic.filter((entry) => /requires one string literal/.test(entry.message)).length, 16);
    assert.ok(dynamic.some((entry) => entry.file.endsWith("model.ts") && /domain/.test(entry.message)));
    assert.ok(dynamic.some((entry) => entry.file.endsWith("app.ts") && /application/.test(entry.message)));
  });

  it("keeps literal dynamic imports in normal boundary, alias, runtime, and package analysis", async () => {
    const manifest = await analyze({
      "src/features/a/index.ts": emptyBoundary,
      "src/features/a/view.client.ts": `
void import("../b/private.js");
void import("@/infra/tool.js");
void import("./secret.server.js");
void import("vendor-sdk");
void import("missing-sdk/subpath");
`,
      "src/features/a/secret.server.ts": `export const secret = true;`,
      "src/features/a/model.ts": `void import("./ui/card.js"); void import("./ui/types.js");`,
      "src/features/a/ui/card.ts": `export const card = true;`,
      "src/features/a/ui/types.d.ts": `export declare const types: true;`,
      "src/features/b/index.ts": emptyBoundary,
      "src/features/b/private.ts": `export const privateValue = true;`,
      "src/infra/tool.ts": `export const tool = true;`,
    }, capabilities({ "vendor-sdk": "external-system" }));

    assert.ok(manifest.dependencies.some((entry) => entry.from === "a" && entry.to === "b" && entry.symbols.includes("*")));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "feature-boundary" && entry.target === "b"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.target === "@/infra/tool.js"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "runtime-boundary" && entry.target === "./secret.server.js"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "domain-ui" && entry.target === "./ui/card.js"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "domain-ui" && entry.target === "./ui/types.js"));
    assert.ok(manifest.diagnostics.some((entry) => entry.rule === "package-capability" && entry.target === "vendor-sdk"));
    assert.ok(manifest.diagnostics.some((entry) => entry.packageCapabilityMigration?.inventory.some((item) => item.package === "missing-sdk") === true));
    assert.ok(manifest.packageUses.some((entry) => entry.package === "vendor-sdk"));
  });

  it("reports role conflicts once and applies the strict role union without granting dynamic or package access", async () => {
    const manifest = await analyze({
      "src/features/roles/index.ts": emptyBoundary,
      "src/features/roles/model.ts": `"use client"; void import("ui-library");`,
      "src/features/roles/ui/policy.ts": `void import("ui-library");`,
      "src/infra/ui/view.ts": `void import("ui-library"); void import("external-library");`,
    }, capabilities({
      "ui-library": "ui",
      "external-library": "external-system",
    }));

    const conflicts = manifest.diagnostics.filter((entry) => entry.rule === "source-role");
    assert.equal(conflicts.length, 3);
    assert.equal(conflicts.filter((entry) => /ui\/client/.test(entry.message) && /domain/.test(entry.message)).length, 2);
    assert.ok(conflicts.some((entry) => /infrastructure/.test(entry.message) && /ui\/client/.test(entry.message)));
    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "dynamic-import").length, 2);
    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "package-capability" && entry.target === "ui-library").length, 3);
    assert.equal(manifest.diagnostics.filter((entry) => entry.rule === "package-capability" && entry.target === "external-library").length, 1);
    assert.equal(manifest.packageUses.filter((entry) => entry.package === "ui-library").length, 3);
  });

  it("keeps unsafe TypeScript and all require forms global in every source role", async () => {
    const unsafe = `
import legacy = require("legacy");
let value: any;
value!;
value as string;
require("legacy");
function mark<T extends new (...args: never[]) => object>(item: T): T { return item; }
@mark class Decorated {}
export { value, Decorated };
`;
    const manifest = await analyze({
      "src/features/unsafe/index.ts": emptyBoundary,
      "src/features/unsafe/model.ts": unsafe,
      "src/features/unsafe/ui/view.ts": unsafe,
      "src/infra/unsafe.ts": unsafe,
      "src/app.ts": unsafe,
    });

    for (const file of ["model.ts", "ui/view.ts", "infra/unsafe.ts", "app.ts"]) {
      const messages = manifest.diagnostics
        .filter((entry) => entry.rule === "boring-typescript" && entry.file.endsWith(file))
        .map((entry) => entry.message);
      assert.ok(messages.some((message) => /Explicit any/.test(message)), file);
      assert.ok(messages.some((message) => /Non-null/.test(message)), file);
      assert.ok(messages.some((message) => /Unchecked type assertions/.test(message)), file);
      assert.ok(messages.some((message) => /Dynamic require/.test(message)), file);
      assert.ok(messages.some((message) => /import = require/.test(message)), file);
      assert.ok(messages.some((message) => /Decorators/.test(message)), file);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  action,
  analyzeApplicationV3,
  defineApp,
  defineFeature,
  defineRepository,
  consumer,
  schedule,
  defineModel,
  diffArchitectureV3,
  emailContract,
  entrypoint,
  event,
  implementAdapter,
  migrateManifestV2,
  migratePackageCapabilityV1,
  resolvePackageCapabilitiesV2,
  object,
  page,
  route,
  string,
} from "../src/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

describe("Manifest v3 executable application graph", () => {
  it("adds executable composition without changing Manifest v2", async () => {
    const fixture = await createAppFixture({
      "src/features/billing/index.ts": "export { Invoice } from './model.js'; export function invoiceTotal() { return 1; }\n",
      "src/features/billing/model.ts": "import { defineModel, string } from 'typescript-on-rails'; export const Invoice = defineModel({ name: 'Invoice', fields: { id: string() } });\n",
      "src/app/api/health/route.ts": "export function GET() { return new Response('ok'); }\n",
      "test/billing.test.ts": "export {};\n",
    });
    try {
      const Invoice = defineModel({ name: "Invoice", fields: { id: string() } });
      const InvoicePaid = event({ name: "InvoicePaid", payload: object({ invoiceId: string() }) });
      const health = route({ method: "GET", path: "/api/health", public: true, output: object({ status: string() }), handler: () => ({ status: "ok" }) });
      const email = implementAdapter(emailContract, {
        send: ({ idempotencyKey }) => ({ messageId: idempotencyKey, replayed: false }),
      }, { provider: "test", suitability: "production" });
      const createInvoice = action({ input: object({ name: string() }), permission: "invoice.create", run: ({ name }) => ({ name }) });
      const app = defineApp({
        adapters: { email },
        features: [defineFeature({
          name: "billing",
          models: [Invoice],
          operations: { createInvoice },
          routes: [health],
          pages: [page({ name: "invoices", path: "/invoices", runtime: "hybrid", permission: "invoice.read" })],
          permissions: ["invoice.create", "invoice.read"],
          events: [InvoicePaid],
          adapters: [emailContract],
          tests: ["test/billing.test.ts"],
        })],
        entrypoints: { web: entrypoint({ name: "web", process: "web", run: () => undefined }) },
      });
      const v3 = analyzeApplicationV3(fixture.root, { application: app });
      assert.equal(v3.version, 3);
      assert.equal(v3.base.version, 2);
      assert.equal(v3.compiler.compositionProtocolVersion, 4);
      assert.ok(v3.composition.some((record) => record.kind === "model" && record.name === "Invoice" && record.detail?.source !== undefined));
      assert.ok(v3.composition.some((record) => record.kind === "operation" && record.name === "createInvoice"));
      assert.ok(v3.composition.some((record) => record.kind === "entrypoint" && record.name === "web"));
      assert.ok(v3.composition.some((record) => record.kind === "adapter" && record.owner === "billing" && record.detail?.role === "required"));
      assert.deepEqual(v3.composition.find((record) => record.kind === "adapter" && record.owner === "application")?.detail, {
        role: "registered",
        provider: "test",
        suitability: "production",
        operations: ["send"],
      });
      assert.equal(v3.linkage.protocolVersion, 4);
      assert.equal(v3.completeness.counts["discovered-undeclared"], 0);
      assert.ok(v3.completeness.counts.unknown >= 1);
      assert.ok(v3.completeness.observations.some(({ kind }) => kind === "operation-context-observations"));
      assert.deepEqual(v3.linkage.links, [{
        kind: "feature-adapter",
        from: "rid1/adapter/billing/email",
        to: "rid1/adapter/application/email",
      }]);
      assert.equal(v3.completeness.complete, false);
      const missingModel = analyzeApplicationV3(fixture.root, { application: defineApp({ features: [defineFeature({ name: "billing" })] }) });
      assert.ok(missingModel.completeness.observations.some(({ category, kind, name }) => category === "discovered-undeclared" && kind === "model" && name === "billing.Invoice"));
      const migrated = migrateManifestV2(v3.base);
      assert.equal(migrated.base, v3.base);
      assert.equal(migrated.completeness.complete, false);
      assert.deepEqual(migrated.linkage.links, []);
      assert.equal(migrated.linkage.protocolVersion, 4);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reports bounded lexical context observations without runtime reachability claims", async () => {
    const fixture = await createAppFixture({
      "src/features/observe/index.ts": [
        'import { action, object, type ExecutionContext } from "typescript-on-rails";',
        'interface Context extends ExecutionContext { outbox: { append(value: unknown): void }; email: { send(): void }; nested: { run(): void }; dead: { run(): void } }',
        'export const inspect = action({ input: object({}), public: true, run: (_input, context: Context) => {',
        '  const alias = context.outbox;',
        '  alias.append({});',
        '  const { nested: nestedAlias } = context;',
        '  const { run: execute } = nestedAlias;',
        '  execute();',
        '  const shadow = (context: { dead: { run(): void } }) => context.dead.run();',
        '  context["email"].send();',
        '  const contextCache = { send() {} };',
        '  contextCache["send"]();',
        '  const helper = () => context.nested.run();',
        '  const delayed = () => late.send();',
        '  const late = context.email;',
        '  delayed();',
        '  if (false) context.dead.run();',
        '  helper();',
        '  return true;',
        '} });',
      ].join("\n") + "\n",
    });
    try {
      const inspect = action({ input: object({}), public: true, run: () => true });
      const application = defineApp({ features: [defineFeature({ name: "observe", operations: { inspect } })] });
      const manifest = analyzeApplicationV3(fixture.root, { application });
      const detail = manifest.composition.find(({ kind, name }) => kind === "operation" && name === "inspect")?.detail;
      assert.equal(detail?.contextObservationResolution, "resolved");
      const observations = detail?.contextObservations as readonly { readonly member: string; readonly state: string; readonly scope: string; readonly runtimeReachability: string }[];
      assert.deepEqual(observations.map(({ member, state, scope, runtimeReachability }) => ({ member, state, scope, runtimeReachability })), [
        { member: "context.outbox.append", state: "direct", scope: "run-body", runtimeReachability: "unknown" },
        { member: "context.nested.run", state: "direct", scope: "run-body", runtimeReachability: "unknown" },
        { member: "context[computed].send", state: "computed-unresolved", scope: "run-body", runtimeReachability: "unknown" },
        { member: "context.nested.run", state: "direct", scope: "nested-function", runtimeReachability: "unknown" },
        { member: "context.email.send", state: "direct", scope: "nested-function", runtimeReachability: "unknown" },
        { member: "context.dead.run", state: "direct", scope: "run-body", runtimeReachability: "unknown" },
      ]);
      assert.deepEqual(manifest.linkage.links, []);
    } finally { await fixture.cleanup(); }
  });

  it("keeps same-local-name provenance separate by owner and resolves framework symbols", async () => {
    const files: Record<string, string> = {
      "src/app.ts": 'import { defineApp } from "typescript-on-rails"; import { feature as billing } from "./features/billing/index.js"; import { feature as shipping } from "./features/shipping/index.js"; export const application = defineApp({ features: [billing, shipping] });\n',
      "src/factories.ts": 'export { consumer as consume, defineRepository as repository, schedule as recurring } from "typescript-on-rails";\n',
      "src/unrelated.ts": 'function consumer(value: unknown) { return value; } consumer({ name: "target" });\n',
    };
    const features = ["billing", "shipping"].map((owner) => {
      files[`src/features/${owner}/index.ts`] = [
        'import * as factories from "../../factories.js";',
        'import { defineFeature, event, object } from "typescript-on-rails";',
        `const Due = event({ owner: "${owner}", name: "Due", payload: object({}) });`,
        'export const target = factories.consume({ name: "target", event: Due, durable: true, handle: () => undefined });',
        `export const records = factories.repository({ name: "records", feature: "${owner}", relations: ["${owner}.records"] });`,
        `export const daily = factories.recurring({ name: "daily", feature: "${owner}", target, occurrences: () => [] });`,
        `export const feature = defineFeature({ name: "${owner}", consumers: [target], repositories: [records], schedules: [daily] });`,
      ].join("\n");
      const Due = event({ owner, name: "Due", payload: object({}) });
      const target = consumer({ name: "target", event: Due, durable: true, handle: () => undefined });
      return defineFeature({ name: owner, events: [Due], consumers: [target],
        repositories: [defineRepository({ name: "records", feature: owner, relations: [`${owner}.records`] })],
        schedules: [schedule({ name: "daily", feature: owner, target, occurrences: () => [] })] });
    });
    const fixture = await createAppFixture(files);
    try {
      const application = defineApp({ features });
      const manifest = analyzeApplicationV3(fixture.root, { application });
      for (const record of manifest.composition.filter(({ kind }) => ["consumer", "repository", "schedule"].includes(kind))) {
        assert.deepEqual(record.detail?.source, { file: `src/features/${record.owner}/index.ts`, line: record.kind === "consumer" ? 4 : record.kind === "repository" ? 5 : 6, provenance: "static-registration" });
      }
      assert.deepEqual(manifest.linkage.links, application.graph.links);
      assert.ok(!manifest.completeness.observations.some(({ kind }) => /^(consumer|repository|schedule)-source$/.test(kind)));
      for (const owner of ["billing", "shipping"]) {
        const file = `src/features/${owner}/index.ts`;
        await fixture.write(file, files[file]!.replace('import * as factories from "../../factories.js";', 'import { consumer, defineRepository, schedule } from "typescript-on-rails";').replace("factories.consume", "consumer").replace("factories.repository", "defineRepository").replace("factories.recurring", "schedule"));
      }
      const direct = analyzeApplicationV3(fixture.root, { application });
      assert.deepEqual(direct.composition, manifest.composition);
      await fixture.write("src/features/billing/duplicate.ts", 'import { consumer as other } from "typescript-on-rails"; other({ name: "target", event: undefined as never, handle: () => undefined });\n');
      const duplicate = analyzeApplicationV3(fixture.root, { application });
      assert.deepEqual(duplicate.composition, manifest.composition);
      assert.ok(!duplicate.completeness.observations.some(({ kind }) => kind === "consumer-source"));
      assert.ok(duplicate.composition.find(({ kind, owner }) => kind === "consumer" && owner === "shipping")?.detail?.source);
    } finally { await fixture.cleanup(); }
  });

  it("leaves unsupported registration sources unknown instead of trusting type assertions or factory names", async () => {
    const fixture = await createAppFixture({
      "src/app.ts": 'import { defineApp } from "typescript-on-rails"; import { feature } from "./features/billing/index.js"; export const application = defineApp({ features: [feature] });\n',
      "src/features/billing/index.ts": [
        'import { defineFeature, consumer as realConsumer, event, object } from "typescript-on-rails";',
        'const Due = event({ name: "Due", payload: object({}) });',
        'declare const dynamicName: string;',
        'const dynamic = realConsumer({ name: dynamicName as "dynamic", event: Due, handle: () => undefined });',
        'const consumer = (value: unknown) => value;',
        'const unrelated = consumer({ name: "unrelated", event: Due, handle: () => undefined });',
        'function wrap(consumer: typeof realConsumer) { return consumer({ name: "shadowed", event: Due, handle: () => undefined }); }',
        'realConsumer({ name: "", event: Due, handle: () => undefined });',
        'const shadowed = wrap(realConsumer); export const feature = defineFeature({ name: "billing", consumers: [dynamic, unrelated, shadowed] });',
      ].join("\n"),
    });
    try {
      const Due = event({ name: "Due", payload: object({}) });
      const application = defineApp({ features: [defineFeature({ name: "billing", events: [Due], consumers: ["dynamic", "unrelated", "shadowed"].map((name) => consumer({ name, event: Due, handle: () => undefined })) })] });
      const manifest = analyzeApplicationV3(fixture.root, { application });
      assert.ok(manifest.composition.filter(({ kind }) => kind === "consumer").every(({ detail }) => detail?.source === undefined));
      assert.deepEqual(manifest.completeness.observations.filter(({ kind }) => kind === "consumer-source").map(({ name, reason }) => ({ name, reason })), ["dynamic", "shadowed", "unrelated"].map((name) => ({ name: `billing.${name}`, reason: "no supported framework registration resolves to this owner and name" })));
    } finally { await fixture.cleanup(); }
  });

  it("resolves destructured context parameters and const aliases by symbol, not same-line or shadow names", async () => {
    const fixture = await createAppFixture({
      "src/features/observe/index.ts": [
        'import { action, object, type ExecutionContext } from "typescript-on-rails";',
        'interface Context extends ExecutionContext { email: { send(): void }; outbox: { append(): void } }',
        'export const first = action({ input: object({}), public: true, run: (_input, { email: { send } }: Context) => { const invoke = send; invoke(); const shadow = (send: () => void) => send(); return true; } }); export const second = action({ input: object({}), public: true, run: (_input, ctx: Context) => { ctx.outbox.append(); return true; } });',
        'export const mutable = action({ input: object({}), public: true, run: (_input, ctx: Context) => { let alias = ctx.email; alias.send(); return true; } });',
      ].join("\n"),
    });
    try {
      const operation = () => action({ input: object({}), public: true, run: () => true });
      const application = defineApp({ features: [defineFeature({ name: "observe", operations: { first: operation(), second: operation(), mutable: operation() } })] });
      const manifest = analyzeApplicationV3(fixture.root, { application });
      const detail = (name: string) => manifest.composition.find((record) => record.kind === "operation" && record.name === name)?.detail;
      assert.deepEqual((detail("first")?.contextObservations as { member: string }[]).map(({ member }) => member), ["context.email.send"]);
      assert.deepEqual((detail("second")?.contextObservations as { member: string }[]).map(({ member }) => member), ["ctx.outbox.append"]);
      assert.equal(detail("mutable")?.contextObservationResolution, "context-unresolved");
      assert.deepEqual((detail("mutable")?.contextObservations as { member: string; state: string }[]).map(({ member, state }) => ({ member, state })), [{ member: "ctx.email", state: "alias-unresolved" }]);
    } finally { await fixture.cleanup(); }
  });

  it("discovers explicit host exports and paths without inventing automatic methods", async () => {
    const fixture = await createAppFixture({
      "src/handlers.ts": 'export function handle() { return new Response("ok"); }\n',
      "src/methods.ts": 'export { handle as GET, handle as HEAD, handle as OPTIONS } from "./handlers.js";\n',
      "src/app/(group)/api/[id]/route.ts": 'export { handle as GET, handle as HEAD } from "../../../../handlers.js";\n',
      "src/app/@slot/items/[...parts]/route.ts": 'export * from "../../../../methods.js";\n',
      "src/app/const/route.ts": 'export const { GET, OPTIONS } = { GET: () => new Response(null), OPTIONS: () => new Response(null) };\n',
      "src/app/ordinary/route.ts": 'export function GET() { return new Response(null); } export type { handle as HEAD } from "../../handlers.js"; export type * from "../../methods.js";\n',
      "src/app/[[...optional]]/route.ts": 'export function GET() { return new Response(null); }\n',
      "src/app/(..)intercepted/route.ts": 'export function GET() { return new Response(null); }\n',
      "src/app/_private/route.ts": 'export function HEAD() { return new Response(null); }\n',
      "src/features/example/route.ts": 'export function HEAD() { return new Response(null); }\n',
      "src/app/unresolved/route.ts": 'export const GET: unknown = undefined; export * from "./missing.js";\n',
    });
    try {
      const manifest = analyzeApplicationV3(fixture.root);
      const routes = manifest.completeness.observations.filter(({ category, kind }) => category === "discovered-undeclared" && kind === "route");
      assert.deepEqual(routes.map(({ name }) => name), ["GET /api/:id", "GET /const", "GET /items/:parts*", "GET /ordinary", "GET /unresolved", "HEAD /api/:id", "HEAD /items/:parts*", "OPTIONS /const", "OPTIONS /items/:parts*"]);
      assert.equal(manifest.completeness.observations.filter(({ kind }) => kind === "route-path").length, 2);
      assert.deepEqual(manifest.completeness.observations.filter(({ kind }) => kind === "route-export").map(({ reason }) => reason), ["GET export does not resolve to a callable handler", 'cannot resolve route re-export "./missing.js"']);
      await fixture.write("app/root/route.ts", 'export function OPTIONS() { return new Response(null); }\n');
      const rootHost = analyzeApplicationV3(fixture.root);
      assert.ok(!rootHost.completeness.observations.some(({ file }) => file?.startsWith("src/app/")));
      assert.ok(rootHost.completeness.observations.some(({ kind, file, reason }) => kind === "route-export" && file === "app/root/route.ts" && /not in the TypeScript program/.test(reason)));
      await fixture.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["app/**/*.ts"] }));
      const resolvedRoot = analyzeApplicationV3(fixture.root);
      assert.deepEqual(resolvedRoot.completeness.observations.filter(({ kind }) => kind === "route").map(({ name }) => name), ["OPTIONS /root"]);
    } finally { await fixture.cleanup(); }
  });

  it("analyzes support roots and diffs v3 composition", async () => {
    const appFixture = await createAppFixture({ "src/features/app/index.ts": "export const value = 1;\n" });
    const supportFixture = await createAppFixture({ "src/features/contracts/index.ts": "import \"support-package\"; export interface Contract { id: string }\n" });
    try {
      await supportFixture.write("node_modules/support-package/package.json", `${JSON.stringify({ name: "support-package", version: "2.3.4", types: "index.d.ts" })}\n`);
      await supportFixture.write("node_modules/support-package/index.d.ts", "export {};\n");
      await supportFixture.write("package.json", `${JSON.stringify({ private: true, typescriptOnRails: { packageCapabilities: { "support-package": "pure" } } }, null, 2)}\n`);
      const before = analyzeApplicationV3(appFixture.root, { workspaces: [{ name: "contracts", root: supportFixture.root }] });
      const app = defineApp({ features: [defineFeature({ name: "app" })] });
      const after = analyzeApplicationV3(appFixture.root, { application: app, workspaces: [{ name: "contracts", root: supportFixture.root }] });
      assert.equal(after.workspaces.length, 2);
      assert.ok(after.workspaces[1]?.packageCapabilities.some(({ package: name, packageVersion }) => name === "support-package" && packageVersion === "2.3.4"));
      assert.ok(after.completeness.observations.some(({ category }) => category === "outside-root"));
      assert.deepEqual(diffArchitectureV3(before, after).composition.added, ["feature/app/app"]);
    } finally {
      await appFixture.cleanup();
      await supportFixture.cleanup();
    }
  });

  it("migrates legacy package decisions without calling environment and clock APIs pure", () => {
    assert.deepEqual(migratePackageCapabilityV1("date-fns", "pure", "4.1.0").nondeterminism, ["none"]);
    assert.equal(migratePackageCapabilityV1("date-fns", "pure", "4.1.0").provenance, "migrated-v1");
    assert.deepEqual(migratePackageCapabilityV1("node:os", "pure", process.versions.node).nondeterminism, ["environment", "clock"]);
    assert.deepEqual(migratePackageCapabilityV1("node:perf_hooks", "pure", process.versions.node).nondeterminism, ["environment", "clock"]);
    assert.throws(() => migratePackageCapabilityV1("date-fns", "pure", "unknown"), /exact package version/i);
    const inherited = resolvePackageCapabilitiesV2("support", [], [migratePackageCapabilityV1("date-fns", "pure", "4.1.0")]);
    assert.equal(inherited[0]?.inheritedFrom, "parent");
    assert.equal(resolvePackageCapabilitiesV2("support", [{ ...migratePackageCapabilityV1("date-fns", "pure", "4.2.0"), runtime: ["server"] }], inherited).length, 2);
    assert.throws(
      () => resolvePackageCapabilitiesV2("support", [{ ...migratePackageCapabilityV1("date-fns", "pure", "4.1.0"), effects: ["network"] }], inherited),
      /Conflicting package capability v2 decision/,
    );
    const firstInherited = inherited[0];
    assert.ok(firstInherited);
    assert.throws(
      () => resolvePackageCapabilitiesV2("support", [], [{ ...firstInherited, packageVersion: "" }]),
      /Invalid package capability/,
    );
  });

  it("binds legacy capabilities to installed versions and reports unresolved or stale decisions", async () => {
    const fixture = await createAppFixture({
      "src/features/app/index.ts": `import "example-package/subpath"; import "node:os"; export const value = true;\n`,
    });
    try {
      await fixture.write("node_modules/example-package/package.json", `${JSON.stringify({ name: "example-package", version: "1.2.3", exports: { "./subpath": "./subpath.d.ts" } })}\n`);
      await fixture.write("node_modules/example-package/subpath.d.ts", "export {};\n");
      await fixture.write("package.json", `${JSON.stringify({
        private: true,
        typescriptOnRails: {
          packageCapabilities: {
            "example-package/subpath": "pure",
            "node:os": "pure",
            "missing-package": "external-system",
          },
        },
      }, null, 2)}\n`);

      const manifest = analyzeApplicationV3(fixture.root);
      assert.equal(manifest.compiler.packageCapabilitySemantics, "descriptive");
      assert.ok(manifest.packageCapabilities.some(({ package: name, packageVersion, provenance }) => name === "example-package/subpath" && packageVersion === "1.2.3" && provenance === "migrated-v1"));
      assert.ok(manifest.packageCapabilities.some(({ package: name, packageVersion }) => name === "node:os" && packageVersion === process.versions.node));
      assert.ok(!manifest.packageCapabilities.some(({ packageVersion }) => packageVersion === "unknown"));
      assert.ok(manifest.completeness.observations.some(({ category, kind, name }) => category === "unknown" && kind === "package-version" && name === "missing-package"));
      assert.equal(manifest.completeness.complete, false);

      const declared = analyzeApplicationV3(fixture.root, {
        packageCapabilitiesV2: [{
          version: 2,
          package: "example-package/subpath",
          packageVersion: "1.2.3",
          runtime: ["server"],
          effects: ["filesystem"],
          nondeterminism: ["none"],
        }],
      });
      assert.equal(declared.packageCapabilities[0]?.provenance, "declared-v2");
      assert.equal(declared.packageCapabilities[0]?.source, "options-v2");
      assert.equal(declared.packageCapabilities[0]?.versionSource, "installed");

      const stale = analyzeApplicationV3(fixture.root, {
        packageCapabilitiesV2: [
          migratePackageCapabilityV1("example-package/subpath", "pure", "1.2.3"),
          migratePackageCapabilityV1("example-package/subpath", "pure", "0.0.0"),
          migratePackageCapabilityV1("example-package", "pure", "0.0.0"),
          migratePackageCapabilityV1("node:os", "pure", process.versions.node),
        ],
      });
      assert.ok(stale.completeness.observations.some(({ kind, name, reason }) => kind === "package-capability" && name === "example-package/subpath" && /conflicting application package facts/i.test(reason)));
      assert.ok(stale.completeness.observations.some(({ kind, name, reason }) => kind === "package-capability" && name === "example-package" && /explicit packageCapabilities enforcement decision/i.test(reason)));
      assert.equal(stale.completeness.complete, false);

      const migrated = migrateManifestV2(manifest.base);
      assert.deepEqual(migrated.packageCapabilities, []);
      assert.ok(migrated.completeness.observations.some(({ kind }) => kind === "package-version"));
    } finally {
      await fixture.cleanup();
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  action,
  analyzeApplicationV3,
  defineApp,
  defineFeature,
  diffArchitectureV3,
  entrypoint,
  event,
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
      "src/features/billing/index.ts": "export function invoiceTotal() { return 1; }\n",
      "src/app/api/health/route.ts": "export function GET() { return new Response('ok'); }\n",
    });
    try {
      const InvoicePaid = event({ name: "InvoicePaid", payload: object({ invoiceId: string() }) });
      const health = route({ method: "GET", path: "/api/health", public: true, output: object({ status: string() }), handler: () => ({ status: "ok" }) });
      const createInvoice = action({ input: object({ name: string() }), permission: "invoice.create", run: ({ name }) => ({ name }) });
      const app = defineApp({
        features: [defineFeature({
          name: "billing",
          operations: { createInvoice },
          routes: [health],
          pages: [page({ name: "invoices", path: "/invoices", runtime: "hybrid", permission: "invoice.read" })],
          permissions: ["invoice.create", "invoice.read"],
          events: [InvoicePaid],
          tests: ["test/billing.test.ts"],
        })],
        entrypoints: { web: entrypoint({ name: "web", process: "web", run: () => undefined }) },
      });
      const v3 = analyzeApplicationV3(fixture.root, { application: app });
      assert.equal(v3.version, 3);
      assert.equal(v3.base.version, 2);
      assert.ok(v3.composition.some((record) => record.kind === "operation" && record.name === "createInvoice"));
      assert.ok(v3.composition.some((record) => record.kind === "entrypoint" && record.name === "web"));
      assert.equal(v3.completeness.counts["discovered-undeclared"], 0);
      assert.ok(v3.completeness.counts.unknown >= 1);
      assert.ok(v3.completeness.observations.some(({ kind }) => kind === "operation-calls"));
      assert.deepEqual(v3.linkage.links, []);
      assert.equal(v3.completeness.complete, false);
      const migrated = migrateManifestV2(v3.base);
      assert.equal(migrated.base, v3.base);
      assert.equal(migrated.completeness.complete, false);
      assert.deepEqual(migrated.linkage.links, []);
    } finally {
      await fixture.cleanup();
    }
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

      const stale = analyzeApplicationV3(fixture.root, {
        packageCapabilitiesV2: [
          migratePackageCapabilityV1("example-package/subpath", "pure", "1.2.3"),
          migratePackageCapabilityV1("example-package/subpath", "pure", "0.0.0"),
          migratePackageCapabilityV1("example-package", "pure", "0.0.0"),
          migratePackageCapabilityV1("node:os", "pure", process.versions.node),
        ],
      });
      assert.ok(stale.completeness.observations.some(({ kind, name, reason }) => kind === "package-version" && name === "example-package/subpath" && /configured version 0\.0\.0/.test(reason)));
      assert.ok(stale.completeness.observations.some(({ kind, name, reason }) => kind === "package-version" && name === "example-package" && /installed version 1\.2\.3/.test(reason)));
      assert.equal(stale.completeness.complete, false);

      const migrated = migrateManifestV2(manifest.base);
      assert.deepEqual(migrated.packageCapabilities, []);
      assert.ok(migrated.completeness.observations.some(({ kind }) => kind === "package-version"));
    } finally {
      await fixture.cleanup();
    }
  });
});

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeApplication } from "../src/index.js";
import {
  buildPackageCapabilityCatalog,
  selectPackagePolicy,
} from "../src/infra/project/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

const webFacts = {
  packageFactsVersion: 1,
  packageFacts: [
    { package: "@typescript-on-rails/web", capability: "host-io", runtime: ["universal", "server"], effects: ["none"], nondeterminism: ["none"] },
    { package: "next", capability: "ui", runtime: ["browser", "server", "build"], effects: ["filesystem", "network", "process"], nondeterminism: ["environment"] },
    { package: "next/headers", capability: "host-io", runtime: ["server"], effects: ["none"], nondeterminism: ["external"] },
  ],
};

describe("package capability catalog", () => {
  it("derives v2 policy and v3 facts from installed official metadata without app repetition", async () => {
    const fixture = await createAppFixture({
      "src/features/app/index.ts": 'import "@typescript-on-rails/web"; import "next/headers"; export const value = true;\n',
    });
    try {
      await fixture.write("package.json", `${JSON.stringify({
        private: true,
        dependencies: { "@typescript-on-rails/web": "0.1.0", next: "16.3.3" },
        typescriptOnRails: { packageCapabilities: {} },
      }, null, 2)}\n`);
      await fixture.write("node_modules/@typescript-on-rails/web/package.json", `${JSON.stringify({ name: "@typescript-on-rails/web", version: "0.1.0", typescriptOnRails: webFacts })}\n`);
      await fixture.write("node_modules/next/package.json", `${JSON.stringify({ name: "next", version: "16.3.3" })}\n`);
      const selected = selectPackagePolicy(fixture.root, {});
      assert.deepEqual(selected.entries, [
        { package: "@typescript-on-rails/web", capability: "host-io" },
        { package: "next", capability: "ui" },
        { package: "next/headers", capability: "host-io" },
      ]);
      const catalog = buildPackageCapabilityCatalog(fixture.root, {});
      assert.deepEqual(catalog.entries.map(({ package: name, packageVersion, provenance, source }) => ({ name, packageVersion, provenance, source })), [
        { name: "@typescript-on-rails/web", packageVersion: "0.1.0", provenance: "official", source: "official-package" },
        { name: "next", packageVersion: "16.3.3", provenance: "official", source: "official-package" },
        { name: "next/headers", packageVersion: "16.3.3", provenance: "official", source: "official-package" },
      ]);
    } finally { await fixture.cleanup(); }
  });

  it("fails closed for official conflicts and installed-lockfile version mismatches", async () => {
    const fixture = await createAppFixture({ "src/features/app/index.ts": 'import "next"; export const value = true;\n' });
    try {
      await fixture.write("package.json", `${JSON.stringify({
        private: true,
        dependencies: { "@typescript-on-rails/web": "0.1.0", next: "16.3.3" },
        typescriptOnRails: {
          packageCapabilities: { next: "host-io" },
          packageCapabilitiesV2: [{ version: 2, package: "next", packageVersion: "16.3.3", runtime: ["server"], effects: ["filesystem"], nondeterminism: ["environment"] }],
        },
      }, null, 2)}\n`);
      await fixture.write("node_modules/@typescript-on-rails/web/package.json", `${JSON.stringify({ name: "@typescript-on-rails/web", version: "0.1.0", typescriptOnRails: webFacts })}\n`);
      await fixture.write("node_modules/next/package.json", `${JSON.stringify({ name: "next", version: "16.3.3" })}\n`);
      await fixture.write("package-lock.json", `${JSON.stringify({
        name: "fixture",
        lockfileVersion: 3,
        packages: { "": { name: "fixture" }, "node_modules/next": { version: "16.3.2" } },
      }, null, 2)}\n`);
      const catalog = buildPackageCapabilityCatalog(fixture.root, {});
      assert.ok(catalog.blockedPackages.includes("next"));
      assert.ok(catalog.issues.some(({ kind }) => kind === "fact-conflict"));
      assert.ok(catalog.issues.some(({ kind }) => kind === "version-mismatch"));
      assert.ok(!selectPackagePolicy(fixture.root, {}).entries.some(({ package: name }) => name === "next"));
      await fixture.write("node_modules/@typescript-on-rails/web/package.json", `${JSON.stringify({ name: "@typescript-on-rails/web", version: "0.1.0", typescriptOnRails: { ...webFacts, packageFactsVersion: 2 } })}\n`);
      assert.ok(buildPackageCapabilityCatalog(fixture.root, {}).issues.some(({ kind }) => kind === "invalid-official-metadata"));
    } finally { await fixture.cleanup(); }
  });

  it("reports malformed application v2 facts without aborting analysis", async () => {
    const fixture = await createAppFixture({ "src/features/app/index.ts": "export const value = true;\n" });
    try {
      await fixture.write("package.json", `${JSON.stringify({ private: true, typescriptOnRails: { packageCapabilities: {}, packageCapabilitiesV2: { invalid: true } } })}\n`);
      const selected = selectPackagePolicy(fixture.root, {});
      assert.ok(selected.issues.some(({ kind, key }) => kind === "malformed-policy" && key === "packageCapabilitiesV2"));
      assert.doesNotThrow(() => buildPackageCapabilityCatalog(fixture.root, {}));
      assert.ok(analyzeApplication(fixture.root).diagnostics.some(({ rule, message }) => rule === "package-policy" && /packageCapabilitiesV2/.test(message)));
    } finally { await fixture.cleanup(); }
  });

  it("never infers enforcement from descriptive v2 facts", async () => {
    const fixture = await createAppFixture({ "src/features/app/index.ts": 'import "vendor-audit"; export const value = true;\n' });
    try {
      await fixture.write("package.json", `${JSON.stringify({ private: true, typescriptOnRails: { packageCapabilities: {} } })}\n`);
      await fixture.write("node_modules/vendor-audit/package.json", `${JSON.stringify({ name: "vendor-audit", version: "1.2.3" })}\n`);
      const catalog = buildPackageCapabilityCatalog(fixture.root, {
        packageCapabilitiesV2: [{ version: 2, package: "vendor-audit", packageVersion: "1.2.3", runtime: ["server"], effects: ["network"], nondeterminism: ["external"] }],
      });
      assert.ok(catalog.blockedPackages.includes("vendor-audit"));
      assert.ok(catalog.issues.some(({ kind, message }) => kind === "fact-conflict" && /explicit packageCapabilities enforcement decision/.test(message)));
    } finally { await fixture.cleanup(); }
  });

  it("matches a nested installed package to the lock entry for its actual path", async () => {
    const fixture = await createAppFixture({ "src/features/root/index.ts": "export const root = true;\n" });
    try {
      await fixture.write(".git", "gitdir: test\n");
      await fixture.write("package-lock.json", `${JSON.stringify({
        name: "workspace",
        lockfileVersion: 3,
        packages: {
          "": { name: "workspace" },
          "node_modules/next": { version: "1.0.0" },
          "app/node_modules/next": { version: "2.0.0" },
        },
      })}\n`);
      await fixture.write("app/package.json", `${JSON.stringify({ private: true, dependencies: { "@typescript-on-rails/web": "0.1.0", next: "2.0.0" }, typescriptOnRails: { packageCapabilities: {} } })}\n`);
      await fixture.write("app/node_modules/@typescript-on-rails/web/package.json", `${JSON.stringify({ name: "@typescript-on-rails/web", version: "0.1.0", typescriptOnRails: webFacts })}\n`);
      await fixture.write("app/node_modules/next/package.json", `${JSON.stringify({ name: "next", version: "2.0.0" })}\n`);
      const next = buildPackageCapabilityCatalog(path.join(fixture.root, "app"), {}).entries.find(({ package: name }) => name === "next");
      assert.equal(next?.packageVersion, "2.0.0");
      assert.equal(next?.versionSource, "installed+lockfile");
    } finally { await fixture.cleanup(); }
  });

  it("records matching application v2 facts as one override with source provenance", async () => {
    const fixture = await createAppFixture({ "src/features/app/index.ts": 'import "next"; export const value = true;\n' });
    try {
      await fixture.write("package.json", `${JSON.stringify({
        private: true,
        dependencies: { "@typescript-on-rails/web": "0.1.0", next: "16.3.3" },
        typescriptOnRails: {
          packageCapabilities: { next: "ui" },
          packageCapabilitiesV2: [{ version: 2, package: "next", packageVersion: "16.3.3", runtime: ["browser", "server", "build"], effects: ["filesystem", "network", "process"], nondeterminism: ["environment"] }],
        },
      }, null, 2)}\n`);
      await fixture.write("node_modules/@typescript-on-rails/web/package.json", `${JSON.stringify({ name: "@typescript-on-rails/web", version: "0.1.0", typescriptOnRails: webFacts })}\n`);
      await fixture.write("node_modules/next/package.json", `${JSON.stringify({ name: "next", version: "16.3.3" })}\n`);
      const next = buildPackageCapabilityCatalog(fixture.root, {}).entries.find(({ package: name }) => name === "next");
      assert.equal(next?.provenance, "override");
      assert.equal(next?.source, "application-v2");
      assert.equal(next?.officialOwner, "@typescript-on-rails/web");
    } finally { await fixture.cleanup(); }
  });
});

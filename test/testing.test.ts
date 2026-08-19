import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeApplication } from "../src/features/architecture/index.js";
import {
  assertArchitecture,
  executionContext,
  formatArchitectureDiagnostics,
} from "../src/features/testing/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

describe("testing helpers", () => {
  it("creates an immutable-looking execution context from permissions", () => {
    const context = executionContext("invoice.read", "invoice.approve", "invoice.read");
    assert.deepEqual([...context.permissions], ["invoice.read", "invoice.approve"]);
  });

  it("formats and asserts analyzer diagnostics clearly", async () => {
    const fixture = await createAppFixture({
      "src/features/billing/model.ts": `export const broken: number = "wrong";`,
    });
    try {
      const manifest = analyzeApplication(fixture.root);
      const output = formatArchitectureDiagnostics(manifest);
      assert.match(output, /ARCH012/);
      assert.match(output, /src\/features\/billing\/model\.ts:1/);
      assert.throws(() => assertArchitecture(manifest), /Architecture check failed/);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns a clean manifest unchanged", async () => {
    const fixture = await createAppFixture({ "src/features/health/index.ts": "export const healthy = true;" });
    try {
      const manifest = analyzeApplication(fixture.root);
      assert.equal(assertArchitecture(manifest), manifest);
      assert.equal(formatArchitectureDiagnostics(manifest), "Architecture check passed.\n");
    } finally {
      await fixture.cleanup();
    }
  });
});

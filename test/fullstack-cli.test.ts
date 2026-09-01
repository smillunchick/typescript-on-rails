import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { action, defineApp, defineFeature, object, route } from "../src/index.js";
import { runCli, type CommandInvocation } from "../src/features/tooling/index.js";
import { createAppFixture } from "./helpers/app-fixture.js";

function stream() { let value = ""; return { write(chunk: string) { value += chunk; }, value: () => value }; }

describe("full-stack CLI", () => {
  it("uses the installed framework lifecycle before legacy scripts", async () => {
    const fixture = await createAppFixture({}, { packageJson: "missing" });
    try {
      await fixture.write("package.json", JSON.stringify({ private: true, dependencies: { "@typescript-on-rails/fullstack": "0.1.0" }, typescriptOnRails: { packageCapabilities: {} } }));
      const calls: CommandInvocation[] = [];
      const stderr = stream();
      const lifecycleBin = "/resolved/fullstack/dist/bin.js";
      assert.equal(
        await runCli(["migrate"], {
          cwd: fixture.root,
          stderr,
          runCommand: (invocation) => {
            calls.push(invocation);
            return 0;
          },
          resolveFullStackLifecycle: () => lifecycleBin,
        }),
        0,
      );
      assert.equal(calls[0]?.command, process.execPath);
      assert.deepEqual(calls[0]?.args, [lifecycleBin, "migrate"]);
    } finally { await fixture.cleanup(); }
  });

  it("reports Manifest v3 completeness through brief, unknowns, and manifest commands", async () => {
    const fixture = await createAppFixture({
      "src/features/billing/index.ts": "export function total() { return 1; }\n",
      "src/app/api/billing/route.ts": "export function GET() { return new Response('ok'); }\n",
    });
    try {
      const read = action({ input: object({}), public: true, run: () => 1 });
      const endpoint = route({
        method: "GET",
        path: "/api/billing",
        public: true,
        handler: () => new Response("ok"),
      });
      const application = defineApp({
        features: [
          defineFeature({
            name: "billing",
            operations: { total: read },
            routes: [endpoint],
            tests: ["test/billing.test.ts"],
          }),
        ],
      });
      const loadFullStackApplication = async () => application;
      const stdout = stream();
      assert.equal(
        await runCli(["brief", "billing", "--json"], {
          cwd: fixture.root,
          stdout,
          loadFullStackApplication,
        }),
        0,
      );
      const brief = JSON.parse(stdout.value()) as { sourceBodiesIncluded: boolean; contextBenefitClaim: boolean; completeness: { complete: boolean } };
      assert.equal(brief.sourceBodiesIncluded, false);
      assert.equal(brief.contextBenefitClaim, false);
      assert.equal(brief.completeness.complete, true);
      const unknownOutput = stream();
      assert.equal(
        await runCli(["unknowns", "--json"], {
          cwd: fixture.root,
          stdout: unknownOutput,
          loadFullStackApplication,
        }),
        0,
      );
      const unknowns = JSON.parse(unknownOutput.value()) as { unknowns: unknown[] };
      assert.deepEqual(unknowns.unknowns, []);
      const testsOutput = stream();
      assert.equal(
        await runCli(["tests-for", "billing", "--json"], {
          cwd: fixture.root,
          stdout: testsOutput,
          loadFullStackApplication,
        }),
        0,
      );
      assert.deepEqual(
        (JSON.parse(testsOutput.value()) as { tests: string[] }).tests,
        ["test/billing.test.ts"],
      );
      const manifestOutput = stream();
      assert.equal(
        await runCli(["manifest", "--v3", "--json"], {
          cwd: fixture.root,
          stdout: manifestOutput,
          loadFullStackApplication,
        }),
        0,
      );
      assert.equal((JSON.parse(manifestOutput.value()) as { version: number }).version, 3);
    } finally { await fixture.cleanup(); }
  });
});

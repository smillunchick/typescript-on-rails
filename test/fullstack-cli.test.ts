import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  action,
  defineApp,
  defineFeature,
  entrypoint,
  object,
  operationRoute,
  runtimeBinding,
} from "../src/index.js";
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

  it("returns compact source-linked briefs, traces, unknowns, and verified tests", async () => {
    const fixture = await createAppFixture({
      "src/app.ts": 'import { defineApp, defineFeature } from "typescript-on-rails"; import { endpoint } from "./features/billing/index.js"; import { healthEndpoint } from "./features/health/index.js"; export const application = defineApp({ features: [defineFeature({ name: "billing", routes: [endpoint] }), defineFeature({ name: "health", routes: [healthEndpoint] })] });\n',
      "src/features/billing/index.ts": [
        'import { action, object, operationRoute } from "typescript-on-rails";',
        "export const total = action({ input: object({}), public: true, run: () => 1 });",
        'export const endpoint = operationRoute({ method: "GET", path: "/api/billing", operation: total });',
      ].join("\n") + "\n",
      "src/features/health/index.ts": [
        'import { action, object, operationRoute } from "typescript-on-rails";',
        "export const health = action({ input: object({}), public: true, run: () => true });",
        'export const healthEndpoint = operationRoute({ method: "GET", path: "/api/health", operation: health });',
      ].join("\n") + "\n",
      "src/app-definition.ts": 'import { entrypoint } from "typescript-on-rails"; export const web = entrypoint({ name: "web", process: "web", run: async (signal) => { if (signal.aborted) return; await Promise.resolve(); } });\n',
      "src/app/api/billing/route.ts": "export function GET() { return new Response('ok'); }\n",
      "src/app/api/health/route.ts": "export function GET() { return new Response('ok'); }\n",
      "test/billing.test.ts": 'import "../src/features/billing/index.js";\n',
    });
    try {
      const read = action({ input: object({}), public: true, run: () => 1 });
      const endpoint = operationRoute({ method: "GET", path: "/api/billing", operation: read });
      const binding = runtimeBinding({ name: "billing", protocol: "web.route/v1", process: "web", target: endpoint });
      const health = action({ input: object({}), public: true, run: () => true });
      const healthEndpoint = operationRoute({ method: "GET", path: "/api/health", operation: health });
      const healthBinding = runtimeBinding({ name: "health", protocol: "web.route/v1", process: "web", target: healthEndpoint });
      const application = defineApp({
        features: [
          defineFeature({ name: "billing", operations: { total: read }, routes: [endpoint], tests: ["test/billing.test.ts"] }),
          defineFeature({ name: "health", operations: { health }, routes: [healthEndpoint] }),
        ],
        entrypoints: {
          web: entrypoint({
            name: "web",
            process: "web",
            bindings: [binding, healthBinding],
            run: async (signal) => { if (signal.aborted) return; await Promise.resolve(); },
          }),
        },
      });
      const loadFullStackApplication = async () => application;
      const stdout = stream();
      assert.equal(await runCli(["brief", "billing", "--json"], { cwd: fixture.root, stdout, loadFullStackApplication }), 0);
      const brief = JSON.parse(stdout.value()) as {
        records: unknown[];
        links: { kind: string }[];
        completeness: { complete: boolean; counts: Record<string, number>; observations?: unknown };
        sourceBodiesIncluded: boolean;
        contextBenefitClaim: boolean;
        projectionVersion: number;
        sha256: string;
      };
      assert.equal(brief.sourceBodiesIncluded, false);
      assert.equal(brief.contextBenefitClaim, false);
      assert.equal(brief.projectionVersion, 2);
      assert.equal(brief.sha256.length, 64);
      assert.equal(brief.completeness.complete, false);
      assert.equal(brief.completeness.observations, undefined);
      assert.ok(brief.records.length > 0);
      assert.deepEqual(brief.links.map(({ kind }) => kind), ["entrypoint-route", "route-operation"]);

      const traceOutput = stream();
      assert.equal(await runCli(["trace", "total", "--json"], { cwd: fixture.root, stdout: traceOutput, loadFullStackApplication }), 0);
      const trace = JSON.parse(traceOutput.value()) as { projectionVersion: number; sha256: string; staticTraceAvailable: boolean; runtimeTraceAvailable: boolean; links: { kind: string }[]; records: { name: string }[]; lexicalObservations: unknown[] };
      assert.equal(trace.projectionVersion, 2);
      assert.equal(trace.sha256.length, 64);
      assert.equal(trace.staticTraceAvailable, true);
      assert.equal(trace.runtimeTraceAvailable, false);
      assert.deepEqual(trace.links.map(({ kind }) => kind), ["entrypoint-route", "route-operation"]);
      assert.ok(!trace.records.some(({ name }) => name === "health" || name === "GET /api/health"));

      const unknownOutput = stream();
      assert.equal(await runCli(["unknowns", "--json"], { cwd: fixture.root, stdout: unknownOutput, loadFullStackApplication }), 0);
      const unknowns = JSON.parse(unknownOutput.value()) as { projectionVersion: number; sha256: string; complete: boolean; counts: Record<string, number>; unknowns: unknown[] };
      assert.equal(unknowns.projectionVersion, 2);
      assert.equal(unknowns.sha256.length, 64);
      assert.equal(unknowns.complete, false);
      assert.deepEqual(unknowns.unknowns, ["/api/billing", "/api/health"].map((name) => ({
        category: "unknown", kind: "route-export", name, root: fixture.root,
        file: `src/app${name}/route.ts`,
        reason: "GET export cannot be linked to its registered web binding through a supported Next wrapper",
      })));

      const testsOutput = stream();
      assert.equal(await runCli(["tests-for", "billing", "--json"], { cwd: fixture.root, stdout: testsOutput, loadFullStackApplication }), 0);
      const testReport = JSON.parse(testsOutput.value()) as { projectionVersion: number; sha256: string; tests: unknown[] };
      assert.equal(testReport.projectionVersion, 2);
      assert.equal(testReport.sha256.length, 64);
      assert.deepEqual(testReport.tests, [{ file: "test/billing.test.ts", owner: "billing", verification: "source-exists" }]);

      const manifestOutput = stream();
      assert.equal(await runCli(["manifest", "--v3", "--json"], { cwd: fixture.root, stdout: manifestOutput, loadFullStackApplication }), 0);
      assert.equal((JSON.parse(manifestOutput.value()) as { version: number }).version, 3);
    } finally { await fixture.cleanup(); }
  });
});

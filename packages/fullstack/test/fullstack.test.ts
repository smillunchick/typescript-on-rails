import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ExecutionTrace,
  LifecycleRegistry,
  lifecyclePlugin,
  localCacheAdapter,
  localEmailAdapter,
  localPaymentsAdapter,
  localSessionAdapter,
  localStorageAdapter,
  memoryObservability,
  parseConfig,
  secretReference,
  semanticBrief,
  testsFor,
  unknowns,
} from "../src/index.js";
import { createHash } from "node:crypto";

describe("full-stack application services", () => {
  it("validates configuration without exposing secret values", () => {
    const parsed = parseConfig({ PORT: { kind: "integer", required: true, minimum: 1 }, LIVE: { kind: "boolean", default: false }, API_KEY: { kind: "secret", required: true } }, { PORT: "3411", API_KEY: "secret-value" });
    assert.equal(parsed.PORT.toFixed(0), "3411");
    assert.equal(parsed.LIVE.valueOf(), false);
    assert.equal(String(parsed.API_KEY), "[secret]");
    assert.equal(JSON.stringify(parsed.API_KEY), '"[secret]"');
    assert.equal(String(secretReference("API_KEY")), "[secret]");
  });

  it("runs configured lifecycle plugins in order and fails closed", async () => {
    const calls: string[] = [];
    const registry = new LifecycleRegistry([
      lifecyclePlugin({ name: "database", commands: { migrate: () => { calls.push("database"); } } }),
      lifecyclePlugin({ name: "application", commands: { migrate: () => { calls.push("application"); } } }),
    ]);
    const result = await registry.run("migrate", { cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined });
    assert.deepEqual(calls, ["database", "application"]);
    assert.deepEqual(result.plugins, calls);
    await assert.rejects(() => registry.run("worker", { cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined }), /NOT_CONFIGURED/);
  });

  it("provides deterministic local adapters with replay and expiry behavior", async () => {
    const mail = localEmailAdapter();
    assert.equal((await mail.send({ idempotencyKey: "one", to: "dev@example.test", subject: "Hello", text: "Body" })).replayed, false);
    assert.equal((await mail.send({ idempotencyKey: "one", to: "dev@example.test", subject: "Hello", text: "Body" })).replayed, true);
    assert.equal(mail.messages.length, 1);

    const bytes = new TextEncoder().encode("object");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const storage = localStorageAdapter();
    const stored = await storage.put({ key: "one", bytes, checksum });
    assert.deepEqual(await storage.get("one", stored.version), bytes);
    await assert.rejects(() => storage.put({ key: "bad", bytes, checksum: "bad" }), /CHECKSUM/);

    const payments = localPaymentsAdapter();
    assert.deepEqual(await payments.charge({ idempotencyKey: "one", customerId: "customer", amountMinor: 100, currency: "usd" }), await payments.charge({ idempotencyKey: "one", customerId: "customer", amountMinor: 100, currency: "usd" }));

    let now = 0;
    const cache = localCacheAdapter(() => now);
    await cache.set("one", "value", 10);
    assert.equal(await cache.get("one"), "value");
    now = 10;
    assert.equal(await cache.get("one"), undefined);

    const sessions = localSessionAdapter();
    const token = await sessions.create("actor", new Date(100));
    assert.equal((await sessions.read(token, new Date(99)))?.actorId, "actor");
    assert.equal(await sessions.read(token, new Date(100)), undefined);
  });

  it("builds bounded semantic briefs and relevant test views without benefit claims", () => {
    const manifest = {
      composition: [
        { kind: "feature", owner: "billing", name: "billing" },
        { kind: "operation", owner: "billing", name: "refund" },
        { kind: "test", owner: "billing", name: "test/refund.test.ts" },
      ],
      base: { dependencies: [] },
      completeness: {
        observations: [{ category: "unknown" as const, kind: "route", name: "POST /refund", root: ".", reason: "not declared" }],
        counts: { declared: 3, "discovered-undeclared": 0, "outside-root": 0, unknown: 1 },
        complete: false,
      },
    };
    const brief = semanticBrief(manifest, ["billing"]);
    assert.equal(brief.contextBenefitClaim, false);
    assert.equal(brief.sourceBodiesIncluded, false);
    assert.equal(brief.sha256.length, 64);
    const unicodeA = { ...manifest, composition: [{ kind: "feature", owner: "billing", name: "billing", detail: { "é": 1, "é": 2 } }] };
    const unicodeB = { ...manifest, composition: [{ kind: "feature", owner: "billing", name: "billing", detail: { "é": 2, "é": 1 } }] };
    assert.equal(semanticBrief(unicodeA, ["billing"]).sha256, semanticBrief(unicodeB, ["billing"]).sha256);
    assert.deepEqual(testsFor(manifest, "refund"), ["test/refund.test.ts"]);
    assert.equal(unknowns(manifest).length, 1);
  });

  it("records safe telemetry and request or operation traces", async () => {
    const telemetry = memoryObservability();
    telemetry.logger.info("ready", { port: 3411 });
    telemetry.metrics.increment("requests");
    const trace = new ExecutionTrace();
    assert.equal(await trace.capture("operation", "billing.read", () => 1, { now: () => 5 }), 1);
    assert.equal(telemetry.records.length, 2);
    assert.deepEqual(trace.records()[0], { kind: "operation", name: "billing.read", startedAt: 5, endedAt: 5, outcome: "success" });
  });
});

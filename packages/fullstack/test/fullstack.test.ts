import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createArchitectureBrief,
  defineApp,
  defineFeature,
  defineRepository,
  emailContract,
  entrypoint,
  InvalidInput,
  projectedTests,
  resolveArchitectureSelector,
  unknownArchitectureObservations,
} from "typescript-on-rails";

import { applicationLifecyclePlugin } from "../src/application-lifecycle.js";
import {
  ExecutionTrace,
  LifecycleRegistry,
  assertApplicationSuitability,
  lifecyclePlugin,
  localCacheAdapter,
  localEmailAdapter,
  localPaymentsAdapter,
  localSessionAdapter,
  localStorageAdapter,
  memoryObservability,
  parseConfig,
  processEntrypoint,
  secretReference,
  semanticBrief,
  sanitizeAttributes,
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

  it("runs the exact registered entrypoints and supervises development plugins concurrently", async () => {
    const calls: string[] = [];
    const application = defineApp({
      entrypoints: {
        web: entrypoint({ name: "web", process: "web", run: () => { calls.push("web"); } }),
        worker: entrypoint({ name: "worker", process: "worker", run: () => { calls.push("worker"); } }),
        scheduler: entrypoint({ name: "scheduler", process: "scheduler", run: () => { calls.push("scheduler"); } }),
      },
    });
    const registry = new LifecycleRegistry([
      applicationLifecyclePlugin({ load: async () => application }),
    ]);
    await registry.run("worker", { cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined });
    assert.deepEqual(calls, ["worker"]);
    calls.length = 0;
    await registry.run("dev", { cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined });
    assert.deepEqual(calls.sort(), ["scheduler", "web", "worker"]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const starts: string[] = [];
    const concurrent = new LifecycleRegistry([
      lifecyclePlugin({ name: "first", commands: { dev: async () => { starts.push("first"); await Promise.race([gate, new Promise((_, reject) => setTimeout(() => reject(new Error("DEV_NOT_CONCURRENT")), 50))]); } } }),
      lifecyclePlugin({ name: "second", commands: { dev: () => { starts.push("second"); release(); } } }),
    ]);
    await concurrent.run("dev", { cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined });
    assert.deepEqual(starts, ["first", "second"]);

    const controller = new AbortController();
    const child = processEntrypoint({ name: "child", process: "web", command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"] });
    const running = Promise.resolve(child.run(controller.signal));
    setTimeout(() => controller.abort(new Error("test stop")), 100);
    await assert.doesNotReject(running);
  });

  it("provides deterministic local adapters with replay and expiry behavior", async () => {
    const mail = localEmailAdapter();
    assert.equal(mail.contract, emailContract);
    assert.equal(mail.provider, "local-memory");
    assert.equal(mail.suitability, "local-only");
    assert.equal((await mail.send({ idempotencyKey: "one", to: "dev@example.test", subject: "Hello", text: "Body" })).replayed, false);
    assert.equal((await mail.send({ idempotencyKey: "one", to: "dev@example.test", subject: "Hello", text: "Body" })).replayed, true);
    assert.equal(mail.messages.length, 1);
    assert.doesNotMatch(JSON.stringify(mail.metadata), /dev@example|Hello|Body/);

    const bytes = new TextEncoder().encode("object");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const storage = localStorageAdapter();
    const stored = await storage.put({ key: "one", bytes, checksum });
    assert.deepEqual(await storage.get("one", stored.version), bytes);
    await assert.rejects(() => storage.put({ key: "bad", bytes, checksum: "bad" }), /CHECKSUM/);
    await assert.rejects(() => storage.put({ key: "bad-bytes", bytes: "bytes" as never, checksum }), InvalidInput);

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

  it("denies local-only adapters before a production entrypoint starts", async () => {
    let started = false;
    const email = localEmailAdapter();
    const application = defineApp({
      adapters: { email },
      features: [defineFeature({ name: "access", adapters: [emailContract] })],
      entrypoints: { web: entrypoint({ name: "web", process: "web", run: () => { started = true; } }) },
    });
    const plugin = applicationLifecyclePlugin({ load: async () => application });
    const run = plugin.commands.dev;
    assert.ok(run);
    await assert.rejects(async () => {
      await run({
        cwd: ".",
        environment: { NODE_ENV: "production" },
        signal: new AbortController().signal,
        write: () => undefined,
      });
    }, /ADAPTER_NOT_PRODUCTION_SUITABLE:email/);
    assert.equal(started, false);
  });

  it("denies an expired relation exception before an entrypoint starts", async () => {
    let started = false;
    const repository = defineRepository({ name: "invoices", feature: "billing", relations: ["app.invoices"] });
    const application = defineApp({
      features: [
        defineFeature({ name: "billing", repositories: [repository] }),
        defineFeature({ name: "audit", relationExceptions: [{ relation: "app.invoices", reason: "expired", expires: "2000-01-01" }] }),
      ],
      entrypoints: { web: entrypoint({ name: "web", process: "web", run: () => { started = true; } }) },
    });
    assert.throws(() => assertApplicationSuitability(application, {}), /RELATION_EXCEPTION_EXPIRED:audit.app.invoices/);
    const plugin = applicationLifecyclePlugin({ load: async () => application });
    const run = plugin.commands.dev;
    assert.ok(run);
    await assert.rejects(async () => {
      await run({ cwd: ".", environment: {}, signal: new AbortController().signal, write: () => undefined });
    }, /RELATION_EXCEPTION_EXPIRED:audit.app.invoices/);
    assert.equal(started, false);
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
    const selected = resolveArchitectureSelector(manifest, "billing");
    assert.equal(selected.status, "resolved");
    if (selected.status !== "resolved") throw new Error("billing selector did not resolve");
    const canonicalBrief = createArchitectureBrief(manifest, selected);
    assert.equal(brief.contextBenefitClaim, false);
    assert.deepEqual(brief.unresolvedSelectors, []);
    assert.deepEqual(semanticBrief(manifest, ["billing", "missing"]).unresolvedSelectors, ["missing"]);
    assert.equal(brief.sourceBodiesIncluded, false);
    assert.equal(brief.sha256.length, 64);
    assert.deepEqual(brief.records, canonicalBrief.records);
    assert.deepEqual(brief.links, canonicalBrief.links);
    const unicodeA = { ...manifest, composition: [{ kind: "feature", owner: "billing", name: "billing", detail: { "é": 1, "é": 2 } }] };
    const unicodeB = { ...manifest, composition: [{ kind: "feature", owner: "billing", name: "billing", detail: { "é": 2, "é": 1 } }] };
    assert.equal(semanticBrief(unicodeA, ["billing"]).sha256, semanticBrief(unicodeB, ["billing"]).sha256);
    const refund = resolveArchitectureSelector(manifest, "refund");
    assert.equal(refund.status, "resolved");
    if (refund.status !== "resolved") throw new Error("refund selector did not resolve");
    assert.deepEqual(testsFor(manifest, "refund"), projectedTests(manifest, refund));
    assert.deepEqual(testsFor(manifest, "refund", { exists: () => true }), [{ file: "test/refund.test.ts", owner: "billing", verification: "source-exists" }]);
    assert.deepEqual(unknowns(manifest), unknownArchitectureObservations(manifest));
  });

  it("redacts unsafe telemetry attributes and records request or operation traces", async () => {
    const telemetry = memoryObservability();
    telemetry.logger.info("ready", { port: 3411, authorization: "Bearer live-secret", note: "x".repeat(300) });
    telemetry.metrics.increment("requests");
    const trace = new ExecutionTrace();
    assert.equal(await trace.capture("operation", "billing.read", () => 1, { now: () => 5 }), 1);
    assert.equal(telemetry.records.length, 2);
    assert.deepEqual(sanitizeAttributes({ authorization: "Bearer live-secret", note: "x".repeat(300), safe: "visible" }), {
      authorization: "[redacted]",
      note: `${"x".repeat(255)}…`,
      safe: "visible",
    });
    assert.deepEqual(telemetry.records[0]?.attributes, {
      port: 3411,
      authorization: "[redacted]",
      note: `${"x".repeat(255)}…`,
    });
    assert.deepEqual(trace.records()[0], { kind: "operation", name: "billing.read", startedAt: 5, endedAt: 5, outcome: "success" });
  });
});

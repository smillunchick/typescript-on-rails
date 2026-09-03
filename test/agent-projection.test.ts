import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_PROJECTION_PROTOCOL_VERSION,
  canonicalProjectionHash,
  canonicalProjectionJson,
  compositionRecordId,
  createArchitectureBrief,
  createArchitectureCheckReceipt,
  createArchitectureTests,
  createArchitectureTrace,
  createArchitectureUnknowns,
  executableArchitectureSummary,
  projectArchitecture,
  resolveArchitectureSelector,
  runtimeRecordId,
  type ArchitectureProjectionView,
} from "../src/index.js";

function manifest(): ArchitectureProjectionView {
  const billingRoute = runtimeRecordId("route", "billing", "GET /api/billing");
  const billingOperation = runtimeRecordId("operation", "billing", "total");
  const healthRoute = runtimeRecordId("route", "health", "GET /api/health");
  const healthOperation = runtimeRecordId("operation", "health", "health");
  const entrypoint = runtimeRecordId("entrypoint", "application", "web");
  return {
    composition: [
      { kind: "entrypoint", owner: "application", name: "web" },
      { kind: "feature", owner: "billing", name: "billing" },
      { kind: "event", owner: "billing", name: "InvoicePaid" },
      { kind: "operation", owner: "billing", name: "total", detail: { contextObservations: [{ member: "context.outbox.append", event: "InvoicePaid", file: "src/features/billing.ts", line: 8, state: "direct", scope: "run-body", runtimeReachability: "unknown" }] } },
      { kind: "operation", owner: "billing", name: "ridePricing" },
      { kind: "route", owner: "billing", name: "GET /api/billing" },
      { kind: "test", owner: "billing", name: "test/billing.test.ts", detail: { features: ["billing"] } },
      { kind: "test", owner: "application:acceptance", name: "test/acceptance.test.ts", detail: { features: ["billing", "health"], suite: "acceptance" } },
      { kind: "feature", owner: "health", name: "health" },
      { kind: "operation", owner: "health", name: "health" },
      { kind: "route", owner: "health", name: "GET /api/health" },
      { kind: "operation", owner: "left", name: "shared" },
      { kind: "operation", owner: "right", name: "shared" },
    ],
    linkage: {
      links: [
        { kind: "entrypoint-route", from: entrypoint, to: billingRoute, protocol: "web.route/v1" },
        { kind: "entrypoint-route", from: entrypoint, to: healthRoute, protocol: "web.route/v1" },
        { kind: "route-operation", from: billingRoute, to: billingOperation },
        { kind: "route-operation", from: healthRoute, to: healthOperation },
      ],
    },
    base: {
      features: [{ name: "billing" }, { name: "health" }, { name: "empty" }],
      dependencies: [{ from: "billing", to: "shared", file: "src/features/billing.ts", line: 1, symbols: ["money"] }],
    },
    completeness: {
      observations: [
        { category: "declared", kind: "operation", name: "billing.total", root: "/app", reason: "registered" },
        { category: "unknown", kind: "test-source", name: "test/acceptance.test.ts", root: "/app", file: "test/acceptance.test.ts", reason: "missing" },
      ],
      counts: { declared: 1, "discovered-undeclared": 0, "outside-root": 0, unknown: 1 },
      complete: false,
    },
  };
}

function resolved(view: ArchitectureProjectionView, selector: string) {
  const result = resolveArchitectureSelector(view, selector);
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") throw new Error("selector not resolved");
  return result;
}

describe("canonical agent projections", () => {
  it("resolves exact IDs, qualified records, owner groups, suites, ambiguity, and missing selectors", () => {
    const view = manifest();
    assert.equal(AGENT_PROJECTION_PROTOCOL_VERSION, 2);
    assert.equal(resolved(view, "billing").match, "owner-group");
    assert.equal(resolved(view, "total").match, "record-name");
    assert.equal(resolved(view, "ridePricing").match, "record-name");
    assert.equal(resolved(view, runtimeRecordId("operation", "billing", "total")).match, "runtime-id");
    assert.equal(resolved(view, "operation:billing/total").match, "qualified-record");
    assert.equal(resolved(view, "acceptance").owners[0], "application:acceptance");
    assert.equal(resolved(view, "empty").records.length, 0);
    const ambiguous = resolveArchitectureSelector(view, "shared");
    assert.equal(ambiguous.status, "ambiguous");
    if (ambiguous.status === "ambiguous") assert.deepEqual(ambiguous.candidates.map(({ owner }) => owner), ["left", "right"]);
    assert.deepEqual(resolveArchitectureSelector(view, "missing"), { status: "not-found", selector: "missing", candidates: [] });
    assert.equal(compositionRecordId({ kind: "operation", owner: "billing", name: "total" }), runtimeRecordId("operation", "billing", "total"));
    assert.equal(compositionRecordId({ kind: "feature", owner: "billing", name: "billing" }), runtimeRecordId("feature", "billing", "billing"));
    const adapterView = {
      ...view,
      composition: [
        ...view.composition,
        { kind: "adapter", owner: "billing", name: "email" },
        { kind: "adapter", owner: "application", name: "email" },
      ],
    };
    assert.equal(resolveArchitectureSelector(adapterView, "adapter:billing/email").status, "resolved");
    assert.equal(resolveArchitectureSelector(adapterView, runtimeRecordId("adapter", "application", "email")).status, "resolved");
    const repositoryView = {
      ...view,
      composition: [
        ...view.composition,
        { kind: "repository", owner: "billing", name: "invoices" },
        { kind: "relation", owner: "billing", name: "app.invoices" },
      ],
      linkage: { links: [
        ...(view.linkage?.links ?? []),
        { kind: "repository-relation" as const, from: runtimeRecordId("repository", "billing", "invoices"), to: runtimeRecordId("relation", "billing", "app.invoices") },
      ] },
    };
    assert.equal(resolveArchitectureSelector(repositoryView, "app.invoices").status, "resolved");
    assert.equal(resolveArchitectureSelector(repositoryView, runtimeRecordId("relation", "billing", "app.invoices")).status, "resolved");
  });

  it("keeps verified links separate from bounded lexical observations", () => {
    const view = manifest();
    const projection = projectArchitecture(view, resolved(view, "total"), { depth: "trace" });
    assert.deepEqual(projection.links.map(({ kind }) => kind), ["entrypoint-route", "route-operation"]);
    assert.ok(!projection.records.some(({ owner }) => owner === "health"));
    assert.ok(!projection.records.some(({ kind }) => kind === "event"));
    assert.deepEqual(projection.observedRecords.map(({ name }) => name), ["InvoicePaid"]);
    assert.equal(projection.lexicalObservations[0]?.verified, false);
    assert.equal(projection.lexicalObservations[0]?.basis, "context-member-call");
  });

  it("builds one versioned, hashed envelope for briefs, traces, tests, unknowns, and checks", () => {
    const view = manifest();
    const billing = resolved(view, "billing");
    const brief = createArchitectureBrief(view, billing);
    const trace = createArchitectureTrace(view, resolved(view, "total"));
    const tests = createArchitectureTests(view, billing, { kind: "completeness" });
    const unknowns = createArchitectureUnknowns(view);
    for (const envelope of [brief, trace, tests, unknowns]) {
      assert.equal(envelope.projectionVersion, 2);
      assert.equal(envelope.sha256.length, 64);
    }
    assert.equal(brief.sourceBodiesIncluded, false);
    assert.equal(brief.contextBenefitClaim, false);
    assert.equal(trace.runtimeTraceAvailable, false);
    assert.deepEqual(tests.tests, [
      { file: "test/acceptance.test.ts", owner: "application:acceptance", verification: "missing" },
      { file: "test/billing.test.ts", owner: "billing", verification: "source-exists" },
    ]);
    assert.equal(unknowns.unknowns.length, 1);

    const check = createArchitectureCheckReceipt({
      diagnostics: [],
      executable: executableArchitectureSummary(view),
      lifecycle: { ok: true, exitCode: 0 },
      tests: { ok: true, exitCode: 0 },
    });
    assert.equal(check.receiptVersion, 1);
    assert.equal(check.ok, false);
    assert.equal(check.sha256.length, 64);
    assert.equal(check.executable?.complete, false);

    assert.equal(canonicalProjectionJson({ b: 2, a: 1 }), canonicalProjectionJson({ a: 1, b: 2 }));
    assert.equal(canonicalProjectionHash({ b: 2, a: 1 }), canonicalProjectionHash({ a: 1, b: 2 }));
    assert.notEqual(canonicalProjectionHash({ a: 1 }), canonicalProjectionHash({ a: 2 }));
    assert.notEqual(canonicalProjectionHash(new Date(0)), canonicalProjectionHash(new Date(1)));
    assert.throws(() => canonicalProjectionHash(new Map()), /CANONICAL_PROJECTION_OBJECT_INVALID/);
    assert.throws(() => canonicalProjectionHash({ value: undefined }), /CANONICAL_PROJECTION_VALUE_INVALID/);
    assert.throws(() => canonicalProjectionHash({ value: Number.NaN }), /CANONICAL_PROJECTION_VALUE_INVALID/);
    assert.throws(() => canonicalProjectionHash({ value: () => undefined }), /CANONICAL_PROJECTION_VALUE_INVALID/);
    assert.throws(() => canonicalProjectionHash({ [Symbol("value")]: true }), /CANONICAL_PROJECTION_VALUE_INVALID/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalProjectionHash(cyclic), /CANONICAL_PROJECTION_CYCLE/);
  });
});

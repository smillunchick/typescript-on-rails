import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeApplicationV3 } from "typescript-on-rails/architecture";
import { assertApplicationSuitability } from "@typescript-on-rails/fullstack";
import { createWorker, dispatchOutbox, postgresJobStore } from "@typescript-on-rails/jobs";
import { createTestDatabase, migrateToLatest, postgresRlsHooks, resolveDeclaredRelationNames } from "@typescript-on-rails/postgres";
import { nextRouteFor } from "@typescript-on-rails/web/next";

import { application, createReferenceApplication } from "../src/app-definition.js";
import type { ReferenceDatabase } from "../src/infra/database.js";
import { consumers } from "../src/infra/entrypoints.js";
import { createHttpBindings } from "../src/infra/http.js";
import { referenceMigrations } from "../src/infra/migrations.js";
import { email, identity, sessions } from "../src/infra/runtime.js";

const root = path.resolve(import.meta.dirname, "..");
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

async function signIn(graph: typeof application.graph) {
  const route = nextRouteFor(graph, "/api/session", "POST");
  const response = await route(new Request("https://localhost:3420/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://localhost:3420", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ subject: "demo", proof: "local-proof" }),
  }));
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
  const sessionCookie = cookies.find((value) => value.startsWith("__Host-tor-session="));
  const csrfCookie = cookies.find((value) => value.startsWith("__Host-tor-csrf="));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);
  return { sessionCookie, csrfCookie };
}

describe("production-shaped full-stack reference", () => {
  it("derives Next routes, worker bindings, and Manifest v3 from one executable graph", async () => {
    const session = await signIn(application.graph);
    assert.ok(session.sessionCookie);
    assert.deepEqual(application.graph.links.map(({ kind }) => kind), [
      "consumer-event",
      "consumer-event",
      "entrypoint-consumer",
      "entrypoint-consumer",
      "entrypoint-route",
      "entrypoint-route",
      "entrypoint-schedule",
      "feature-adapter",
      "feature-adapter",
      "feature-adapter",
      "repository-relation",
      "route-operation",
      "route-operation",
      "schedule-consumer",
    ]);
    assert.equal(application.adapters.email, email);
    assert.equal(application.adapters.identity, identity);
    assert.equal(application.adapters.session, sessions);
    assert.throws(() => assertApplicationSuitability(application, { NODE_ENV: "production" }), /ADAPTER_NOT_PRODUCTION_SUITABLE/);
    assert.deepEqual(application.graph.relations, [{ relation: "public.projects", owner: "projects", repository: "projects", exclusive: true }]);
    assert.ok(application.graph.entrypoints.worker?.bindings.every(({ target }) =>
      application.graph.consumers.some(({ definition }) => definition === target),
    ));

    const manifest = analyzeApplicationV3(root, { application });
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.base.diagnostics.filter(({ severity }) => severity === "error"), []);
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "entrypoint" && name === "next-web"));
    const createProject = manifest.composition.find(({ kind, name }) => kind === "operation" && name === "createProject");
    assert.ok(createProject);
    assert.deepEqual(
      (createProject.detail?.contextObservations as readonly { readonly member: string; readonly event?: string; readonly state: string; readonly runtimeReachability: string }[]).map(({ member, event, state, runtimeReachability }) => ({ member, ...(event === undefined ? {} : { event }), state, runtimeReachability })),
      [
        { member: "context.projects.save", state: "direct", runtimeReachability: "unknown" },
        { member: "context.outbox.appendOutbox", event: "ProjectCreated", state: "direct", runtimeReachability: "unknown" },
      ],
    );
    assert.ok(manifest.composition.some(({ kind, name, owner, detail }) => kind === "adapter" && name === "email" && owner === "application" && detail?.suitability === "local-only"));
    assert.doesNotMatch(JSON.stringify(manifest.composition.filter(({ kind }) => kind === "adapter")), /local-proof|developer@example|Body/);
    assert.ok(manifest.composition.some(({ kind, name, detail }) => kind === "schedule" && name === "daily-project-check" && detail?.target === "checkProjects"));
    assert.ok(manifest.composition.some(({ kind, name, detail }) => kind === "repository" && name === "projects" && detail?.sqlVerified === false));
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "relation" && name === "public.projects"));
    assert.doesNotMatch(JSON.stringify(manifest.composition.filter(({ kind }) => kind === "repository" || kind === "relation")), /Kysely|Transaction|insertInto|selectFrom|connectionString/);
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "consumer" && name === "sendProjectWelcome"));
    assert.ok(manifest.composition.some(({ kind }) => kind === "test"));
    assert.deepEqual(manifest.linkage.links, application.graph.links);
    assert.equal(manifest.completeness.complete, true);
    assert.equal(manifest.completeness.counts.unknown, 0);
    assert.ok(manifest.composition
      .filter(({ kind }) => kind === "route" || kind === "consumer" || kind === "entrypoint")
      .every(({ detail }) => typeof detail?.source === "object" && detail.source !== null));
  });

  it("persists a request and outbox atomically, then runs the registered consumer once", { skip: testDatabaseUrl === undefined }, async () => {
    const database = await createTestDatabase<ReferenceDatabase>(testDatabaseUrl ?? "", { rls: postgresRlsHooks() });
    try {
      await migrateToLatest(database.db, referenceMigrations);
      assert.deepEqual(await resolveDeclaredRelationNames(database.db, application.graph.relations.map(({ relation }) => relation)), [{ relation: "public.projects", resolved: true, resolvedAs: "projects" }]);
      const bindings = createHttpBindings({ database: () => database });
      const testApplication = createReferenceApplication([bindings.signIn, bindings.createProject]);
      const { sessionCookie, csrfCookie } = await signIn(testApplication.graph);
      const csrf = csrfCookie.slice(csrfCookie.indexOf("=") + 1);
      const createProject = nextRouteFor(testApplication.graph, "/api/projects", "POST");
      const response = await createProject(new Request("https://localhost:3420/api/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookie}; ${csrfCookie}`,
          origin: "https://localhost:3420",
          "sec-fetch-site": "same-origin",
          "x-csrf-token": csrf,
          "x-request-id": "request_project_one",
        },
        body: JSON.stringify({ id: "project_one", name: "Reference project" }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: "project_one", name: "Reference project" });

      const project = await database.transaction(
        { tenantId: "tenant_local", actorId: "actor_test", requestId: "read_project" },
        (transaction) => transaction.selectFrom("projects").select(["id", "tenant_id", "name"]).executeTakeFirstOrThrow(),
      );
      assert.deepEqual(project, { id: "project_one", tenant_id: "tenant_local", name: "Reference project" });
      const hidden = await database.transaction(
        { tenantId: "tenant_other", actorId: "actor_test", requestId: "hide_project" },
        (transaction) => transaction.selectFrom("projects").select("id").executeTakeFirst(),
      );
      assert.equal(hidden, undefined);
      assert.equal((await database.db.selectFrom("tor_outbox").select("id").execute()).length, 1);

      const store = postgresJobStore(database.db);
      const messages = email.messages.length;
      assert.equal((await dispatchOutbox(store, consumers.publisher())).published, 1);
      const worker = createWorker({ store, handlers: consumers.handlers });
      assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
      assert.equal((await dispatchOutbox(store, consumers.publisher())).published, 0);
      assert.equal(await worker.runOnce(new AbortController().signal), "idle");
      assert.equal(email.messages.length, messages + 1);
    } finally {
      await database.close();
    }
  });
});

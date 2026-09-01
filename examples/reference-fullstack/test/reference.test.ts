import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { analyzeApplicationV3 } from "typescript-on-rails/architecture";
import {
  dispatchOutbox,
  durableEvent,
  postgresJobStore,
  postgresOutboxWriter,
} from "@typescript-on-rails/jobs";
import {
  createTestDatabase,
  migrateToLatest,
  postgresRlsHooks,
} from "@typescript-on-rails/postgres";
import { nextRoute } from "@typescript-on-rails/web/next";

import { application } from "../src/app-definition.js";
import { createProjectHandler, signInHandler } from "../src/infra/http.js";
import { email, worker } from "../src/infra/runtime.js";
import { projectStore } from "../src/features/projects/index.js";
import type { ReferenceDatabase } from "../src/infra/database.js";
import { referenceMigrations } from "../src/infra/migrations.js";

const root = path.resolve(import.meta.dirname, "..");

describe("production-shaped full-stack reference", () => {
  it("crosses the session, HTTP, operation, durable job, and local adapter boundaries", async () => {
    projectStore.clear();
    const signIn = await nextRoute(signInHandler)(new Request("https://localhost:3420/api/session", { method: "POST", headers: { "content-type": "application/json", origin: "https://localhost:3420", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ subject: "demo", proof: "local-proof" }) }));
    assert.equal(signIn.status, 200);
    const cookies = signIn.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
    const sessionCookie = cookies.find((value) => value.startsWith("__Host-tor-session="));
    const csrfCookie = cookies.find((value) => value.startsWith("__Host-tor-csrf="));
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    const csrf = csrfCookie.slice(csrfCookie.indexOf("=") + 1);
    const response = await nextRoute(createProjectHandler)(new Request("https://localhost:3420/api/projects", { method: "POST", headers: { "content-type": "application/json", cookie: `${sessionCookie}; ${csrfCookie}`, origin: "https://localhost:3420", "sec-fetch-site": "same-origin", "x-csrf-token": csrf }, body: JSON.stringify({ id: "project_one", name: "Reference project" }) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "project_one", name: "Reference project" });
    assert.equal(projectStore.list().length, 1);
    assert.equal(await worker.runOnce(new AbortController().signal), "succeeded");
    assert.equal(email.messages.length, 1);
  });

  it("emits Manifest v3 with executable owners, processes, tests, and visible completeness", () => {
    const manifest = analyzeApplicationV3(root, { application });
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.base.diagnostics.filter(({ severity }) => severity === "error"), []);
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "entrypoint" && name === "next-web"));
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "operation" && name === "createProject"));
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "consumer" && name === "enqueueProjectWelcome"));
    assert.ok(manifest.composition.some(({ kind }) => kind === "test"));
    assert.equal(manifest.completeness.counts["discovered-undeclared"], 0);
  });

  it("runs PostgreSQL migrations and enforces tenant-scoped transactions when a test database is available", { skip: process.env.TEST_DATABASE_URL === undefined }, async () => {
    const runtime = await createTestDatabase<ReferenceDatabase>(process.env.TEST_DATABASE_URL ?? "", {
      rls: postgresRlsHooks(),
    });
    try {
      await migrateToLatest(runtime.db, referenceMigrations);
      const ProjectCreated = durableEvent({ name: "ProjectCreated", parse: (value: unknown) => value });
      await runtime.transaction(
        { tenantId: "tenant_one", actorId: "actor_test", requestId: "request_one" },
        async (transaction) => {
          await transaction.insertInto("projects").values({ id: "project_database", tenant_id: "tenant_one", name: "Database project", created_at: new Date(0) }).execute();
          await postgresOutboxWriter(transaction).appendOutbox(
            ProjectCreated,
            { projectId: "project_database" },
            "project-created:project_database",
          );
        },
      );
      const hidden = await runtime.transaction(
        { tenantId: "tenant_two", actorId: "actor_test", requestId: "request_two" },
        (transaction) => transaction.selectFrom("projects").select("id").where("id", "=", "project_database").executeTakeFirst(),
      );
      assert.equal(hidden, undefined);
      const row = await runtime.transaction(
        { tenantId: "tenant_one", actorId: "actor_test", requestId: "request_three" },
        (transaction) => transaction.selectFrom("projects").select(["id", "tenant_id"]).where("id", "=", "project_database").executeTakeFirstOrThrow(),
      );
      assert.deepEqual(row, { id: "project_database", tenant_id: "tenant_one" });
      const published: string[] = [];
      assert.equal(
        await dispatchOutbox(postgresJobStore(runtime.db), {
          publish: async ({ event }) => { published.push(event); },
        }),
        1,
      );
      assert.deepEqual(published, ["ProjectCreated"]);
    } finally { await runtime.close(); }
  });
});

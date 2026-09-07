import assert from "node:assert/strict";
import { it } from "node:test";

import { createConsumerRuntime, createWorker, dispatchOutbox, postgresJobStore, withPostgresRequestUnitOfWork, type PostgresRequestUnitOfWork } from "@typescript-on-rails/jobs";
import { createTestDatabase, postgresRlsHooks } from "@typescript-on-rails/postgres";
import { bindRoute, requestCookie } from "@typescript-on-rails/web";
import { nextRoute, nextRouteFor } from "@typescript-on-rails/web/next";
import { sql } from "kysely";
import { action, consumer, defineFeature, event, object, operationRoute, string, Unauthorized } from "typescript-on-rails";

import { createReferenceApplication } from "../src/app-definition.js";
import { ProjectInvitationCreated, ProjectInvitationPayloadV1 } from "../src/features/projects/index.js";
import type { ReferenceDatabase } from "../src/infra/database.js";
import { consumers } from "../src/infra/entrypoints.js";
import { createHttpBindings } from "../src/infra/http.js";
import { postgresInvitationRepository } from "../src/infra/invitation-repository.js";
import { referenceMigrations } from "../src/infra/migrations.js";
import { email, identity, localPrincipal, sessions } from "../src/infra/runtime.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = "https://localhost:3420";
const invitationPath = "/api/projects/invitations";
const acceptPath = `${invitationPath}/accept`;
const signal = new AbortController().signal;
const enabled = { skip: databaseUrl === undefined };
const ProjectInvitationCreatedV1 = event({ owner: "projects", name: "ProjectInvitationCreated", payload: ProjectInvitationPayloadV1 });

async function fixture() {
  const database = await createTestDatabase<ReferenceDatabase>(databaseUrl ?? "", { rls: postgresRlsHooks() });
  try {
    // Test application tables and behavior, not cross-schema migration bookkeeping.
    for (const migration of referenceMigrations) await migration.up(database.db);
  } catch (error) {
    await database.close();
    throw error;
  }
  let now = new Date("2030-01-01T00:00:00Z");
  const bindings = createHttpBindings({ database: () => database, now: () => now });
  const application = createReferenceApplication(Object.values(bindings));
  async function login(subject: string) {
    const response = await nextRouteFor(application.graph, "/api/session", "POST")(new Request(`${origin}/api/session`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ subject, proof: "local-proof" }),
    }));
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
    const csrf = cookies.find((value) => value.startsWith("__Host-tor-csrf="))?.split("=")[1];
    assert.ok(csrf);
    return { cookie: cookies.join("; "), "x-csrf-token": csrf };
  }
  function request(path: string, body: unknown, auth: Record<string, string>, headers: Record<string, string> = {}) {
    return new Request(`${origin}${path}`, {
      method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", ...auth, ...headers }, body: JSON.stringify(body),
    });
  }
  const post = (path: string, body: unknown, auth: Record<string, string>, headers?: Record<string, string>) =>
    nextRouteFor(application.graph, path, "POST")(request(path, body, auth, headers));
  const tenant = <T>(run: Parameters<typeof database.transaction<T>>[1], tenantId = "tenant_local") =>
    database.transaction({ tenantId, actorId: "test_reader", requestId: "test_read" }, run);
  const store = postgresJobStore(database.db);
  return {
    database, application, login, request, post, tenant, store,
    now: () => now,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
    async project(auth: Record<string, string>, id = "project_one") {
      assert.equal((await post("/api/projects", { id, name: "Invitation project" }, auth)).status, 200);
      assert.equal((await dispatchOutbox(store, consumers.publisher())).published, 1);
      assert.equal(await createWorker({ store, handlers: consumers.handlers }).runOnce(signal), "succeeded");
    },
    close: () => database.close(),
  };
}

it("creates, delivers and accepts once across real HTTP, operations, PostgreSQL and worker boundaries", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    const recipient = await f.login("reader");
    await f.project(creator);
    const input = { projectId: "project_one", email: " Reader@Example.Test " };
    const responses = await Promise.all([f.post(invitationPath, input, creator), f.post(invitationPath, input, creator)]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
    const [first, repeated] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(first, repeated);
    assert.deepEqual(first, { id: first.id, projectId: "project_one", email: "reader@example.test", expiresAt: "2030-01-02T00:00:00.000Z", status: "pending" });
    assert.equal("token" in first, false);
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().execute())).length, 1);
    assert.equal((await f.database.db.selectFrom("tor_outbox").select("id").where("event", "=", "ProjectInvitationCreated").execute()).length, 1);

    const before = email.messages.length;
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 1);
    const worker = createWorker({ store: f.store, handlers: consumers.handlers });
    assert.equal(await worker.runOnce(signal), "succeeded");
    assert.equal(await worker.runOnce(signal), "idle");
    const message = email.messages.at(-1);
    assert.equal(email.messages.length, before + 1);
    assert.equal(message?.to, "reader@example.test");
    assert.equal(message?.subject, "Project invitation");
    const token = message?.text.match(/Accept with token (\S+) before/)?.[1];
    assert.ok(token);
    assert.equal(message?.text, `You are invited to project project_one. Accept with token ${token} before 2030-01-02T00:00:00.000Z.`);
    const accepted = await Promise.all([f.post(acceptPath, { token }, recipient), f.post(acceptPath, { token }, recipient)]);
    assert.deepEqual(accepted.map(({ status }) => status), [200, 200]);
    const result = await accepted[0]!.json();
    assert.equal(result.status, "accepted");
    assert.deepEqual(await accepted[1]!.json(), result);
    const row = await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().executeTakeFirstOrThrow());
    assert.equal(row.accepted_by, (await identity.authenticate({ subject: "reader", proof: "local-proof" }))?.actorId);
    assert.equal(row.accepted_at?.toISOString(), "2030-01-01T00:00:00.000Z");
    f.advance(2 * 86_400_000);
    assert.deepEqual(await (await f.post(acceptPath, { token }, recipient)).json(), result);
    assert.deepEqual(await (await f.post(invitationPath, input, creator)).json(), result);
    assert.deepEqual(await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().executeTakeFirstOrThrow()), row);
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 0);
    assert.equal(email.messages.length, before + 1);
  } finally { await f.close(); }
});

it("rejects untrusted creation, cross-tenant access, wrong recipients, expired and unknown tokens", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    const recipient = await f.login("reader");
    const outsider = await f.login("outsider");
    await f.project(creator);
    const input = { projectId: "project_one", email: "reader@example.test" };
    assert.equal((await f.post(invitationPath, input, {})).status, 403);
    assert.equal((await f.post(invitationPath, input, { cookie: `__Host-tor-csrf=${"a".repeat(32)}`, "x-csrf-token": "a".repeat(32) })).status, 401);
    assert.equal((await f.post(invitationPath, input, creator, { origin: "https://attacker.example" })).status, 403);
    assert.equal((await f.post(invitationPath, input, creator, { "x-csrf-token": "wrong" })).status, 403);
    assert.equal((await f.post(invitationPath, { ...input, tenantId: "tenant_local", permissions: ["project.create"], actorId: "demo" }, recipient)).status, 403);
    assert.equal((await f.post(invitationPath, { ...input, tenantId: "tenant_local" }, outsider)).status, 404);
    assert.equal((await f.post(invitationPath, { ...input, email: "not-an-email" }, creator)).status, 400);
    assert.equal((await f.post(invitationPath, { ...input, projectId: "missing" }, creator)).status, 404);
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().execute())).length, 0);
    assert.equal((await f.post(invitationPath, input, creator)).status, 200);
    const row = await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().executeTakeFirstOrThrow());
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().execute(), "tenant_other")).length, 0);
    assert.equal((await f.post(acceptPath, { token: row.token, tenantId: "tenant_local" }, outsider)).status, 404);
    assert.equal((await f.post(acceptPath, { token: row.token, email: "reader@example.test" }, creator)).status, 403);
    assert.equal((await f.post(acceptPath, { token: "unknown" }, recipient)).status, 404);
    f.advance(86_400_000); // The exact expiry instant is already too late.
    assert.equal((await f.post(acceptPath, { token: row.token }, recipient)).status, 409);
    assert.equal((await f.post(invitationPath, input, creator)).status, 409);
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").select("accepted_at").executeTakeFirstOrThrow())).accepted_at, null);
    assert.equal((await f.database.db.selectFrom("tor_outbox").select("id").where("event", "=", "ProjectInvitationCreated").execute()).length, 1);
    const session = recipient.cookie.split("; ").find((value) => value.startsWith("__Host-tor-session="))?.split("=")[1];
    assert.ok(session);
    await sessions.revoke(session);
    assert.equal((await f.post(acceptPath, { token: row.token }, recipient)).status, 401);
  } finally { await f.close(); }
});

it("rolls back an invitation when the same transaction cannot append its outbox record", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    await f.project(creator);
    await sql`alter table tor_outbox add constraint reject_invitation_test check (event <> 'ProjectInvitationCreated')`.execute(f.database.db);
    const input = { projectId: "project_one", email: "reader@example.test" };
    assert.equal((await f.post(invitationPath, input, creator)).status, 500);
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().execute())).length, 0);
    assert.equal((await f.database.db.selectFrom("tor_outbox").select("id").where("event", "=", "ProjectInvitationCreated").execute()).length, 0);
    await sql`alter table tor_outbox drop constraint reject_invitation_test`.execute(f.database.db);
    assert.equal((await f.post(invitationPath, input, creator)).status, 200);
    assert.equal((await f.tenant((tx) => tx.selectFrom("project_invitations").selectAll().execute())).length, 1);
  } finally { await f.close(); }
});

it("keeps one local email after a lost completion, a retry, and a duplicate occurrence", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    await f.project(creator);
    assert.equal((await f.post(invitationPath, { projectId: "project_one", email: "reader@example.test" }, creator)).status, 200);
    const original = await f.database.db.selectFrom("tor_outbox").selectAll().where("event", "=", "ProjectInvitationCreated").executeTakeFirstOrThrow();
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 1);
    const name = "projects.sendProjectInvitation";
    const handler = consumers.handlers[name];
    assert.ok(handler);
    let first = true;
    const worker = createWorker({ store: f.store, baseBackoffMilliseconds: 0, handlers: {
      ...consumers.handlers,
      async [name](payload, context) {
        await handler(payload, context);
        if (first) { first = false; throw new Error("lost completion after real email"); }
      },
    } });
    const before = email.messages.length;
    assert.equal(await worker.runOnce(signal), "retry");
    assert.equal(await worker.runOnce(signal), "succeeded");
    assert.equal(email.messages.length, before + 1);
    const originalMessage = email.messages.at(-1);
    await f.store.appendOutbox(ProjectInvitationCreated, ProjectInvitationCreated.parse(original.payload), {
      idempotencyKey: "duplicate-occurrence", tenantId: original.tenant_id!, actorId: original.actor_id!, requestId: "duplicate-test", correlationId: "duplicate-test",
    });
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 1);
    assert.equal(await worker.runOnce(signal), "succeeded");
    assert.equal(await worker.runOnce(signal), "idle");
    assert.equal(email.messages.length, before + 1);
    assert.deepEqual(email.messages.at(-1), originalMessage);
    assert.equal((await f.database.db.selectFrom("tor_effect_receipts").selectAll().execute()).length, 1);
    assert.equal((await f.post(invitationPath, { projectId: "project_one", email: "developer@example.test" }, creator)).status, 200);
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 1);
    assert.equal(await worker.runOnce(signal), "succeeded");
    assert.equal(email.messages.length, before + 2);
    assert.equal(email.messages.at(-1)?.to, "developer@example.test");
    assert.equal((await f.database.db.selectFrom("tor_effect_receipts").selectAll().execute()).length, 2);
  } finally { await f.close(); }
});

it("reloads worker authority from envelope actor and tenant, never payload claims", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    await f.project(creator);
    const actor = await identity.authenticate({ subject: "demo", proof: "local-proof" });
    const reader = await identity.authenticate({ subject: "reader", proof: "local-proof" });
    assert.ok(actor && reader);
    for (const [actorId, tenantId] of [[reader.actorId, "tenant_local"], [actor.actorId, "tenant_other"], ["unknown", "tenant_local"]]) {
      await f.store.appendOutbox(ProjectInvitationCreated, {
        invitationId: crypto.randomUUID(), projectId: "project_one", recipient: { email: "reader@example.test" },
        acceptance: { token: crypto.randomUUID(), expiresAt: "2030-01-02T00:00:00.000Z" },
        ...{ permissions: ["project.create"], actorId: actor.actorId, tenantId: "tenant_local" },
      }, { idempotencyKey: crypto.randomUUID(), actorId: actorId!, tenantId: tenantId!, requestId: "authority-test", correlationId: "authority-test" });
    }
    const before = email.messages.length;
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 3);
    const worker = createWorker({ store: f.store, handlers: consumers.handlers, baseBackoffMilliseconds: 60_000 });
    for (let index = 0; index < 3; index += 1) assert.equal(await worker.runOnce(signal), "retry");
    assert.equal(email.messages.length, before);
    assert.equal((await f.post(invitationPath, { projectId: "project_one", email: "reader@example.test" }, creator)).status, 200);
    assert.equal((await dispatchOutbox(f.store, consumers.publisher())).published, 1);
    assert.equal(await worker.runOnce(signal), "succeeded");
    assert.equal(email.messages.length, before + 1);
  } finally { await f.close(); }
});

it("executes the same HTTP-created v1 queued invitation job with the current v2 worker", enabled, async () => {
  const f = await fixture();
  try {
    const creator = await f.login("demo");
    const recipient = await f.login("reader");
    await f.project(creator);
    // A bounded historical application: the old operation writes the flat v1 event.
    const legacyAction = action({
      input: object({ projectId: string(), email: string() }), permission: "project.create",
      async run(input, context: { permissions: ReadonlySet<string>; unit: PostgresRequestUnitOfWork<ReferenceDatabase> }) {
        const { record } = await postgresInvitationRepository(context.unit.transaction).create({ ...input, tenantId: context.unit.tenantId, now: f.now() });
        await context.unit.outbox.appendOutbox(ProjectInvitationCreatedV1, {
          invitationId: record.invitation.id, projectId: input.projectId, email: input.email,
          token: record.token, expiresAt: record.invitation.expiresAt,
        }, `project-invitation:${record.invitation.id}`);
        return record.invitation;
      },
    });
    const legacyRoute = bindRoute(operationRoute({ method: "POST", path: invitationPath, operation: legacyAction }), {
      mutation: { trustedOrigins: [origin], csrf: { cookie: "__Host-tor-csrf", header: "x-csrf-token" } },
      async scope(input, execute) {
        const session = await sessions.read(requestCookie(input.request, "__Host-tor-session") ?? "", new Date());
        if (session === undefined) throw new Unauthorized();
        const principal = await localPrincipal(session.actorId);
        return withPostgresRequestUnitOfWork(f.database, { tenantId: principal.tenantId, actorId: principal.actorId, requestId: "legacy-invitation" },
          (unit) => execute({ permissions: principal.permissions, unit }));
      },
    });
    const legacyConsumer = consumer({ name: "sendProjectInvitation", event: ProjectInvitationCreatedV1, durable: true, handle: () => assert.fail("old worker must not execute") });
    const legacy = createConsumerRuntime([defineFeature({ name: "projects", events: [ProjectInvitationCreatedV1], consumers: [legacyConsumer] })]);
    assert.equal((await nextRoute(legacyRoute)(f.request(invitationPath, { projectId: "project_one", email: "reader@example.test" }, creator))).status, 200);
    assert.equal((await dispatchOutbox(f.store, legacy.publisher())).published, 1);
    const queued = await f.database.db.selectFrom("tor_jobs").selectAll().where("name", "=", "projects.sendProjectInvitation").executeTakeFirstOrThrow();
    const outbox = await f.database.db.selectFrom("tor_outbox").selectAll().where("id", "=", queued.outbox_id!).executeTakeFirstOrThrow();
    assert.equal(outbox.version, 1);
    assert.equal((await f.database.db.selectFrom("tor_outbox_delivery_receipts").select("consumer_version").where("job_id", "=", queued.id).executeTakeFirstOrThrow()).consumer_version, 1);
    const before = email.messages.length;
    assert.equal(await createWorker({ store: f.store, handlers: consumers.handlers }).runOnce(signal), "succeeded");
    const completed = await f.database.db.selectFrom("tor_jobs").selectAll().where("id", "=", queued.id).executeTakeFirstOrThrow();
    assert.equal(completed.status, "succeeded");
    assert.deepEqual(completed.payload, queued.payload);
    assert.deepEqual(await f.database.db.selectFrom("tor_outbox").selectAll().where("id", "=", outbox.id).executeTakeFirstOrThrow(), outbox);
    assert.equal(email.messages.length, before + 1);
    const token = email.messages.at(-1)?.text.match(/Accept with token (\S+) before/)?.[1];
    assert.ok(token);
    assert.equal(email.messages.at(-1)?.to, "reader@example.test");
    assert.equal((await f.post(acceptPath, { token }, recipient)).status, 200);
  } finally { await f.close(); }
});

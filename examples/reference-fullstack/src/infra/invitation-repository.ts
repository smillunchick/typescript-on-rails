import type { Selectable, Transaction } from "kysely";
import { NotFound } from "typescript-on-rails";

import type { InvitationRecord, InvitationRepository } from "../features/projects/index.js";
import type { ReferenceDatabase } from "./database.js";

type Row = Selectable<ReferenceDatabase["project_invitations"]>;
function record(row: Row): InvitationRecord {
  return {
    invitation: { id: row.id, projectId: row.project_id, email: row.email, expiresAt: row.expires_at.toISOString(), status: row.accepted_by === null ? "pending" : "accepted" },
    token: row.token, acceptedBy: row.accepted_by,
  };
}

export function postgresInvitationRepository(transaction: Transaction<ReferenceDatabase>): InvitationRepository {
  return Object.freeze({
    async create({ projectId, email, tenantId, now }) {
      const project = await transaction.selectFrom("projects").select("id").where("id", "=", projectId).executeTakeFirst();
      if (project === undefined) throw new NotFound();
      const inserted = await transaction.insertInto("project_invitations").values({
        id: crypto.randomUUID(), tenant_id: tenantId, project_id: projectId, email,
        token: crypto.randomUUID(), expires_at: new Date(now.getTime() + 86_400_000),
        accepted_by: null, accepted_at: null,
      }).onConflict((conflict) => conflict.columns(["tenant_id", "project_id", "email"]).doNothing()).returningAll().executeTakeFirst();
      const row = inserted ?? await transaction.selectFrom("project_invitations").selectAll()
        .where("tenant_id", "=", tenantId).where("project_id", "=", projectId).where("email", "=", email).executeTakeFirstOrThrow();
      return { record: record(row), created: inserted !== undefined };
    },
    async findForAcceptance(token) {
      const row = await transaction.selectFrom("project_invitations").selectAll().where("token", "=", token).forUpdate().executeTakeFirst();
      return row === undefined ? undefined : record(row);
    },
    async accept(id, actorId, now) {
      const row = await transaction.updateTable("project_invitations").set({ accepted_by: actorId, accepted_at: now })
        .where("id", "=", id).returningAll().executeTakeFirstOrThrow();
      return record(row).invitation;
    },
  } satisfies InvitationRepository);
}

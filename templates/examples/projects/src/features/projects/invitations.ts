import {
  action, Conflict, defineModel, defineRepository, enumOf, Forbidden, InvalidInput, NotFound,
  object, operationRoute, string,
} from "typescript-on-rails";

import type { ProjectCommandContext } from "./context.js";
import { ProjectInvitationCreated } from "./events.js";

export const ProjectInvitation = defineModel({
  name: "ProjectInvitation",
  fields: { id: string(), projectId: string(), email: string(), expiresAt: string(), status: enumOf("pending", "accepted") },
});
export type ProjectInvitationValue = ReturnType<typeof ProjectInvitation.parse>;

export interface InvitationRecord {
  readonly invitation: ProjectInvitationValue;
  readonly token: string;
  readonly acceptedBy: string | null;
}

export interface InvitationRepository {
  create(input: { readonly projectId: string; readonly email: string; readonly tenantId: string; readonly now: Date }): Promise<{ readonly record: InvitationRecord; readonly created: boolean }>;
  findForAcceptance(token: string): Promise<InvitationRecord | undefined>;
  accept(id: string, actorId: string, now: Date): Promise<ProjectInvitationValue>;
}

export const invitationsRepository = defineRepository<InvitationRepository>({
  name: "invitations", feature: "projects", relations: ["public.project_invitations"],
});

export const createProjectInvitation = action({
  input: object({ projectId: string(), email: string() }),
  output: object(ProjectInvitation.fields),
  permission: "project.create",
  async run(input, context: ProjectCommandContext) {
    const email = input.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || input.projectId.length > 80) throw new InvalidInput();
    const { record, created } = await context.invitations.create({ ...input, email, tenantId: context.tenantId, now: context.now });
    if (record.invitation.status !== "accepted" && new Date(record.invitation.expiresAt) <= context.now) throw new Conflict("Invitation expired");
    if (created) {
      await context.outbox.appendOutbox(ProjectInvitationCreated, {
        invitationId: record.invitation.id,
        projectId: record.invitation.projectId,
        recipient: { email: record.invitation.email },
        acceptance: { token: record.token, expiresAt: record.invitation.expiresAt },
      }, `project-invitation:${record.invitation.id}`);
    }
    return record.invitation;
  },
});

export const acceptProjectInvitation = action({
  input: object({ token: string() }),
  output: object(ProjectInvitation.fields),
  permission: "project.invitation.accept",
  async run({ token }, context: ProjectCommandContext) {
    const record = await context.invitations.findForAcceptance(token);
    if (record === undefined) throw new NotFound();
    if (record.invitation.email !== context.email) throw new Forbidden();
    if (record.acceptedBy !== null) {
      if (record.acceptedBy !== context.actorId) throw new Forbidden();
      return record.invitation;
    }
    if (new Date(record.invitation.expiresAt) <= context.now) throw new Conflict("Invitation expired");
    return context.invitations.accept(record.invitation.id, context.actorId, context.now);
  },
});

export const createProjectInvitationRoute = operationRoute({ method: "POST", path: "/api/projects/invitations", operation: createProjectInvitation });
export const acceptProjectInvitationRoute = operationRoute({ method: "POST", path: "/api/projects/invitations/accept", operation: acceptProjectInvitation });

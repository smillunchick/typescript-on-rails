import { event, object, string } from "typescript-on-rails";

export const ProjectCreated = event({ owner: "projects", name: "ProjectCreated", payload: object({ projectId: string() }) });
// Retain the old parser while version 1 records or queued jobs can still exist.
export const ProjectInvitationPayloadV1 = object({ invitationId: string(), projectId: string(), email: string(), token: string(), expiresAt: string() });
export const ProjectInvitationCreated = event({
  owner: "projects", name: "ProjectInvitationCreated", version: 2,
  payload: object({
    invitationId: string(), projectId: string(),
    recipient: object({ email: string() }),
    acceptance: object({ token: string(), expiresAt: string() }),
  }),
});

export const invitationUpcasters = [{
  event: ProjectInvitationCreated, from: 1, to: 2,
  upcast(value: unknown) {
    const old = ProjectInvitationPayloadV1.parse(value);
    return { invitationId: old.invitationId, projectId: old.projectId, recipient: { email: old.email }, acceptance: { token: old.token, expiresAt: old.expiresAt } };
  },
}];

export const ProjectCheckDue = event({ owner: "projects", name: "ProjectCheckDue", payload: object({ date: string() }) });

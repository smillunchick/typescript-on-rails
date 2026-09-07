import type { DurableConsumerContext } from "@typescript-on-rails/jobs";
import { consumer, defineFeature, emailContract, page, schedule } from "typescript-on-rails";

import type { ProjectCommandContext } from "./context.js";
import { ProjectCheckDue, ProjectCreated, ProjectInvitationCreated } from "./events.js";
import { acceptProjectInvitation, acceptProjectInvitationRoute, createProjectInvitation, createProjectInvitationRoute, invitationsRepository, ProjectInvitation } from "./invitations.js";
import { createProjectRoute } from "./http-contract.js";
import { Project } from "./model.js";
import { createProject } from "./operations.js";
import { projectsRepository } from "./repository.js";

interface WelcomeConsumerContext {
  readonly email: {
    send(message: { readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly text: string }): Promise<unknown>;
  };
}

export type { ProjectCommandContext } from "./context.js";
export { Project, type ProjectValue } from "./model.js";
export { ProjectCheckDue, ProjectCreated, ProjectInvitationCreated, ProjectInvitationPayloadV1, invitationUpcasters } from "./events.js";
export { acceptProjectInvitation, acceptProjectInvitationRoute, createProjectInvitation, createProjectInvitationRoute, invitationsRepository, ProjectInvitation, type InvitationRecord, type InvitationRepository } from "./invitations.js";
export { createProjectRoute } from "./http-contract.js";
export { createProject } from "./operations.js";
export { projectsRepository, type ProjectRepository } from "./repository.js";

export const sendProjectWelcome = consumer({
  name: "sendProjectWelcome",
  event: ProjectCreated,
  durable: true,
  async handle({ projectId }, context: DurableConsumerContext<WelcomeConsumerContext>) {
    await context.application.email.send({
      idempotencyKey: `welcome:${projectId}`,
      to: "developer@example.test",
      subject: "Project created",
      text: `Project ${projectId} was created.`,
    });
  },
});

export const sendProjectInvitation = consumer({
  name: "sendProjectInvitation",
  event: ProjectInvitationCreated,
  durable: true,
  async handle({ invitationId, projectId, recipient, acceptance }, context: DurableConsumerContext<WelcomeConsumerContext>) {
    await context.job.effect(`project-invitation:${invitationId}`, async () => {
      const result = await context.application.email.send({
        idempotencyKey: `project-invitation:${invitationId}`,
        to: recipient.email,
        subject: "Project invitation",
        text: `You are invited to project ${projectId}. Accept with token ${acceptance.token} before ${acceptance.expiresAt}.`,
      });
      return { value: result };
    });
  },
});

export const checkProjects = consumer({
  name: "checkProjects",
  event: ProjectCheckDue,
  durable: true,
  async handle({ date }, context: DurableConsumerContext<WelcomeConsumerContext>) {
    await context.application.email.send({
      idempotencyKey: `project-check:${date}`,
      to: "developer@example.test",
      subject: "Project check complete",
      text: `Project checks completed for ${date}.`,
    });
  },
});

export const dailyProjectCheck = schedule({
  name: "daily-project-check",
  feature: "projects",
  target: checkProjects,
  occurrences: (now) => {
    const date = now.toISOString().slice(0, 10);
    return [{ occurrence: date, payload: { date }, dueAt: now }];
  },
});

export const projectsFeature = defineFeature<ProjectCommandContext>({
  name: "projects",
  models: [Project, ProjectInvitation],
  operations: { createProject, createProjectInvitation, acceptProjectInvitation },
  routes: [createProjectRoute, createProjectInvitationRoute, acceptProjectInvitationRoute],
  pages: [page({ name: "projects", path: "/", runtime: "hybrid" })],
  permissions: ["project.create", "project.read", "project.invitation.accept"],
  events: [ProjectCreated, ProjectCheckDue, ProjectInvitationCreated],
  consumers: [sendProjectWelcome, checkProjects, sendProjectInvitation],
  adapters: [emailContract],
  repositories: [projectsRepository, invitationsRepository],
  schedules: [dailyProjectCheck],
});

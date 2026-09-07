import type { ExecutionContext, OwnedEventDefinition } from "typescript-on-rails";

import type { InvitationRepository } from "./invitations.js";
import type { ProjectRepository } from "./repository.js";

export interface ProjectCommandContext extends ExecutionContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly email: string;
  readonly now: Date;
  readonly projects: ProjectRepository;
  readonly invitations: InvitationRepository;
  readonly outbox: {
    appendOutbox<T>(event: OwnedEventDefinition<T>, payload: T, idempotencyKey: string): Promise<unknown>;
  };
}

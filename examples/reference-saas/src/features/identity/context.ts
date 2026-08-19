import type { ExecutionContext } from "typescript-on-rails";

import type { CustomerId, UserId } from "./model.js";

export interface AuthenticatedContext extends ExecutionContext {
  readonly userId: UserId;
  readonly customerId: CustomerId;
}

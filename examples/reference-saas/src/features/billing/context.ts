import type { AdapterImplementation, EventBus } from "typescript-on-rails";

import type { AuthenticatedContext } from "@/features/identity";

import { Payments } from "./payments.js";

export interface BillingContext extends AuthenticatedContext {
  readonly payments: AdapterImplementation<typeof Payments.operations>;
  readonly events: EventBus;
}

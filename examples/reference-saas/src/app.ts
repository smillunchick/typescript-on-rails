import { defineApp } from "typescript-on-rails";

import { billingFeature } from "./features/billing/index.js";
import { payments } from "./infra/payments/index.js";

export default defineApp({
  adapters: { payments },
  features: [billingFeature],
});

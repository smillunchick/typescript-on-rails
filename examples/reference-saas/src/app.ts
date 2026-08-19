import { defineApp } from "typescript-on-rails";

import { payments } from "./infra/payments/index.js";

export default defineApp({
  adapters: { payments },
});

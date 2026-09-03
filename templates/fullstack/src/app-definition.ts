import { defineApp } from "typescript-on-rails";

import { statusFeature } from "./features/status/index.js";
import { webEntrypoint } from "./infra/entrypoints.js";

export const application = defineApp({
  features: [statusFeature],
  entrypoints: { web: webEntrypoint },
});

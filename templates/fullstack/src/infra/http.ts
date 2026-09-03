import { bindRoute } from "@typescript-on-rails/web";

import { statusRoute } from "../features/status/index.js";

export const statusHttpRoute = bindRoute(statusRoute, {
  scope: (_input, execute) => execute({ permissions: new Set<string>() }),
});

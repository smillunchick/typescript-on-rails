import { operationRoute } from "typescript-on-rails";

import { createProject } from "./operations.js";

export const createProjectRoute = operationRoute({
  method: "POST",
  path: "/api/projects",
  operation: createProject,
});

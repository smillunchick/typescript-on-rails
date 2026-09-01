import { object, route, string } from "typescript-on-rails";

import { createProject } from "./operations.js";

export const createProjectRoute = route({
  method: "POST",
  path: "/api/projects",
  input: object({ id: string(), name: string() }),
  output: object({ id: string(), name: string() }),
  permission: "project.create",
  handler: (input, context) => createProject.execute(input, context),
});

import { action, object, string } from "typescript-on-rails";

import { Project } from "./model.js";
import { projectStore } from "./store.js";

export const createProject = action({
  input: object({ id: string(), name: string() }),
  output: object({ id: string(), name: string() }),
  permission: "project.create",
  run: (input) => projectStore.save(Project.parse(input)),
});

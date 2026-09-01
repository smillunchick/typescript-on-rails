import { consumer, defineFeature, page } from "typescript-on-rails";

import { ProjectCreated } from "./events.js";
import { createProjectRoute } from "./http-contract.js";
import { createProject } from "./operations.js";

export { Project, type ProjectValue } from "./model.js";
export { ProjectCreated } from "./events.js";
export { createProjectRoute } from "./http-contract.js";
export { createProject } from "./operations.js";
export { projectStore } from "./store.js";
export const projectsFeature = defineFeature({
  name: "projects",
  operations: { createProject },
  routes: [createProjectRoute],
  pages: [page({ name: "projects", path: "/", runtime: "hybrid" })],
  permissions: ["project.create", "project.read"],
  events: [ProjectCreated],
  consumers: [consumer({ name: "enqueueProjectWelcome", event: ProjectCreated, durable: true, handle: () => undefined })],
  tests: ["test/reference.test.ts"],
});

import { defineApp, entrypoint } from "typescript-on-rails";

import { accessFeature } from "./features/access/index.js";
import { projectsFeature } from "./features/projects/index.js";
import { identity } from "./infra/runtime.js";

export const application = defineApp({
  features: [accessFeature, projectsFeature],
  context: {
    create: () => ({
      permissions: new Set<string>(),
      authenticate: (credentials: { readonly subject: string; readonly proof: string }) =>
        identity.authenticate(credentials),
    }),
  },
  entrypoints: {
    web: entrypoint({ name: "next-web", process: "web", run: () => undefined }),
    worker: entrypoint({ name: "postgres-worker", process: "worker", run: () => undefined }),
    scheduler: entrypoint({ name: "postgres-scheduler", process: "scheduler", run: () => undefined }),
  },
  tests: [{ feature: "projects", files: ["test/reference.test.ts"] }],
});

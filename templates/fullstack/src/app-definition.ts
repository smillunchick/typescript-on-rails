import { defineApp, type RuntimeBinding } from "typescript-on-rails";

import { accessFeature } from "./features/access/index.js";
import { projectsFeature } from "./features/projects/index.js";
import { referenceEntrypoints } from "./infra/entrypoints.js";

export function createReferenceApplication(bindings?: readonly RuntimeBinding[]) {
  return defineApp({
    features: [accessFeature, projectsFeature],
    entrypoints: referenceEntrypoints(bindings),
    tests: [{ feature: "projects", files: ["test/reference.test.ts"] }],
  });
}

export const application = createReferenceApplication();

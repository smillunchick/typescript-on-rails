import { defineApp, type RuntimeBinding } from "typescript-on-rails";

import { accessFeature } from "./features/access/index.js";
import { projectsFeature } from "./features/projects/index.js";
import { referenceEntrypoints } from "./infra/entrypoints.js";
import { email, identity, sessions } from "./infra/runtime.js";

export function createReferenceApplication(bindings?: readonly RuntimeBinding[]) {
  return defineApp({
    adapters: { email, identity, session: sessions },
    features: [accessFeature, projectsFeature],
    entrypoints: referenceEntrypoints(bindings),
    tests: [{ suite: "reference", features: ["access", "projects"], files: ["test/reference.test.ts", "test/invitations.test.ts"] }],
  });
}

export const application = createReferenceApplication();

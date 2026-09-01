import { nextRoute } from "@typescript-on-rails/web/next";

import { createProjectHandler, signInHandler } from "./http.js";

export const createProjectNextRoute = nextRoute(createProjectHandler);
export const signInNextRoute = nextRoute(signInHandler);

import { nextRouteFor } from "@typescript-on-rails/web/next";

import { application } from "../app.js";

export const createProjectNextRoute = nextRouteFor(application.graph, "/api/projects", "POST");
export const signInNextRoute = nextRouteFor(application.graph, "/api/session", "POST");

import { nextRouteFor } from "@typescript-on-rails/web/next";

import { application } from "../app-definition.js";

export const statusNextRoute = nextRouteFor(application.graph, "/api/status", "GET");

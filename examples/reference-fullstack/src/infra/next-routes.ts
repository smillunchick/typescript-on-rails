import { nextRouteFor } from "@typescript-on-rails/web/next";

import { application } from "../app.js";
import { sessionRoute } from "../features/access/index.js";
import { acceptProjectInvitationRoute, createProjectInvitationRoute, createProjectRoute } from "../features/projects/index.js";

export const createProjectNextRoute = nextRouteFor(application.graph, createProjectRoute.metadata.path, createProjectRoute.metadata.method);
export const signInNextRoute = nextRouteFor(application.graph, sessionRoute.metadata.path, sessionRoute.metadata.method);
export const createProjectInvitationNextRoute = nextRouteFor(application.graph, createProjectInvitationRoute.metadata.path, createProjectInvitationRoute.metadata.method);
export const acceptProjectInvitationNextRoute = nextRouteFor(application.graph, acceptProjectInvitationRoute.metadata.path, acceptProjectInvitationRoute.metadata.method);

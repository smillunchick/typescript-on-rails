import { event, object, string } from "typescript-on-rails";

export const ProjectCreated = event({ name: "ProjectCreated", payload: object({ projectId: string() }) });

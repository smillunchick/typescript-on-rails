import { event, object, string } from "typescript-on-rails";

export const ProjectCreated = event({ owner: "projects", name: "ProjectCreated", payload: object({ projectId: string() }) });
export const ProjectCheckDue = event({ owner: "projects", name: "ProjectCheckDue", payload: object({ date: string() }) });

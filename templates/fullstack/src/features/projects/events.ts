import { event, object, string } from "typescript-on-rails";

export const ProjectCreated = event({ name: "ProjectCreated", payload: object({ projectId: string() }) });
export const ProjectCheckDue = event({ name: "ProjectCheckDue", payload: object({ date: string() }) });

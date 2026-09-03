import { defineModel, id, string } from "typescript-on-rails";

export const Project = defineModel({ name: "Project", fields: { id: id("Project"), name: string() } });
export type ProjectValue = ReturnType<typeof Project.parse>;

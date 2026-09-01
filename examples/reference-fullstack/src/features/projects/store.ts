import type { ProjectValue } from "./model.js";

const projects = new Map<string, ProjectValue>();
export const projectStore = Object.freeze({
  list: () => Object.freeze([...projects.values()].sort((a, b) => a.id.localeCompare(b.id))),
  save: (project: ProjectValue) => { projects.set(project.id, Object.freeze({ ...project })); return project; },
  clear: () => { projects.clear(); },
});

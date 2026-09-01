import { localEmailAdapter, localIdentityAdapter, localSessionAdapter } from "@typescript-on-rails/fullstack";
import { createWorker, memoryJobStore } from "@typescript-on-rails/jobs";

export const identity = localIdentityAdapter({ demo: "local-proof" });
export const sessions = localSessionAdapter();
export const email = localEmailAdapter();
export const jobs = memoryJobStore();
export const worker = createWorker({ store: jobs, handlers: { "projects.welcome": async (payload) => { const projectId = typeof payload === "object" && payload !== null && "projectId" in payload ? String(payload.projectId) : "unknown"; await email.send({ idempotencyKey: `welcome:${projectId}`, to: "developer@example.test", subject: "Project created", text: `Project ${projectId} was created.` }); } } });

export function cookieValue(request: Request, name: string): string | undefined {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0 && item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return undefined;
}

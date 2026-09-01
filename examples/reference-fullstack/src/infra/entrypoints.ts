import { processEntrypoint } from "@typescript-on-rails/fullstack";
import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  postgresJobStore,
  runScheduler,
} from "@typescript-on-rails/jobs";
import { entrypoint, type RuntimeBinding } from "typescript-on-rails";

import { checkProjects, projectsFeature } from "../features/projects/index.js";
import { referenceDatabase } from "./database.js";
import { createProjectHttpRoute, signInHttpRoute } from "./http.js";
import { email } from "./runtime.js";

export const consumers = createConsumerRuntime([projectsFeature], {
  context: ({ feature }) => {
    if (feature !== "projects") throw new Error(`CONSUMER_CONTEXT_NOT_CONFIGURED:${feature}`);
    return { email };
  },
});

function databaseUrl(processName: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL_REQUIRED_FOR_${processName.toUpperCase()}`);
  return url;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

const checkProjectsJob = consumers.bindings.find(({ target }) => target === checkProjects)?.binding.name;
if (checkProjectsJob === undefined) throw new Error("CHECK_PROJECTS_CONSUMER_NOT_REGISTERED");

export const workerEntrypoint = entrypoint({
  name: "postgres-worker",
  process: "worker",
  bindings: consumers.bindings,
  async run(signal) {
    const database = referenceDatabase(databaseUrl("worker"));
    const store = postgresJobStore(database.db);
    const worker = createWorker({ store, handlers: consumers.handlers });
    const publisher = consumers.publisher(store);
    try {
      while (!signal.aborted) {
        await dispatchOutbox(store, publisher);
        const result = await worker.runOnce(signal);
        if (result === "idle") await wait(500, signal);
      }
    } finally {
      await database.close();
    }
  },
});

export const schedulerEntrypoint = entrypoint({
  name: "postgres-scheduler",
  process: "scheduler",
  async run(signal) {
    const database = referenceDatabase(databaseUrl("scheduler"));
    const store = postgresJobStore(database.db);
    try {
      while (!signal.aborted) {
        const date = new Date().toISOString().slice(0, 10);
        await runScheduler(store, [{
          name: "daily-project-check",
          occurrences: () => [{
            schedule: "daily-project-check",
            occurrence: date,
            job: { name: checkProjectsJob, payload: { date }, idempotencyKey: `project-check:${date}` },
          }],
        }]);
        await wait(60_000, signal);
      }
    } finally {
      await database.close();
    }
  },
});

export function referenceEntrypoints(
  bindings: readonly RuntimeBinding[] = [signInHttpRoute, createProjectHttpRoute],
) {
  return Object.freeze({
    web: processEntrypoint({
      name: "next-web",
      process: "web",
      command: "npm",
      args: ["run", "dev:runtime"],
      bindings,
    }),
    worker: workerEntrypoint,
    scheduler: schedulerEntrypoint,
  });
}

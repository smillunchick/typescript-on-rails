import { processEntrypoint } from "@typescript-on-rails/fullstack";
import {
  createConsumerRuntime,
  createWorker,
  dispatchOutbox,
  postgresJobStore,
  runScheduler,
  scheduleRuntimeBinding,
} from "@typescript-on-rails/jobs";
import { entrypoint, type RuntimeBinding } from "typescript-on-rails";

import { dailyProjectCheck, projectsFeature } from "../features/projects/index.js";
import { referenceDatabase } from "./database.js";
import { createProjectHttpRoute, signInHttpRoute } from "./http.js";
import { email } from "./runtime.js";

export const consumers = createConsumerRuntime([projectsFeature], {
  context: (_input, { feature }) => {
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

export const workerEntrypoint = entrypoint({
  name: "postgres-worker",
  process: "worker",
  bindings: consumers.bindings,
  async run(signal) {
    const database = referenceDatabase(databaseUrl("worker"));
    const store = postgresJobStore(database.db);
    const worker = createWorker({ store, handlers: consumers.handlers });
    await store.assertOutboxCapability("exact");
    const publisher = consumers.publisher();
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
  bindings: [scheduleRuntimeBinding(dailyProjectCheck)],
  async run(signal) {
    const database = referenceDatabase(databaseUrl("scheduler"));
    const store = postgresJobStore(database.db);
    try {
      while (!signal.aborted) {
        const result = await runScheduler(store, [dailyProjectCheck], new Date(), { signal });
        if (result.failed > 0) {
          console.error(JSON.stringify({ code: "SCHEDULE_TICK_FAILED", failed: result.failed, failureOverflow: result.failureOverflow, failures: result.failures }));
        }
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

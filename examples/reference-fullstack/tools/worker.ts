import { localEmailAdapter } from "@typescript-on-rails/fullstack";
import { createWorker, dispatchOutbox, postgresJobStore } from "@typescript-on-rails/jobs";

import { referenceDatabase } from "../src/infra/database.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_REQUIRED_FOR_WORKER");
const runtime = referenceDatabase(url);
const email = localEmailAdapter();
const store = postgresJobStore(runtime.db);
const controller = new AbortController();
const stop = () => controller.abort(new Error("WORKER_STOPPED"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function wait(milliseconds: number): Promise<void> {
  if (controller.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    controller.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

try {
  const worker = createWorker({
    store,
    handlers: {
      "projects.welcome": async (payload) => {
        await email.send({
          idempotencyKey: JSON.stringify(payload),
          to: "developer@example.test",
          subject: "Project created",
          text: "A project was created.",
        });
      },
    },
  });
  while (!controller.signal.aborted) {
    await dispatchOutbox(store, {
      publish: async (record) => {
        if (record.event !== "ProjectCreated") return;
        await store.enqueue({
          name: "projects.welcome",
          payload: record.payload,
          idempotencyKey: `welcome:${record.idempotencyKey}`,
        });
      },
    });
    const result = await worker.runOnce(controller.signal);
    if (result === "idle") await wait(500);
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await runtime.close();
}

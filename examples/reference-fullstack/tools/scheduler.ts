import { postgresJobStore, runScheduler } from "@typescript-on-rails/jobs";
import { referenceDatabase } from "../src/infra/database.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_REQUIRED_FOR_SCHEDULER");
const runtime = referenceDatabase(url);
try {
  const date = new Date().toISOString().slice(0, 10);
  console.log(await runScheduler(postgresJobStore(runtime.db), [{ name: "daily-project-check", occurrences: () => [{ schedule: "daily-project-check", occurrence: date, job: { name: "projects.check", payload: { date }, idempotencyKey: `projects.check:${date}` } }] }]));
} finally { await runtime.close(); }

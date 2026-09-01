#!/usr/bin/env node

import { runCli } from "./features/tooling/index.js";

const controller = new AbortController();
const stop = () => controller.abort(new Error("APP_STOPPED"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const code = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = controller.signal.aborted ? 130 : code;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

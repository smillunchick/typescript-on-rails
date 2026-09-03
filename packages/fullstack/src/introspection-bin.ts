#!/usr/bin/env node

import {
  APPLICATION_INTROSPECTION_PROTOCOL,
  analyzeApplicationV3,
  type ApplicationIntrospectionResult,
} from "typescript-on-rails";

import { loadApplication } from "./application-loader.js";

function safeFailure(error: unknown): ApplicationIntrospectionResult {
  return {
    protocol: APPLICATION_INTROSPECTION_PROTOCOL,
    ok: false,
    error: {
      code: "APPLICATION_INTROSPECTION_FAILED",
      message: error instanceof Error ? error.message : "Application introspection failed",
    },
  };
}

function send(result: ApplicationIntrospectionResult, exitCode: number): void {
  if (typeof process.send !== "function") {
    process.stderr.write("APPLICATION_INTROSPECTION_IPC_REQUIRED\n");
    process.exit(1);
  }
  process.send(result, (error) => {
    if (error !== null) process.stderr.write("APPLICATION_INTROSPECTION_IPC_FAILED\n");
    process.exit(error === null ? exitCode : 1);
  });
}

const root = process.argv[2];
if (root === undefined) {
  send(safeFailure(new Error("APPLICATION_ROOT_REQUIRED")), 1);
} else {
  try {
    const application = await loadApplication(root);
    send({
      protocol: APPLICATION_INTROSPECTION_PROTOCOL,
      ok: true,
      manifest: analyzeApplicationV3(root, { application, asOf: new Date() }),
    }, 0);
  } catch (error) {
    send(safeFailure(error), 1);
  }
}

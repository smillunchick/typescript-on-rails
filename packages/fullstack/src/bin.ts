#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LifecycleRegistry, type LifecycleCommand, type LifecyclePlugin } from "./lifecycle.js";

function isLifecyclePlugins(value: unknown): value is readonly LifecyclePlugin[] {
  return Array.isArray(value) && value.every((plugin) =>
    typeof plugin === "object" &&
    plugin !== null &&
    "name" in plugin &&
    typeof plugin.name === "string" &&
    "commands" in plugin &&
    typeof plugin.commands === "object" &&
    plugin.commands !== null
  );
}

function isLifecycleRegistry(value: unknown): value is LifecycleRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "typescript-on-rails-lifecycle-registry/v1" &&
    "run" in value &&
    typeof value.run === "function"
  );
}

const commands = new Set<LifecycleCommand>(["dev", "build", "test", "check", "migrate", "worker", "scheduler", "seed"]);
const command = process.argv[2] as LifecycleCommand | undefined;
if (command === undefined || !commands.has(command)) {
  process.stderr.write("Usage: tor-lifecycle <dev|build|test|check|migrate|worker|scheduler|seed>\n");
  process.exitCode = 2;
} else {
  const root = process.cwd();
  const configPath = path.join(root, "fullstack.config.mjs");
  try {
    await access(configPath);
    const imported: unknown = await import(pathToFileURL(configPath).href);
    const configured =
      typeof imported === "object" && imported !== null && "default" in imported
        ? imported.default
        : undefined;
    const registry = isLifecycleRegistry(configured)
      ? configured
      : isLifecyclePlugins(configured)
        ? new LifecycleRegistry(configured)
        : undefined;
    if (registry === undefined) throw new Error(`LIFECYCLE_CONFIG_INVALID:${configPath}`);
    const controller = new AbortController();
    const stop = () => { controller.abort(new Error("LIFECYCLE_STOPPED")); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await registry.run(command, { cwd: root, environment: process.env, signal: controller.signal, write: (message) => { process.stdout.write(`${message}\n`); } });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

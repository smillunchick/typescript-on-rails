import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import {
  APPLICATION_INTROSPECTION_PROTOCOL,
  type ApplicationIntrospectionResult,
  type ArchitectureManifestV3,
} from "../../features/architecture/index.js";
import type { AnyAdapterInstance, App, ExecutionContext } from "../../features/runtime/index.js";

type FullStackApplication = App<
  Readonly<Record<string, AnyAdapterInstance>>,
  ExecutionContext
>;

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

async function readPackageJson(root: string): Promise<Readonly<Record<string, unknown>> | null> {
  let source: string;
  try {
    source = await readFile(path.join(root, "package.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  const packageJson: unknown = JSON.parse(source);
  return isRecord(packageJson) ? packageJson : null;
}

export async function hasFullStackLifecycle(root: string): Promise<boolean> {
  const packageJson = await readPackageJson(root);
  if (packageJson === null) return false;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const dependencies = packageJson[section];
    if (isRecord(dependencies) && typeof dependencies["@typescript-on-rails/fullstack"] === "string") return true;
  }
  return false;
}

function resolveFullStackExport(root: string, subpath: string): string {
  const resolveFromApp = createRequire(path.join(root, "package.json"));
  return resolveFromApp.resolve(`@typescript-on-rails/fullstack/${subpath}`);
}

export function resolveFullStackLifecycleBin(root: string): string {
  return resolveFullStackExport(root, "lifecycle-bin");
}

export interface FullStackIntrospectionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly maximumOutputBytes?: number;
  readonly childPath?: string;
}

export class FullStackIntrospectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FullStackIntrospectionError";
    this.code = code;
  }
}

function introspectionError(code: string, message: string): FullStackIntrospectionError {
  return new FullStackIntrospectionError(code, message);
}

function introspectionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { TYPESCRIPT_ON_RAILS_INTROSPECTION: "1" };
  for (const key of ["HOME", "NODE_ENV", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "WINDIR"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function isArchitectureManifestV3(value: unknown): value is ArchitectureManifestV3 {
  if (!isRecord(value) || value["version"] !== 3 || !isRecord(value["compiler"]) || !isRecord(value["base"])) return false;
  const completeness = value["completeness"];
  return value["base"]["version"] === 2
    && Array.isArray(value["composition"])
    && Array.isArray(value["workspaces"])
    && Array.isArray(value["packageCapabilities"])
    && isRecord(completeness)
    && typeof completeness["complete"] === "boolean"
    && Array.isArray(completeness["observations"]);
}

function isIntrospectionResult(value: unknown): value is ApplicationIntrospectionResult {
  if (!isRecord(value) || value["protocol"] !== APPLICATION_INTROSPECTION_PROTOCOL || typeof value["ok"] !== "boolean") return false;
  if (value["ok"] === true) return isArchitectureManifestV3(value["manifest"]);
  const error = value["error"];
  return isRecord(error) && typeof error["code"] === "string" && typeof error["message"] === "string";
}

export function inspectFullStackApplication(
  root: string,
  options: FullStackIntrospectionOptions = {},
): Promise<ArchitectureManifestV3> {
  const childPath = options.childPath ?? resolveFullStackExport(root, "introspection-bin");
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  const maximumOutputBytes = options.maximumOutputBytes ?? 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = fork(childPath, [root], {
      cwd: root,
      env: introspectionEnvironment(),
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let result: unknown;
    let outputBytes = 0;
    let stoppedFor: "abort" | "overflow" | "protocol" | "timeout" | undefined;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: "abort" | "overflow" | "protocol" | "timeout") => {
      if (stoppedFor !== undefined) return;
      stoppedFor = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      killTimer.unref();
    };
    const countOutput = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maximumOutputBytes) stop("overflow");
    };
    child.stdout?.on("data", countOutput);
    child.stderr?.on("data", countOutput);
    child.on("message", (value) => {
      countOutput(JSON.stringify(value) ?? "");
      if (result !== undefined) stop("protocol");
      else result = value;
    });
    const abort = () => stop("abort");
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => stop("timeout"), timeoutMilliseconds);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stoppedFor === "abort") reject(introspectionError("APPLICATION_INTROSPECTION_CANCELLED", "Application introspection was cancelled"));
      else if (stoppedFor === "overflow") reject(introspectionError("APPLICATION_INTROSPECTION_OUTPUT_LIMIT", "Application introspection exceeded its output limit"));
      else if (stoppedFor === "protocol") reject(introspectionError("APPLICATION_INTROSPECTION_PROTOCOL_VIOLATION", "Application introspection sent more than one result"));
      else if (stoppedFor === "timeout") reject(introspectionError("APPLICATION_INTROSPECTION_TIMEOUT", "Application introspection timed out"));
      else reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stoppedFor === "abort") return reject(introspectionError("APPLICATION_INTROSPECTION_CANCELLED", "Application introspection was cancelled"));
      if (stoppedFor === "overflow") return reject(introspectionError("APPLICATION_INTROSPECTION_OUTPUT_LIMIT", "Application introspection exceeded its output limit"));
      if (stoppedFor === "protocol") return reject(introspectionError("APPLICATION_INTROSPECTION_PROTOCOL_VIOLATION", "Application introspection sent more than one result"));
      if (stoppedFor === "timeout") return reject(introspectionError("APPLICATION_INTROSPECTION_TIMEOUT", "Application introspection timed out"));
      if (!isIntrospectionResult(result)) return reject(introspectionError("APPLICATION_INTROSPECTION_INVALID_RESULT", "Application introspection returned an invalid result"));
      if (!result.ok) return reject(introspectionError(result.error.code, result.error.message));
      if (code !== 0) return reject(introspectionError("APPLICATION_INTROSPECTION_EXIT", `Application introspection exited with code ${String(code)}`));
      resolve(result.manifest);
    });
  });
}

function isFullStackApplication(value: unknown): value is FullStackApplication {
  if (typeof value !== "object" || value === null || !("metadata" in value) || !("graph" in value)) {
    return false;
  }
  const metadata = value.metadata;
  const graph = value.graph;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "kind" in metadata &&
    metadata.kind === "app" &&
    typeof graph === "object" &&
    graph !== null &&
    "features" in graph &&
    Array.isArray(graph.features)
  );
}

export async function loadFullStackApplication(root: string): Promise<FullStackApplication> {
  const requireFromApp = createRequire(path.join(root, "package.json"));
  const loaded: unknown = requireFromApp("@typescript-on-rails/fullstack/application-loader");
  if (typeof loaded !== "object" || loaded === null || !("loadApplication" in loaded)) {
    throw new Error("FULLSTACK_APPLICATION_LOADER_INVALID");
  }
  const loader = loaded.loadApplication;
  if (typeof loader !== "function") throw new Error("FULLSTACK_APPLICATION_LOADER_INVALID");
  const application: unknown = await Reflect.apply(loader, undefined, [root]);
  if (!isFullStackApplication(application)) throw new Error("FULLSTACK_APPLICATION_INVALID");
  return application;
}

export async function hasAppOwnedScript(root: string, script: string): Promise<boolean> {
  const packageJson = await readPackageJson(root);
  if (packageJson === null) return false;
  const scripts = packageJson["scripts"];
  return isRecord(scripts) && typeof scripts[script] === "string";
}

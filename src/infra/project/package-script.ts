import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { App, ExecutionContext } from "../../features/runtime/index.js";

type FullStackApplication = App<
  Readonly<Record<string, { readonly contract: { readonly name: string } }>>,
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

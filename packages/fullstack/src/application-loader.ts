import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { tsImport } from "tsx/esm/api";
import type { App, ExecutionContext } from "typescript-on-rails";

export type LoadedApplication = App<
  Readonly<Record<string, { readonly contract: { readonly name: string } }>>,
  ExecutionContext
>;

function isLoadedApplication(value: unknown): value is LoadedApplication {
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

export async function loadApplication(
  root: string,
  relativePath = "src/app.ts",
): Promise<LoadedApplication> {
  const applicationPath = path.resolve(root, relativePath);
  const relative = path.relative(path.resolve(root), applicationPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`APPLICATION_MODULE_OUTSIDE_ROOT:${relativePath}`);
  }
  await access(applicationPath);
  const loaded = (await tsImport(pathToFileURL(applicationPath).href, {
    parentURL: pathToFileURL(path.join(root, "package.json")).href,
  })) as { readonly default?: unknown; readonly application?: unknown };
  const application = loaded.default ?? loaded.application;
  if (!isLoadedApplication(application)) {
    throw new Error(`APPLICATION_MODULE_INVALID:${relativePath}`);
  }
  return application;
}

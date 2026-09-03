import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { tsImport } from "tsx/esm/api";
import {
  APPLICATION_GRAPH_PROTOCOL_VERSION,
  type AnyAdapterInstance,
  type App,
  type ExecutionContext,
} from "typescript-on-rails";

export type LoadedApplication = App<
  Readonly<Record<string, AnyAdapterInstance>>,
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
    "graphProtocolVersion" in metadata &&
    metadata.graphProtocolVersion === APPLICATION_GRAPH_PROTOCOL_VERSION &&
    typeof graph === "object" &&
    graph !== null &&
    "features" in graph &&
    Array.isArray(graph.features) &&
    "adapters" in graph &&
    Array.isArray(graph.adapters) &&
    "repositories" in graph &&
    Array.isArray(graph.repositories) &&
    "relationExceptions" in graph &&
    Array.isArray(graph.relationExceptions)
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
  if (typeof application === "object" && application !== null && "metadata" in application) {
    const metadata = application.metadata;
    if (typeof metadata === "object" && metadata !== null && "kind" in metadata && metadata.kind === "app" && (!("graphProtocolVersion" in metadata) || metadata.graphProtocolVersion !== APPLICATION_GRAPH_PROTOCOL_VERSION)) {
      throw new Error(`APPLICATION_GRAPH_PROTOCOL_UNSUPPORTED:${String("graphProtocolVersion" in metadata ? metadata.graphProtocolVersion : "missing")}`);
    }
  }
  if (!isLoadedApplication(application)) {
    throw new Error(`APPLICATION_MODULE_INVALID:${relativePath}`);
  }
  return application;
}

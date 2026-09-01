import type { ApplicationEntrypoint, EntrypointKind } from "typescript-on-rails";

import { loadApplication, type LoadedApplication } from "./application-loader.js";
import { lifecyclePlugin, type LifecycleContext, type LifecyclePlugin } from "./lifecycle.js";

export interface ApplicationLifecycleOptions {
  readonly name?: string;
  readonly load?: (context: LifecycleContext) => Promise<LoadedApplication>;
}

async function runEntrypoints(
  entries: readonly ApplicationEntrypoint[],
  signal: AbortSignal,
): Promise<void> {
  if (entries.length === 0) throw new Error("APPLICATION_ENTRYPOINT_NOT_CONFIGURED");
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason ?? new Error("LIFECYCLE_ABORTED"));
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  try {
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.run(controller.signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }));
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export function applicationLifecyclePlugin(options: ApplicationLifecycleOptions = {}): LifecyclePlugin {
  const load = options.load ?? ((context: LifecycleContext) => loadApplication(context.cwd));
  const run = async (processes: readonly EntrypointKind[], context: LifecycleContext) => {
    const application = await load(context);
    const entries = processes.flatMap((process) => {
      const entry = application.graph.entrypoints[process];
      return entry === undefined ? [] : [entry];
    });
    await runEntrypoints(entries, context.signal);
  };
  return lifecyclePlugin({
    name: options.name ?? "application-entrypoints",
    commands: {
      dev: (context) => run(["web", "worker", "scheduler"], context),
      worker: (context) => run(["worker"], context),
      scheduler: (context) => run(["scheduler"], context),
    },
  });
}

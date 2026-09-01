import { entrypoint, type ApplicationEntrypoint, type EntrypointKind, type RuntimeBinding } from "typescript-on-rails";

export type LifecycleCommand = "dev" | "build" | "test" | "check" | "migrate" | "worker" | "scheduler" | "seed";

export interface LifecycleContext {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly write: (message: string) => void;
}

export interface LifecyclePlugin {
  readonly name: string;
  readonly commands: Partial<Record<LifecycleCommand, (context: LifecycleContext) => Promise<void> | void>>;
}

export interface LifecycleRunResult {
  readonly command: LifecycleCommand;
  readonly plugins: readonly string[];
}

export class LifecycleRegistry {
  readonly kind = "typescript-on-rails-lifecycle-registry/v1" as const;
  readonly #plugins: readonly LifecyclePlugin[];

  constructor(plugins: readonly LifecyclePlugin[]) {
    const names = new Set<string>();
    for (const plugin of plugins) {
      if (!plugin.name || names.has(plugin.name)) throw new TypeError(`Duplicate lifecycle plugin: ${plugin.name}`);
      names.add(plugin.name);
    }
    this.#plugins = Object.freeze([...plugins]);
  }

  supports(command: LifecycleCommand): boolean {
    return this.#plugins.some((plugin) => plugin.commands[command] !== undefined);
  }

  async run(command: LifecycleCommand, context: LifecycleContext): Promise<LifecycleRunResult> {
    const selected = this.#plugins.filter((plugin) => plugin.commands[command] !== undefined);
    if (selected.length === 0) throw new Error(`LIFECYCLE_COMMAND_NOT_CONFIGURED:${command}`);
    if (command === "dev" && selected.length > 1) {
      const controller = new AbortController();
      const stop = () => controller.abort(context.signal.reason ?? new Error("LIFECYCLE_ABORTED"));
      if (context.signal.aborted) stop();
      else context.signal.addEventListener("abort", stop, { once: true });
      try {
        await Promise.all(selected.map(async (plugin) => {
          try {
            await plugin.commands.dev?.({ ...context, signal: controller.signal });
          } catch (error) {
            controller.abort(error);
            throw error;
          }
        }));
      } finally {
        context.signal.removeEventListener("abort", stop);
      }
      return Object.freeze({ command, plugins: Object.freeze(selected.map(({ name }) => name)) });
    }
    const completed: string[] = [];
    for (const plugin of selected) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error("LIFECYCLE_ABORTED");
      await plugin.commands[command]?.(context);
      completed.push(plugin.name);
    }
    return Object.freeze({ command, plugins: Object.freeze(completed) });
  }
}

export function lifecyclePlugin(definition: LifecyclePlugin): LifecyclePlugin {
  return Object.freeze({ name: definition.name, commands: Object.freeze({ ...definition.commands }) });
}

interface ProcessDefinition {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

async function runProcess(
  definition: ProcessDefinition,
  context: { readonly cwd: string; readonly environment: Readonly<Record<string, string | undefined>>; readonly signal: AbortSignal },
  failure: string,
): Promise<void> {
  const { spawn } = await import("node:child_process");
  if (context.signal.aborted) throw context.signal.reason ?? new Error("LIFECYCLE_ABORTED");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(definition.command, [...(definition.args ?? [])], {
      cwd: definition.cwd ?? context.cwd,
      env: { ...context.environment },
      stdio: "inherit",
    });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      context.signal.removeEventListener("abort", stop);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      killTimer.unref();
    };
    context.signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => { finish(error); });
    child.once("exit", (code, signal) => {
      if (code === 0 || context.signal.aborted) finish();
      else finish(new Error(`${failure}:${String(code ?? signal)}`));
    });
  });
}

export function processEntrypoint(definition: {
  readonly name: string;
  readonly process: EntrypointKind;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly bindings?: readonly RuntimeBinding[];
}): ApplicationEntrypoint {
  return entrypoint({
    name: definition.name,
    process: definition.process,
    ...(definition.bindings === undefined ? {} : { bindings: definition.bindings }),
    run: (signal) => runProcess(definition, { cwd: definition.cwd ?? process.cwd(), environment: process.env, signal }, `ENTRYPOINT_PROCESS_FAILED:${definition.process}`),
  });
}

export function processLifecyclePlugin(
  name: string,
  definitions: Partial<Record<LifecycleCommand, ProcessDefinition>>,
): LifecyclePlugin {
  const commands: LifecyclePlugin["commands"] = {};
  for (const [lifecycle, definition] of Object.entries(definitions) as [LifecycleCommand, { readonly command: string; readonly args?: readonly string[] }][]) {
    commands[lifecycle] = (context) => runProcess(definition, context, `LIFECYCLE_PROCESS_FAILED:${lifecycle}`);
  }
  return lifecyclePlugin({ name, commands });
}

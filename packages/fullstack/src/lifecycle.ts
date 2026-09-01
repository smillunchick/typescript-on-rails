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

export function processLifecyclePlugin(
  name: string,
  definitions: Partial<Record<LifecycleCommand, { readonly command: string; readonly args?: readonly string[] }>>,
): LifecyclePlugin {
  const commands: LifecyclePlugin["commands"] = {};
  for (const [lifecycle, definition] of Object.entries(definitions) as [LifecycleCommand, { readonly command: string; readonly args?: readonly string[] }][]) {
    commands[lifecycle] = async (context) => {
      const { spawn } = await import("node:child_process");
      if (context.signal.aborted) throw context.signal.reason ?? new Error("LIFECYCLE_ABORTED");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(definition.command, [...(definition.args ?? [])], {
          cwd: context.cwd,
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
          if (code === 0) finish();
          else finish(new Error(`LIFECYCLE_PROCESS_FAILED:${lifecycle}:${String(code ?? signal)}`));
        });
      });
    };
  }
  return lifecyclePlugin({ name, commands });
}

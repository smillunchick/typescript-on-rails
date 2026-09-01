import { spawn } from "node:child_process";

export interface ProjectCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdio?: "inherit" | "stderr";
  readonly signal?: AbortSignal;
}

export function runProjectCommand(invocation: ProjectCommandInvocation): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      shell: false,
      stdio: invocation.stdio === "stderr" ? ["inherit", "pipe", "inherit"] : "inherit",
    });
    if (invocation.stdio === "stderr") child.stdout?.pipe(process.stderr);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
      killTimer.unref();
    };
    const finish = () => {
      invocation.signal?.removeEventListener("abort", stop);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    if (invocation.signal?.aborted) stop();
    else invocation.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      finish();
      if (invocation.signal?.aborted) resolve(130);
      else reject(error);
    });
    child.on("close", (code) => {
      finish();
      resolve(invocation.signal?.aborted ? 130 : code ?? 1);
    });
  });
}

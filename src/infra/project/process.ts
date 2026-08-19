import { spawn } from "node:child_process";

export interface ProjectCommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export function runProjectCommand(invocation: ProjectCommandInvocation): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      shell: false,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

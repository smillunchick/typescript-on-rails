import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  analyzeApplication,
  type ArchitectureManifest,
} from "../../features/architecture/index.js";
import {
  diffArchitecture,
  type ArchitectureDiff,
} from "../../features/introspection/index.js";

export type AnalyzeForDiff = (root: string) => ArchitectureManifest;

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]*$/;

export function validateGitRef(ref: string): void {
  if (
    !SAFE_REF.test(ref)
    || ref.startsWith("-")
    || ref.includes("..")
    || ref.includes("@{")
    || ref.includes("//")
  ) {
    throw new Error(`Invalid Git ref: ${ref}`);
  }
}

function runAndCapture(command: string, args: readonly string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${String(code)}`));
    });
  });
}

function runToFile(command: string, args: readonly string[], cwd: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: "wx" });
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(error);
    };
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", fail);
    output.on("error", fail);
    child.stdout.pipe(output);
    child.on("close", (code) => {
      if (code !== 0) {
        fail(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${String(code)}`));
        return;
      }
      output.on("close", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  });
}

function safeSnapshotPath(snapshotRoot: string, gitPath: string): string {
  if (gitPath.length === 0 || path.isAbsolute(gitPath) || gitPath.includes("\\")) {
    throw new Error(`Unsafe path in Git snapshot: ${gitPath}`);
  }
  const segments = gitPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments[0] === ".git") {
    throw new Error(`Unsafe path in Git snapshot: ${gitPath}`);
  }
  const destination = path.resolve(snapshotRoot, ...segments);
  const relative = path.relative(snapshotRoot, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe path in Git snapshot: ${gitPath}`);
  return destination;
}

async function linkNodeModules(applicationRoot: string, snapshotRoot: string): Promise<void> {
  const source = path.join(applicationRoot, "node_modules");
  try {
    const resolved = await realpath(source);
    if (!(await stat(resolved)).isDirectory()) return;
    const destination = path.join(snapshotRoot, "node_modules");
    await symlink(resolved, destination, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function materializeGitRef(applicationRoot: string, snapshotRoot: string, ref: string): Promise<void> {
  const listed = await runAndCapture("git", ["-C", applicationRoot, "ls-tree", "-r", "--name-only", "-z", ref], applicationRoot);
  const files = listed.toString("utf8").split("\0").filter((entry) => entry.length > 0);
  for (const gitPath of files) {
    if (gitPath === "node_modules" || gitPath.startsWith("node_modules/")) continue;
    const destination = safeSnapshotPath(snapshotRoot, gitPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await runToFile("git", ["-C", applicationRoot, "show", `${ref}:${gitPath}`], applicationRoot, destination);
  }
}

export async function createGitArchitectureDiff(
  applicationRoot: string,
  ref = "HEAD",
  analyze: AnalyzeForDiff = analyzeApplication,
): Promise<ArchitectureDiff> {
  validateGitRef(ref);
  const root = path.resolve(applicationRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`Unsafe application root: ${root}`);
  const snapshot = await mkdtemp(path.join(tmpdir(), "typescript-on-rails-ref-"));
  try {
    await materializeGitRef(root, snapshot, ref);
    await linkNodeModules(root, snapshot);
    const before = analyze(snapshot);
    const after = analyze(root);
    return diffArchitecture(before, after);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

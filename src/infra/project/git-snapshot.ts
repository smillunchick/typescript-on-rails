import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import { PACKAGE_POLICY_RULE } from "./package-policy.js";
import {
  analyzeApplication,
  type ArchitectureManifest,
} from "../../features/architecture/index.js";
import {
  assertComparableManifestV2,
  diffArchitecture,
  ManifestCompatibilityError,
  type ArchitectureDiff,
} from "../../features/introspection/index.js";

export type AnalyzeForDiff = (root: string) => unknown;

const EARLIEST_SUPPORTED_BASE = "Choose the manifest v2 migration commit, or a later commit with effective package policy, as the earliest supported architecture-diff base.";
const PACKAGE_CAPABILITY_RULE = "package-capability";

export type GitArchitectureDiffCompatibilityErrorCode =
  | "unsupported-architecture-diff-base"
  | "invalid-working-tree-architecture";

export class GitArchitectureDiffCompatibilityError extends Error {
  readonly name = "GitArchitectureDiffCompatibilityError";

  constructor(
    message: string,
    readonly code: GitArchitectureDiffCompatibilityErrorCode,
    readonly cause?: unknown,
  ) {
    super(code === "unsupported-architecture-diff-base" ? `${message} ${EARLIEST_SUPPORTED_BASE}` : message);
  }
}

function hasInvalidEffectivePackagePolicy(manifest: ArchitectureManifest): boolean {
  return manifest.diagnostics.some((entry) => (
    entry.severity === "error" && entry.rule === PACKAGE_POLICY_RULE
  ) || (
    entry.rule === PACKAGE_CAPABILITY_RULE && entry.packageCapabilityMigration !== undefined
  ));
}

function assertSupportedBase(value: unknown): asserts value is ArchitectureManifest {
  try {
    assertComparableManifestV2(value);
  } catch (error) {
    if (error instanceof ManifestCompatibilityError) {
      throw new GitArchitectureDiffCompatibilityError(
        "The Git base is not a compatible manifest v2 architecture snapshot.",
        "unsupported-architecture-diff-base",
        error,
      );
    }
    throw error;
  }
  if (hasInvalidEffectivePackagePolicy(value)) {
    throw new GitArchitectureDiffCompatibilityError(
      "The Git base has no valid effective package policy and predates the supported migration boundary.",
      "unsupported-architecture-diff-base",
    );
  }
}

function assertSupportedWorkingTree(value: unknown): asserts value is ArchitectureManifest {
  assertComparableManifestV2(value);
  if (hasInvalidEffectivePackagePolicy(value)) {
    throw new GitArchitectureDiffCompatibilityError(
      "The working tree has no valid effective package policy. Configure typescriptOnRails.packageCapabilities before comparing architecture.",
      "invalid-working-tree-architecture",
    );
  }
}

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

class GitBatchObjectReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly stderr: Buffer[] = [];
  private readonly closed: Promise<{ readonly code: number | null; readonly error: Error | null }>;
  private current: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.iterator = child.stdout[Symbol.asyncIterator]();
    child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.closed = new Promise((resolve) => {
      let processError: Error | null = null;
      child.once("error", (error) => { processError = error; });
      child.once("close", (code) => resolve({ code, error: processError }));
    });
  }

  private async ensureData(): Promise<void> {
    while (this.offset >= this.current.length) {
      const next = await this.iterator.next();
      if (next.done === true) throw new Error("Git object reader ended before completing a response");
      this.current = next.value;
      this.offset = 0;
    }
  }

  private async readLine(): Promise<string> {
    const parts: Buffer[] = [];
    while (true) {
      await this.ensureData();
      const newline = this.current.indexOf(10, this.offset);
      if (newline !== -1) {
        parts.push(this.current.subarray(this.offset, newline));
        this.offset = newline + 1;
        return Buffer.concat(parts).toString("utf8");
      }
      parts.push(this.current.subarray(this.offset));
      this.offset = this.current.length;
    }
  }

  private async writeBytes(destination: string, byteLength: number): Promise<void> {
    const output = createWriteStream(destination, { flags: "wx" });
    try {
      let remaining = byteLength;
      while (remaining > 0) {
        await this.ensureData();
        const available = this.current.length - this.offset;
        const length = Math.min(available, remaining);
        const chunk = this.current.subarray(this.offset, this.offset + length);
        this.offset += length;
        remaining -= length;
        if (!output.write(chunk)) await once(output, "drain");
      }
      output.end();
      await finished(output);
    } catch (error) {
      output.destroy();
      throw error;
    }
  }

  async writeBlob(objectId: string, destination: string): Promise<void> {
    if (!this.child.stdin.write(`${objectId}\n`)) await once(this.child.stdin, "drain");
    const header = await this.readLine();
    if (header === `${objectId} missing`) throw new Error(`Missing Git object: ${objectId}`);
    const match = /^([0-9a-f]+) ([a-z]+) ([0-9]+)$/.exec(header);
    if (match === null) throw new Error(`Invalid Git object response: ${header}`);
    const [, responseId, objectType, sizeText] = match;
    if (responseId !== objectId) throw new Error(`Unexpected Git object response for ${objectId}`);
    if (objectType !== "blob") throw new Error(`Expected Git blob ${objectId}, received ${String(objectType)}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid Git blob size for ${objectId}`);
    await this.writeBytes(destination, size);
    await this.ensureData();
    if (this.current[this.offset] !== 10) throw new Error(`Invalid Git blob delimiter for ${objectId}`);
    this.offset += 1;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    const result = await this.closed;
    if (result.error !== null) throw result.error;
    if (result.code !== 0) {
      const message = Buffer.concat(this.stderr).toString("utf8").trim();
      throw new Error(message || `git cat-file exited with code ${String(result.code)}`);
    }
  }

  async abort(): Promise<void> {
    this.child.stdin.destroy();
    if (this.child.exitCode === null) this.child.kill();
    await this.closed;
  }
}

function startGitObjectReader(applicationRoot: string): GitBatchObjectReader {
  const child = spawn("git", ["-C", applicationRoot, "cat-file", "--batch"], {
    cwd: applicationRoot,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new GitBatchObjectReader(child);
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

interface GitTreeEntry {
  readonly objectId: string;
  readonly objectType: string;
  readonly path: string;
}

function parseGitTreeEntry(record: Buffer): GitTreeEntry {
  const tab = record.indexOf(9);
  const header = tab === -1 ? "" : record.subarray(0, tab).toString("ascii");
  const match = /^[0-7]+ ([a-z]+) ([0-9a-f]+)$/.exec(header);
  if (match === null || tab === record.length - 1) throw new Error(`Invalid Git tree entry: ${header}`);
  const gitPath = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(tab + 1));
  return { objectType: match[1] ?? "", objectId: match[2] ?? "", path: gitPath };
}

async function* listGitTree(applicationRoot: string, ref: string): AsyncGenerator<GitTreeEntry> {
  const child = spawn("git", ["-C", applicationRoot, "ls-tree", "-r", "-z", ref], {
    cwd: applicationRoot,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = new Promise<{ readonly code: number | null; readonly error: Error | null }>((resolve) => {
    let processError: Error | null = null;
    child.once("error", (error) => { processError = error; });
    child.once("close", (code) => resolve({ code, error: processError }));
  });
  let pending: Buffer = Buffer.alloc(0);
  let readComplete = false;
  try {
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (let separator = data.indexOf(0, start); separator !== -1; separator = data.indexOf(0, start)) {
        if (separator > start) yield parseGitTreeEntry(data.subarray(start, separator));
        start = separator + 1;
      }
      pending = data.subarray(start);
    }
    if (pending.length > 0) throw new Error("Git tree output ended without a record delimiter");
    readComplete = true;
  } finally {
    if (!readComplete && child.exitCode === null) child.kill();
    const result = await closed;
    if (readComplete) {
      if (result.error !== null) throw result.error;
      if (result.code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        throw new Error(message || `git ls-tree exited with code ${String(result.code)}`);
      }
    }
  }
}

async function materializeGitRef(applicationRoot: string, snapshotRoot: string, ref: string): Promise<void> {
  const reader = startGitObjectReader(applicationRoot);
  try {
    for await (const entry of listGitTree(applicationRoot, ref)) {
      if (entry.path === "node_modules" || entry.path.startsWith("node_modules/")) continue;
      if (entry.objectType !== "blob") {
        throw new Error(`Unsupported Git object type ${entry.objectType} at ${entry.path}`);
      }
      const destination = safeSnapshotPath(snapshotRoot, entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await reader.writeBlob(entry.objectId, destination);
    }
    await reader.close();
  } catch (error) {
    await reader.abort();
    throw error;
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
    assertSupportedBase(before);
    assertSupportedWorkingTree(after);
    return diffArchitecture(before, after);
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

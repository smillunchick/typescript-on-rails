import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CONTROL_DIRECTORY = ".typescript-on-rails";
const JOURNAL_FILE = "project-edit.json";
const LOCK_FILE = "project-edit.lock";
const BACKUP_DIRECTORY = "project-edit-backup";
const JOURNAL_PROTOCOL = "typescript-on-rails.project-edit/v1" as const;

export type ProjectEditRequest =
  | { readonly path: string; readonly content: string; readonly ifAbsent?: true; readonly delete?: never }
  | { readonly path: string; readonly delete: true; readonly content?: never };

interface ProjectFileSnapshot {
  readonly content: Buffer;
  readonly mode: number;
}

interface PlannedProjectEdit {
  readonly path: string;
  readonly previous?: ProjectFileSnapshot;
  readonly content?: string;
}

export interface ProjectEditPlan {
  readonly root: string;
  readonly edits: readonly PlannedProjectEdit[];
  readonly createdDirectories: readonly string[];
}

export interface ProjectEditOptions {
  readonly validate?: (root: string) => Promise<void> | void;
  readonly testing?: {
    readonly beforeApply?: (index: number, relativePath: string) => Promise<void> | void;
    readonly beforeRestore?: (index: number, relativePath: string) => Promise<void> | void;
  };
}

interface JournalEntry {
  readonly path: string;
  readonly existed: boolean;
  readonly mode?: number;
  readonly backup?: string;
}

interface ProjectEditJournal {
  readonly protocol: typeof JOURNAL_PROTOCOL;
  readonly entries: readonly JournalEntry[];
  readonly createdDirectories: readonly string[];
}

export class ProjectEditError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectEditError";
    this.code = code;
  }
}

function projectEditError(code: string, detail?: string): ProjectEditError {
  return new ProjectEditError(code, detail === undefined ? code : `${code}:${detail}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function relativeTarget(root: string, input: string): { readonly relative: string; readonly absolute: string } {
  if (input.trim() === "" || path.isAbsolute(input)) throw projectEditError("PROJECT_EDIT_PATH_OUTSIDE_ROOT", input);
  const absolute = path.resolve(root, input);
  const relative = path.relative(root, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw projectEditError("PROJECT_EDIT_PATH_OUTSIDE_ROOT", input);
  }
  return { relative: relative.split(path.sep).join("/"), absolute };
}

async function assertSafeTarget(root: string, relative: string): Promise<string> {
  const { absolute } = relativeTarget(root, relative);
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] ?? "");
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw projectEditError("PROJECT_EDIT_SYMLINK", relative);
      if (index < segments.length - 1 && !metadata.isDirectory()) throw projectEditError("PROJECT_EDIT_PARENT_NOT_DIRECTORY", relative);
      if (index === segments.length - 1 && !metadata.isFile()) throw projectEditError("PROJECT_EDIT_TARGET_NOT_FILE", relative);
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return absolute;
}

async function snapshot(root: string, relative: string): Promise<ProjectFileSnapshot | undefined> {
  const file = await assertSafeTarget(root, relative);
  try {
    const metadata = await lstat(file);
    return { content: await readFile(file), mode: metadata.mode & 0o777 };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function snapshotsMatch(left: ProjectFileSnapshot | undefined, right: ProjectFileSnapshot | undefined): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.mode === right.mode && left.content.equals(right.content);
}

async function atomicWrite(file: string, content: string | Buffer, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tor-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, file);
    await chmod(file, mode);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeCreatedDirectories(root: string, directories: readonly string[]): Promise<void> {
  const deepestFirst = [...directories].sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  for (const relative of deepestFirst) {
    try { await rmdir(path.join(root, relative)); }
    catch { /* Preserve a directory when another file now uses it. */ }
  }
}

async function missingParentDirectories(root: string, relative: string): Promise<readonly string[]> {
  const output: string[] = [];
  let current = path.posix.dirname(relative);
  while (current !== ".") {
    const absolute = path.join(root, ...current.split("/"));
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) throw projectEditError("PROJECT_EDIT_SYMLINK", current);
      if (!metadata.isDirectory()) throw projectEditError("PROJECT_EDIT_PARENT_NOT_DIRECTORY", current);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      output.push(current);
      current = path.posix.dirname(current);
    }
  }
  return output;
}

async function applyEdit(root: string, edit: PlannedProjectEdit): Promise<void> {
  const file = await assertSafeTarget(root, edit.path);
  if (edit.content === undefined) {
    await rm(file, { force: true });
    return;
  }
  await atomicWrite(file, edit.content, edit.previous?.mode);
}

function excludedFromValidation(relative: string): boolean {
  const segments = relative.split(path.sep);
  return segments.some((segment) => segment === ".git" || segment === ".next" || segment === ".pi" || segment === CONTROL_DIRECTORY || segment === "dist" || segment === "node_modules");
}

async function validationWorkspace(plan: ProjectEditPlan): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "typescript-on-rails-edit-"));
  const workspace = path.join(parent, "workspace");
  await cp(plan.root, workspace, {
    recursive: true,
    filter(source) {
      const relative = path.relative(plan.root, source);
      return relative === "" || !excludedFromValidation(relative);
    },
  });
  try {
    const modules = await realpath(path.join(plan.root, "node_modules"));
    await symlink(modules, path.join(workspace, "node_modules"), "dir");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const edit of plan.edits) await applyEdit(workspace, edit);
  return { parent, root: workspace };
}

function controlPaths(root: string) {
  const directory = path.join(root, CONTROL_DIRECTORY);
  return {
    directory,
    journal: path.join(directory, JOURNAL_FILE),
    lock: path.join(directory, LOCK_FILE),
    backup: path.join(directory, BACKUP_DIRECTORY),
  };
}

async function readJournal(root: string): Promise<ProjectEditJournal> {
  const { journal } = controlPaths(root);
  await assertSafeTarget(root, `${CONTROL_DIRECTORY}/${JOURNAL_FILE}`);
  const value: unknown = JSON.parse(await readFile(journal, "utf8"));
  if (typeof value !== "object" || value === null || !("protocol" in value) || value.protocol !== JOURNAL_PROTOCOL || !("entries" in value) || !Array.isArray(value.entries)) {
    throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
  }
  const entries: JournalEntry[] = [];
  for (const entry of value.entries) {
    if (typeof entry !== "object" || entry === null || !("path" in entry) || typeof entry.path !== "string" || !("existed" in entry) || typeof entry.existed !== "boolean") {
      throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    }
    const normalizedPath = relativeTarget(root, entry.path).relative;
    if (normalizedPath !== entry.path) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    const mode = "mode" in entry && typeof entry.mode === "number" ? entry.mode : undefined;
    const backup = "backup" in entry && typeof entry.backup === "string" ? entry.backup : undefined;
    if (entry.existed && (
      mode === undefined || !Number.isInteger(mode) || mode < 0 || mode > 0o777
      || backup === undefined || path.basename(backup) !== backup || !/^\d+\.bin$/.test(backup)
    )) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    if (!entry.existed && (mode !== undefined || backup !== undefined)) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    entries.push({ path: normalizedPath, existed: entry.existed, ...(mode === undefined ? {} : { mode }), ...(backup === undefined ? {} : { backup }) });
  }
  if (!("createdDirectories" in value) || !Array.isArray(value.createdDirectories)) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
  const createdDirectories: string[] = [];
  for (const directory of value.createdDirectories) {
    if (typeof directory !== "string" || relativeTarget(root, `${directory}/placeholder`).relative !== `${directory}/placeholder`) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    createdDirectories.push(directory);
  }
  return { protocol: JOURNAL_PROTOCOL, entries, createdDirectories: Object.freeze([...new Set(createdDirectories)]) };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

async function createLock(lock: string) {
  const handle = await open(lock, "wx", 0o600);
  await handle.writeFile(`${String(process.pid)}\n`);
  return handle;
}

async function acquireLock(root: string) {
  const paths = controlPaths(root);
  await assertSafeTarget(root, `${CONTROL_DIRECTORY}/${LOCK_FILE}`);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  try {
    return { handle: await createLock(paths.lock), paths };
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    let pid = Number.NaN;
    try { pid = Number.parseInt((await readFile(paths.lock, "utf8")).trim(), 10); }
    catch { throw projectEditError("PROJECT_EDIT_LOCKED"); }
    if (processIsAlive(pid)) throw projectEditError("PROJECT_EDIT_LOCKED");
    await rm(paths.lock, { force: true });
    try { return { handle: await createLock(paths.lock), paths }; }
    catch (retryError) {
      if (isAlreadyExists(retryError)) throw projectEditError("PROJECT_EDIT_LOCKED");
      throw retryError;
    }
  }
}

async function removeControl(paths: ReturnType<typeof controlPaths>, keepJournal: boolean): Promise<void> {
  if (!keepJournal) {
    await rm(paths.journal, { force: true });
    await rm(paths.backup, { recursive: true, force: true });
  }
  await rm(paths.lock, { force: true });
  if (!keepJournal) {
    try { await rmdir(paths.directory); } catch { /* Another framework control may share this directory. */ }
  }
}

async function restoreEntries(
  root: string,
  entries: readonly JournalEntry[],
  backupRoot: string,
  createdDirectories: readonly string[],
  beforeRestore?: (index: number, relativePath: string) => Promise<void> | void,
): Promise<void> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    await beforeRestore?.(index, entry.path);
    const file = await assertSafeTarget(root, entry.path);
    if (!entry.existed) {
      await rm(file, { force: true });
      continue;
    }
    if (entry.backup === undefined || entry.mode === undefined) throw projectEditError("PROJECT_EDIT_JOURNAL_INVALID");
    const backup = path.join(backupRoot, entry.backup);
    await atomicWrite(file, await readFile(backup), entry.mode);
  }
  await removeCreatedDirectories(root, createdDirectories);
}

export async function planProjectEdit(rootInput: string, requests: readonly ProjectEditRequest[]): Promise<ProjectEditPlan> {
  const root = await realpath(rootInput);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw projectEditError("PROJECT_EDIT_ROOT_NOT_DIRECTORY");
  const seen = new Set<string>();
  const edits: PlannedProjectEdit[] = [];
  const createdDirectories = new Set<string>();
  for (const request of requests) {
    const target = relativeTarget(root, request.path);
    if (seen.has(target.relative)) throw projectEditError("PROJECT_EDIT_DUPLICATE_PATH", target.relative);
    seen.add(target.relative);
    const previous = await snapshot(root, target.relative);
    if (request.delete !== true && request.ifAbsent === true && previous !== undefined) throw projectEditError("PROJECT_EDIT_CREATE_COLLISION", target.relative);
    if (previous === undefined) for (const directory of await missingParentDirectories(root, target.relative)) createdDirectories.add(directory);
    edits.push({
      path: target.relative,
      ...(previous === undefined ? {} : { previous }),
      ...(request.delete === true ? {} : { content: request.content }),
    });
  }
  edits.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    root,
    edits: Object.freeze(edits.map((edit) => Object.freeze(edit))),
    createdDirectories: Object.freeze([...createdDirectories].sort()),
  });
}

export async function executeProjectEdit(plan: ProjectEditPlan, options: ProjectEditOptions = {}): Promise<void> {
  const paths = controlPaths(plan.root);
  await assertSafeTarget(plan.root, `${CONTROL_DIRECTORY}/${LOCK_FILE}`);
  try {
    await lstat(paths.journal);
    throw projectEditError("PROJECT_EDIT_RECOVERY_REQUIRED");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (options.validate !== undefined) {
    const workspace = await validationWorkspace(plan);
    try { await options.validate(workspace.root); }
    finally { await rm(workspace.parent, { recursive: true, force: true }); }
  }

  const { handle, paths: lockedPaths } = await acquireLock(plan.root);
  let keepJournal = false;
  try {
    for (const edit of plan.edits) {
      if (!snapshotsMatch(edit.previous, await snapshot(plan.root, edit.path))) {
        throw projectEditError("PROJECT_EDIT_STALE_PREIMAGE", edit.path);
      }
    }

    await mkdir(lockedPaths.backup, { recursive: false, mode: 0o700 });
    const journalEntries: JournalEntry[] = [];
    for (let index = 0; index < plan.edits.length; index += 1) {
      const edit = plan.edits[index];
      if (edit === undefined || edit.previous === undefined) {
        if (edit !== undefined) journalEntries.push({ path: edit.path, existed: false });
        continue;
      }
      const backup = `${String(index)}.bin`;
      await writeFile(path.join(lockedPaths.backup, backup), edit.previous.content, { mode: 0o600 });
      journalEntries.push({ path: edit.path, existed: true, mode: edit.previous.mode, backup });
    }
    const journal: ProjectEditJournal = { protocol: JOURNAL_PROTOCOL, entries: journalEntries, createdDirectories: plan.createdDirectories };
    await writeFile(lockedPaths.journal, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });

    try {
      for (let index = 0; index < plan.edits.length; index += 1) {
        const edit = plan.edits[index];
        if (edit === undefined) continue;
        await options.testing?.beforeApply?.(index, edit.path);
        await applyEdit(plan.root, edit);
      }
      await options.validate?.(plan.root);
    } catch (error) {
      try {
        await restoreEntries(plan.root, journalEntries, lockedPaths.backup, plan.createdDirectories, options.testing?.beforeRestore);
      } catch (restoreError) {
        keepJournal = true;
        throw new AggregateError([error, restoreError], "PROJECT_EDIT_RECOVERY_REQUIRED");
      }
      throw error;
    }
  } finally {
    await handle.close();
    await removeControl(lockedPaths, keepJournal);
  }
}

export async function recoverProjectEdit(rootInput: string): Promise<void> {
  const root = await realpath(rootInput);
  const paths = controlPaths(root);
  let journal: ProjectEditJournal;
  try { journal = await readJournal(root); }
  catch (error) {
    if (isMissing(error)) throw projectEditError("PROJECT_EDIT_RECOVERY_NOT_FOUND");
    throw error;
  }
  const { handle } = await acquireLock(root);
  try {
    await restoreEntries(root, journal.entries, paths.backup, journal.createdDirectories);
  } finally {
    await handle.close();
  }
  await removeControl(paths, false);
}

import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  executeProjectEdit,
  planProjectEdit,
  recoverProjectEdit,
} from "../src/infra/project/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((run) => run())));

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tor-project-edit-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "one.ts"), "export const one = 1;\n");
  await writeFile(path.join(root, "unrelated.txt"), "keep\n");
  return root;
}

describe("recoverable project edits", () => {
  it("validates a temporary workspace and applies all files together", async () => {
    const root = await project();
    const plan = await planProjectEdit(root, [
      { path: "src/one.ts", content: "export const one = 2;\n" },
      { path: "src/two.ts", content: "export const two = 2;\n" },
    ]);
    const validated: string[] = [];

    await executeProjectEdit(plan, {
      validate: async (workspace) => {
        validated.push(workspace);
        assert.equal(await readFile(path.join(workspace, "src", "one.ts"), "utf8"), "export const one = 2;\n");
        assert.equal(await readFile(path.join(workspace, "src", "two.ts"), "utf8"), "export const two = 2;\n");
      },
    });

    assert.equal(validated.length, 2);
    assert.notEqual(validated[0], root);
    assert.equal(validated[1], root);
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "export const one = 2;\n");
    assert.equal(await readFile(path.join(root, "src", "two.ts"), "utf8"), "export const two = 2;\n");
    assert.equal(await readFile(path.join(root, "unrelated.txt"), "utf8"), "keep\n");
  });

  it("writes nothing when preflight validation fails or a preimage is stale", async () => {
    const root = await project();
    const invalid = await planProjectEdit(root, [{ path: "src/one.ts", content: "invalid\n" }]);
    await assert.rejects(
      executeProjectEdit(invalid, { validate: () => { throw new Error("invalid application"); } }),
      /invalid application/,
    );
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "export const one = 1;\n");

    const stale = await planProjectEdit(root, [{ path: "src/one.ts", content: "planned\n" }]);
    await writeFile(path.join(root, "src", "one.ts"), "concurrent\n");
    await assert.rejects(executeProjectEdit(stale), /PROJECT_EDIT_STALE_PREIMAGE.*src\/one\.ts/);
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "concurrent\n");
  });

  it("rolls back an interrupted multi-file apply and can recover a failed rollback", async () => {
    const root = await project();
    const plan = await planProjectEdit(root, [
      { path: "src/one.ts", content: "changed\n" },
      { path: "src/zz/two.ts", content: "created\n" },
    ]);
    await assert.rejects(
      executeProjectEdit(plan, {
        testing: { beforeApply: (index) => { if (index === 1) throw new Error("injected apply failure"); } },
      }),
      /injected apply failure/,
    );
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "export const one = 1;\n");
    await assert.rejects(readFile(path.join(root, "src", "zz", "two.ts")), /ENOENT/);
    await assert.rejects(lstat(path.join(root, "src", "zz")), /ENOENT/);

    const recoveryPlan = await planProjectEdit(root, [{ path: "src/one.ts", content: "changed again\n" }]);
    await assert.rejects(
      executeProjectEdit(recoveryPlan, {
        validate: (workspace) => { if (workspace === root) throw new Error("post-apply failure"); },
        testing: { beforeRestore: () => { throw new Error("injected restore failure"); } },
      }),
      /PROJECT_EDIT_RECOVERY_REQUIRED/,
    );
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "changed again\n");
    await writeFile(path.join(root, ".typescript-on-rails", "project-edit.lock"), "99999999\n");
    await recoverProjectEdit(root);
    assert.equal(await readFile(path.join(root, "src", "one.ts"), "utf8"), "export const one = 1;\n");
  });

  it("rejects path traversal and unsafe modes in a recovery journal", async () => {
    const root = await project();
    const control = path.join(root, ".typescript-on-rails");
    await mkdir(path.join(control, "project-edit-backup"), { recursive: true });
    await writeFile(path.join(control, "project-edit.json"), JSON.stringify({
      protocol: "typescript-on-rails.project-edit/v1",
      entries: [{ path: "src/one.ts", existed: true, mode: 0o4777, backup: "../../outside" }],
      createdDirectories: [],
    }));
    await assert.rejects(recoverProjectEdit(root), /PROJECT_EDIT_JOURNAL_INVALID/);
  });

  it("preserves pre-existing directory modes when a deleted file is restored", async () => {
    const root = await project();
    const directory = path.join(root, "private");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(path.join(directory, "secret.txt"), "restore me\n");
    const plan = await planProjectEdit(root, [{ path: "private/secret.txt", delete: true }]);
    await assert.rejects(
      executeProjectEdit(plan, { validate: (workspace) => { if (workspace === root) throw new Error("post-delete failure"); } }),
      /post-delete failure/,
    );
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal(await readFile(path.join(directory, "secret.txt"), "utf8"), "restore me\n");
  });

  it("rejects duplicate, outside-root, and symlink targets", async () => {
    const root = await project();
    await assert.rejects(
      planProjectEdit(root, [{ path: "src/one.ts", content: "a" }, { path: "src/one.ts", content: "b" }]),
      /PROJECT_EDIT_DUPLICATE_PATH/,
    );
    await assert.rejects(
      planProjectEdit(root, [{ path: "src/one.ts", content: "replacement", ifAbsent: true }]),
      /PROJECT_EDIT_CREATE_COLLISION/,
    );
    await assert.rejects(planProjectEdit(root, [{ path: "../outside.ts", content: "no" }]), /PROJECT_EDIT_PATH_OUTSIDE_ROOT/);
    await symlink(path.join(root, "src", "one.ts"), path.join(root, "src", "linked.ts"));
    await assert.rejects(planProjectEdit(root, [{ path: "src/linked.ts", content: "no" }]), /PROJECT_EDIT_SYMLINK/);
    await symlink(path.join(root, "src"), path.join(root, ".typescript-on-rails"));
    const plan = await planProjectEdit(root, [{ path: "src/one.ts", content: "safe\n" }]);
    let validated = false;
    await assert.rejects(executeProjectEdit(plan, { validate: () => { validated = true; } }), /PROJECT_EDIT_SYMLINK/);
    assert.equal(validated, false);
  });
});

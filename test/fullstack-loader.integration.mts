import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { runCli } from "../src/features/tooling/index.js";

function stream() {
  let value = "";
  return {
    write(chunk: string) { value += chunk; },
    value: () => value,
  };
}

describe("installed full-stack application loader", () => {
  it("fails the real app check with JSON evidence for explicit unregistered host methods", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-host-completeness-"));
    try {
      for (const file of ["src", "test", "package.json", "tsconfig.json", "next-env.d.ts", "fullstack.config.mjs"]) {
        await cp(path.resolve("templates/fullstack", file), path.join(root, file), { recursive: true });
      }
      await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
      const cli = path.resolve("dist/bin.js");
      const check = () => spawnSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
      const green = check();
      assert.equal(green.status, 0, green.stderr);
      assert.equal(JSON.parse(green.stdout).ok, true);
      assert.match(green.stderr, /check:runtime/);
      const routeFile = path.join(root, "src/app/api/status/route.ts");
      await writeFile(routeFile, `${await readFile(routeFile, "utf8")}\nexport function HEAD() { return new Response(null); }\nconst options = () => new Response(null); export { options as OPTIONS };\n`);
      const red = check();
      assert.equal(red.status, 1, red.stderr);
      const receipt = JSON.parse(red.stdout);
      assert.equal(receipt.ok, false);
      assert.equal(receipt.executable.complete, false);
      assert.deepEqual(receipt.executable.unknowns.map((entry: { category: string; name: string }) => [entry.category, entry.name]), [
        ["discovered-undeclared", "HEAD /api/status"], ["discovered-undeclared", "OPTIONS /api/status"],
      ]);
      assert.match(red.stderr, /incomplete/);
      const unknowns = spawnSync(process.execPath, [cli, "unknowns", "--json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
      assert.equal(unknowns.status, 0, unknowns.stderr);
      assert.deepEqual(JSON.parse(unknowns.stdout).unknowns, receipt.executable.unknowns);
      assert.equal(unknowns.stderr, "");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("loads the real TypeScript composition for Manifest v3 CLI commands and checks", async () => {
    const stdout = stream();
    const root = path.resolve("examples/reference-fullstack");
    assert.equal(await runCli(["manifest", "--v3", "--json"], { cwd: root, stdout }), 0);
    const manifest = JSON.parse(stdout.value()) as {
      composition: readonly { readonly kind: string; readonly name: string }[];
      completeness: { readonly complete: boolean };
    };
    assert.equal(manifest.completeness.complete, true);
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "entrypoint" && name === "next-web"));
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "model" && name === "Project"));
    assert.ok(manifest.composition.some(({ kind, name }) => kind === "operation" && name === "createProject"));

    const checkOutput = stream();
    const checkErrors = stream();
    assert.equal(await runCli(["check", "--json"], {
      cwd: root,
      stdout: checkOutput,
      stderr: checkErrors,
      runCommand: () => 0,
    }), 0, checkErrors.value());
    const check = JSON.parse(checkOutput.value()) as { ok: boolean; executable: { complete: boolean } };
    assert.equal(check.ok, true);
    assert.equal(check.executable.complete, true);
  });
});

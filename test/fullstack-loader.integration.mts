import assert from "node:assert/strict";
import path from "node:path";
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

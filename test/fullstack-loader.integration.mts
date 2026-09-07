import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  it("uses registered definition symbols, never same-name decoys, for loaded composition sources", async () => {
    for (const supported of [true, false]) {
      const root = await mkdtemp(path.join(tmpdir(), "tor-registration-membership-"));
      try {
        for (const file of ["src", "test", "package.json", "tsconfig.json", "next-env.d.ts", "fullstack.config.mjs"]) {
          await cp(path.resolve("templates/fullstack", file), path.join(root, file), { recursive: true });
        }
        await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
        await mkdir(path.join(root, "src/features/alpha"));
        const definitions = (dynamic: boolean) => [
          'import { consumer, defineRepository, event, object, schedule } from "typescript-on-rails";',
          'export const Due = event({ owner: "alpha", name: "Due", payload: object({}) });',
          `export const target = consumer({ name: ${dynamic ? '["target"].join("")' : '"target"'}, event: Due, durable: true, handle: () => undefined });`,
          `export const records = defineRepository({ name: ${dynamic ? '["records"].join("")' : '"records"'}, feature: "alpha", relations: ["alpha.records"] });`,
          `export const daily = schedule({ name: ${dynamic ? '["daily"].join("")' : '"daily"'}, feature: "alpha", target, occurrences: () => [] });`,
        ].join("\n");
        await writeFile(path.join(root, "src/infra/shared.ts"), definitions(!supported));
        await writeFile(path.join(root, "src/infra/registered.ts"), 'export { target as selected, records, daily, Due } from "./shared.js";');
        await writeFile(path.join(root, "src/features/alpha/decoy.ts"), `${definitions(false)}\nimport { defineFeature } from "typescript-on-rails";\nconst unused = defineFeature({ name: "alpha", consumers: [target], repositories: [records], schedules: [daily] });`);
        await writeFile(path.join(root, "src/features/alpha/index.ts"), [
          'import { defineFeature } from "typescript-on-rails";',
          'import * as registered from "../../infra/registered.js";',
          'const selected = registered.selected;',
          'export const alpha = defineFeature({ name: "alpha", events: [registered.Due], consumers: [selected], repositories: [registered.records], schedules: [registered.daily] });',
        ].join("\n"));
        const appFile = path.join(root, "src/app-definition.ts");
        await writeFile(appFile, `import { alpha } from "./features/alpha/index.js";\n${(await readFile(appFile, "utf8")).replace("features: [statusFeature]", "features: [statusFeature, alpha]")}`);
        const stdout = stream();
        assert.equal(await runCli(["manifest", "--v3", "--json"], { cwd: root, stdout }), 0);
        const manifest = JSON.parse(stdout.value());
        for (const [kind, line] of [["consumer", 3], ["repository", 4], ["schedule", 5]] as const) {
          const record = manifest.composition.find((entry: { kind: string; owner: string }) => entry.kind === kind && entry.owner === "alpha");
          assert.deepEqual(record.detail.source, supported ? { file: "src/infra/shared.ts", line, provenance: "static-registration" } : undefined, `${kind}, supported=${supported}`);
          assert.equal(manifest.completeness.observations.some((entry: { kind: string }) => entry.kind === `${kind}-source`), !supported);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  });

  it("rejects substituted declared host handlers in real check JSON and retains public Next wrappers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-host-binding-"));
    try {
      for (const file of ["src", "test", "package.json", "tsconfig.json", "next-env.d.ts", "fullstack.config.mjs"]) {
        await cp(path.resolve("templates/fullstack", file), path.join(root, file), { recursive: true });
      }
      await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
      const cli = path.resolve("dist/bin.js");
      const check = () => spawnSync(process.execPath, [cli, "check", "--json"], { cwd: root, encoding: "utf8", timeout: 60_000 });
      const routeFile = path.join(root, "src/app/api/status/route.ts");
      await writeFile(routeFile, 'export { selected as GET } from "../../../infra/substitute.js";');
      const substituteFile = path.join(root, "src/infra/substitute.ts");
      const imports = [
        'import { nextRoute, nextRouteFor, nextRouteExports, nextRouteExportsFor } from "@typescript-on-rails/web/next";',
        'import { bindRoute } from "@typescript-on-rails/web";',
        'import { defineApp } from "typescript-on-rails";',
        'import { application } from "../app-definition.js";',
        'import { statusRoute } from "../features/status/index.js";',
        'import { statusHttpRoute } from "./http.js";',
      ].join("\n");
      for (const source of [
        'export function selected() { return new Response("bypass"); }',
        'const wrong = bindRoute(statusRoute, { scope: (_input, execute) => execute({ permissions: new Set<string>() }) }); export const selected = nextRoute(wrong);',
        'const wrong = defineApp({ features: [] }); export const selected = nextRouteFor(wrong.graph, "/api/status", "GET");',
        'export const selected = nextRouteFor(application.graph, "/api/other", "GET");',
        'const wrong = bindRoute(statusRoute, { scope: (_input, execute) => execute({ permissions: new Set<string>() }) }); export const { GET: selected } = nextRouteExports([statusHttpRoute, wrong]);',
      ]) {
        await writeFile(substituteFile, `${imports}\n${source}`);
        const result = check();
        assert.equal(result.status, 1, `${source}\n${result.stderr}`);
        const receipt = JSON.parse(result.stdout);
        assert.equal(receipt.ok, false);
        assert.equal(receipt.executable.complete, false);
        assert.ok(receipt.executable.unknowns.some((entry: { kind: string; reason: string }) => entry.kind === "route-export" && /GET.*registered web binding/.test(entry.reason)), JSON.stringify(receipt));
      }
      for (const source of [
        'const wrap = nextRouteFor; export const selected = wrap(application.graph, "/api/status", "GET");',
        'export const selected = nextRoute(statusHttpRoute);',
        'export const { GET: selected } = nextRouteExports([statusHttpRoute]);',
        'export const { GET: selected } = nextRouteExportsFor(application.graph, statusRoute.metadata.path);',
      ]) {
        await writeFile(substituteFile, `${imports}\n${source}`);
        const result = check();
        assert.equal(result.status, 0, `${source}\n${result.stdout}\n${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).executable.complete, true);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

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

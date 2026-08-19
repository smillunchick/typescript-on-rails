import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import { runCli, type CliDependencies, type CommandInvocation } from "../src/cli/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const cleanup: Array<() => Promise<void>> = [];

function git(cwd: string, args: readonly string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createBaseRef(root: string): void {
  const tsconfigBlob = git(root, ["hash-object", "-w", "tsconfig.json"]);
  const indexBlob = git(root, ["hash-object", "-w", "src/features/billing/index.ts"]);
  const billingTree = git(root, ["mktree"], `100644 blob ${indexBlob}\tindex.ts\n`);
  const featuresTree = git(root, ["mktree"], `040000 tree ${billingTree}\tbilling\n`);
  const srcTree = git(root, ["mktree"], `040000 tree ${featuresTree}\tfeatures\n`);
  const rootTree = git(root, ["mktree"], `040000 tree ${srcTree}\tsrc\n100644 blob ${tsconfigBlob}\ttsconfig.json\n`);
  const commit = git(root, ["commit-tree", rootTree, "-m", "base"]);
  git(root, ["update-ref", "refs/heads/main", commit]);
}
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

function capture() {
  let value = "";
  return {
    stream: { write(chunk: string) { value += chunk; } },
    value: () => value,
  };
}

async function invoke(args: readonly string[], cwd: string, overrides: Partial<CliDependencies> = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli(args, { cwd, stdout: stdout.stream, stderr: stderr.stream, ...overrides });
  return { code, stdout: stdout.value(), stderr: stderr.value() };
}

async function fixture(files: Readonly<Record<string, string>>): Promise<AppFixture> {
  const app = await createAppFixture(files);
  cleanup.push(() => app.cleanup());
  return app;
}

async function assertGeneratedTypechecks(root: string): Promise<void> {
  const configPath = path.join(root, "tsconfig.generated-test.json");
  await writeFile(configPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
      baseUrl: ".",
      typeRoots: [path.resolve("node_modules/@types")],
      paths: { "typescript-on-rails": [path.resolve("src/index.ts")] },
    },
    include: ["src/**/*.ts"],
  }));
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config as object, ts.sys, root, undefined, configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  assert.deepEqual(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, " ")), []);
}

describe("app CLI checks and lifecycle", () => {
  it("reports check success and failure, stable JSON, and optional tests", async () => {
    const healthy = await fixture({ "src/features/health/index.ts": "export const healthy = true;" });
    await writeFile(path.join(healthy.root, "package.json"), JSON.stringify({ scripts: { "test:app": "node --test" } }));
    const calls: CommandInvocation[] = [];
    const runCommand = async (invocation: CommandInvocation) => {
      calls.push(invocation);
      return 0;
    };

    const success = await invoke(["check", "--json", "--with-tests"], healthy.root, { runCommand });
    assert.equal(success.code, 0);
    assert.equal(success.stderr, "");
    assert.deepEqual(JSON.parse(success.stdout), { ok: true, diagnostics: [] });
    assert.deepEqual(calls, [{ command: "npm", args: ["run", "test:app"], cwd: healthy.root }]);

    const broken = await fixture({ "src/features/billing/model.ts": `export const count: number = "wrong";` });
    const failure = await invoke(["check"], broken.root);
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, "");
    assert.match(failure.stderr, /ARCH012/);
    assert.match(failure.stderr, /Create src\/features\/billing\/index\.ts/);
  });

  it("delegates lifecycle commands to explicit app-owned scripts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-cli-life-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const calls: CommandInvocation[] = [];
    const runCommand = async (invocation: CommandInvocation) => {
      calls.push(invocation);
      return invocation.args[1] === "build:app" ? 7 : 0;
    };

    assert.equal((await invoke(["dev"], root, { runCommand })).code, 0);
    assert.equal((await invoke(["build"], root, { runCommand })).code, 7);
    assert.equal((await invoke(["test"], root, { runCommand })).code, 0);
    assert.deepEqual(calls.map((entry) => entry.args), [["run", "dev:app"], ["run", "build:app"], ["run", "test:app"]]);
  });

  it("prints concise usage for unknown or invalid input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-cli-usage-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const unknown = await invoke(["wat"], root);
    const invalid = await invoke(["graph", "--json", "--dot"], root);
    assert.equal(unknown.code, 2);
    assert.equal(invalid.code, 2);
    assert.match(unknown.stderr, /^Usage: app /);
    assert.equal(unknown.stdout, "");
  });
});

describe("app CLI architecture views", () => {
  it("serves every view from analyzer manifest data in text or JSON", async () => {
    const app = await fixture({
      "src/features/billing/model.ts": `import { defineModel, id } from "typescript-on-rails"; export const Invoice = defineModel({ name: "Invoice", fields: { id: id("Invoice") } });`,
      "src/features/billing/actions.ts": `import { action, object, route } from "typescript-on-rails"; export const approveInvoice = action({ input: object({}), permission: "invoice.approve", run: () => true }); export const invoiceRoute = route({ method: "GET", path: "/invoices", permission: "invoice.read", handler: () => true });`,
      "src/features/billing/index.ts": `export { Invoice } from "./model.js"; export { approveInvoice, invoiceRoute } from "./actions.js";`,
      "src/features/reports/index.ts": `import { approveInvoice } from "@/features/billing"; export const approveForReport = approveInvoice;`,
    });

    const explain = await invoke(["explain", "billing", "--json"], app.root);
    assert.equal(explain.code, 0);
    assert.deepEqual(JSON.parse(explain.stdout).actions, ["approveInvoice"]);
    const route = await invoke(["explain", "/invoices", "--json"], app.root);
    assert.equal(JSON.parse(route.stdout).permission, "invoice.read");
    const graph = await invoke(["graph", "--dot"], app.root);
    assert.match(graph.stdout, /"reports" -> "billing"/);

    const commands = [
      ["graph", "--json"],
      ["owners", "--json"],
      ["boundaries", "--json"],
      ["exceptions", "--json"],
      ["impact", "approveInvoice", "--json"],
    ];
    for (const args of commands) {
      const result = await invoke(args, app.root);
      assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
    assert.deepEqual(JSON.parse((await invoke(["owners", "--json"], app.root)).stdout), [{ model: "Invoice", feature: "billing" }]);
    assert.deepEqual(JSON.parse((await invoke(["impact", "approveInvoice", "--json"], app.root)).stdout), { symbol: "approveInvoice", owner: "billing", callers: ["reports"] });
  });

  it("returns a not-found error for an unknown explanation target", async () => {
    const app = await fixture({ "src/features/health/index.ts": "export const healthy = true;" });
    const result = await invoke(["explain", "missing"], app.root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No feature or route named missing/);
  });
});

describe("app scaffold and generators", () => {
  it("creates a minimal strict application and refuses a nonempty target", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "tor-new-"));
    cleanup.push(() => rm(parent, { recursive: true, force: true }));
    const created = await invoke(["new", "shop"], parent);
    assert.equal(created.code, 0, created.stderr);
    const packageJson = JSON.parse(await readFile(path.join(parent, "shop", "package.json"), "utf8"));
    assert.equal(packageJson.dependencies["typescript-on-rails"], "^0.1.0");
    assert.deepEqual(Object.keys(packageJson.scripts).sort(), ["build:app", "dev:app", "test:app"]);
    assert.match(await readFile(path.join(parent, "shop", "tsconfig.json"), "utf8"), /NodeNext/);
    assert.match(await readFile(path.join(parent, "shop", "src", "app.ts"), "utf8"), /defineApp/);

    const refused = await invoke(["new", "shop"], parent);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not empty/);
  });

  it("creates focused idempotent feature artifacts and rejects unsafe names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-generate-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "src", "features"), { recursive: true });

    assert.equal((await invoke(["create", "feature", "billing"], root)).code, 0);
    assert.equal((await invoke(["create", "model", "InvoiceItem", "--feature", "billing"], root)).code, 0);
    assert.equal((await invoke(["create", "action", "approveInvoice", "--feature", "billing"], root)).code, 0);
    assert.equal((await invoke(["create", "query", "listInvoices", "--feature", "billing"], root)).code, 0);
    assert.equal((await invoke(["create", "action", "approveInvoice", "--feature", "billing"], root)).code, 0);

    const featureRoot = path.join(root, "src", "features", "billing");
    assert.match(await readFile(path.join(featureRoot, "invoice-item.ts"), "utf8"), /name: "InvoiceItem"/);
    const action = await readFile(path.join(featureRoot, "approve-invoice.ts"), "utf8");
    assert.match(action, /public: true/);
    assert.match(action, /Choose public, permission, or authorize/);
    const index = await readFile(path.join(featureRoot, "index.ts"), "utf8");
    assert.equal(index.match(/approveInvoice/g)?.length, 1);
    assert.match(index, /export \{ InvoiceItem \}/);
    assert.match(index, /export \{ listInvoices \}/);
    await assertGeneratedTypechecks(root);

    for (const unsafe of ["../escape", "bad/name", "bad name", "-flag"]) {
      const result = await invoke(["create", "feature", unsafe], root);
      assert.equal(result.code, 2, unsafe);
    }
  });
});

describe("app diff --architecture", () => {
  it("compares the working tree to HEAD through a read-only Git snapshot", async () => {
    const app = await fixture({
      "src/features/billing/index.ts": "export const invoice = true;\n",
    });
    git(app.root, ["init", "-b", "main"]);
    createBaseRef(app.root);
    await writeFile(path.join(app.root, "src", "features", "billing", "index.ts"), "export const invoice = true;\nexport const refundInvoice = true;\n");

    const result = await invoke(["diff", "--architecture", "--json"], app.root);
    assert.equal(result.code, 0, result.stderr);
    const diff = JSON.parse(result.stdout);
    assert.deepEqual(diff.publicApis.added, [{ feature: "billing", name: "refundInvoice", kind: "value" }]);
    assert.equal(diff.changed, true);

    const unsafe = await invoke(["diff", "--architecture", "--base", "--upload-pack=bad"], app.root);
    assert.equal(unsafe.code, 2);
    assert.match(unsafe.stderr, /Invalid Git ref/);
  });
});

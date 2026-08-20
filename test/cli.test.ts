import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import { analyzeApplication } from "../src/features/architecture/index.js";
import { runCli, type CliDependencies, type CommandInvocation } from "../src/features/tooling/index.js";
import {
  createApplication,
  createGitArchitectureDiff,
  type ApplicationScaffoldFileSystem,
} from "../src/infra/project/index.js";
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

describe("shipped product positioning", () => {
  it("describes the current architecture kernel and its explicit limits", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    const readme = await readFile(path.resolve("README.md"), "utf8");
    const vision = await readFile(path.resolve(".docs/agent-native-typescript-framework-architecture.md"), "utf8");

    assert.equal(
      packageJson.description,
      "An agent-native TypeScript application architecture kernel and compiler with runtime contract primitives.",
    );
    for (const documentation of [readme, vision]) {
      assert.match(documentation, /application architecture kernel/i);
      assert.match(documentation, /HTTP serving/);
      assert.match(documentation, /rendered UI/);
      assert.match(documentation, /persistence/);
      assert.match(documentation, /storage/);
      assert.match(documentation, /bundling/);
      assert.match(documentation, /no-emit TypeScript checks are not application builds/i);
    }
  });
});

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

    const failedTests = await invoke(["check", "--json", "--with-tests"], healthy.root, {
      runCommand: async () => 9,
    });
    assert.equal(failedTests.code, 9);
    assert.equal(failedTests.stderr, "Application tests failed with exit code 9.\n");
    assert.deepEqual(JSON.parse(failedTests.stdout), {
      ok: false,
      diagnostics: [],
      tests: { ok: false, exitCode: 9 },
    });

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
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        "dev:app": "node dev.js",
        "build:app": "node build.js",
        "test:app": "node test.js",
      },
    }));
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

  it("reports a missing app-owned lifecycle before launching npm", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-cli-missing-life-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    const calls: CommandInvocation[] = [];

    const result = await invoke(["dev"], root, {
      runCommand: async (invocation) => {
        calls.push(invocation);
        return 0;
      },
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Missing app-owned script \"dev:app\". The architecture kernel does not supply the dev lifecycle.\n",
    );
    assert.deepEqual(calls, []);
  });

  it("prints concise, truthful usage for unknown or invalid input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tor-cli-usage-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const unknown = await invoke(["wat"], root);
    const invalid = await invoke(["graph", "--json", "--dot"], root);
    assert.equal(unknown.code, 2);
    assert.equal(invalid.code, 2);
    assert.match(unknown.stderr, /^Usage: app /);
    assert.match(unknown.stderr, /application architecture kernel and compiler with runtime contract primitives/i);
    assert.match(unknown.stderr, /Does not provide HTTP serving, rendered UI, persistence or storage, or bundling\./);
    assert.match(unknown.stderr, /No-emit TypeScript checks are not application builds\./);
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
    assert.deepEqual(packageJson.scripts, {
      check: "app check",
      typecheck: "tsc -p tsconfig.json",
    });
    assert.equal(packageJson.devDependencies.typescript, "5.9.3");
    assert.equal(packageJson.devDependencies.tsx, undefined);
    assert.equal(packageJson.dependencies.tsx, undefined);
    assert.match(await readFile(path.join(parent, "shop", "tsconfig.json"), "utf8"), /NodeNext/);
    assert.match(await readFile(path.join(parent, "shop", "src", "app.ts"), "utf8"), /defineApp/);

    const refused = await invoke(["new", "shop"], parent);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /not empty/);
  });

  it("rolls back failed application creation and permits a retry", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "tor-new-rollback-"));
    cleanup.push(() => rm(parent, { recursive: true, force: true }));

    const failOnSecondFile = (): ApplicationScaffoldFileSystem => {
      let fileCount = 0;
      return {
        createDirectory: async (directory) => { await mkdir(directory, { recursive: true }); },
        createFile: async (file, content) => {
          fileCount += 1;
          await writeFile(file, content, { flag: "wx" });
          if (fileCount === 2) throw new Error("injected scaffold write failure");
        },
        removePath: async (target, recursive) => { await rm(target, { recursive, force: true }); },
      };
    };

    await assert.rejects(
      createApplication(parent, "created-root", failOnSecondFile()),
      /injected scaffold write failure/,
    );
    await assert.rejects(access(path.join(parent, "created-root")), /ENOENT/);
    await createApplication(parent, "created-root");

    const existingRoot = path.join(parent, "existing-root");
    await mkdir(existingRoot);
    await assert.rejects(
      createApplication(parent, "existing-root", failOnSecondFile()),
      /injected scaffold write failure/,
    );
    assert.deepEqual(await readdir(existingRoot), []);
    await createApplication(parent, "existing-root");
    assert.deepEqual((await readdir(existingRoot)).sort(), ["package.json", "src", "tsconfig.json"]);

    const doubleFailureFileSystem: ApplicationScaffoldFileSystem = {
      createDirectory: async (directory) => { await mkdir(directory, { recursive: true }); },
      createFile: async () => { throw new Error("injected write failure"); },
      removePath: async () => { throw new Error("injected rollback failure"); },
    };
    await assert.rejects(
      createApplication(parent, "rollback-fails", doubleFailureFileSystem),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0]?.message, "injected write failure");
        assert.equal(error.errors[1]?.message, "injected rollback failure");
        return true;
      },
    );

    const reported = await invoke(["new", "rollback-fails"], parent, {
      createApplication: async () => {
        throw new AggregateError(
          [new Error("injected write failure"), new Error("injected rollback failure")],
          "Application scaffold failed and rollback was incomplete: rollback-fails",
        );
      },
    });
    assert.equal(reported.code, 1);
    assert.equal(reported.stdout, "");
    assert.equal(
      reported.stderr,
      "Application scaffold failed and rollback was incomplete: rollback-fails\n"
        + "injected write failure\n"
        + "injected rollback failure\n",
    );
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

    const boundaryBeforeInvalidNames = await readFile(path.join(featureRoot, "index.ts"), "utf8");
    for (const invalidName of ["123-report", "delete", "Class", "await"]) {
      const result = await invoke(["create", "action", invalidName, "--feature", "billing"], root);
      assert.equal(result.code, 2, invalidName);
      assert.match(result.stderr, /Invalid generated identifier/);
    }
    assert.equal(await readFile(path.join(featureRoot, "index.ts"), "utf8"), boundaryBeforeInvalidNames);

    const actionCollision = await invoke(["create", "action", "sendInvoice", "--feature", "billing"], root);
    assert.equal(actionCollision.code, 0, actionCollision.stderr);
    const boundaryBeforeCollision = await readFile(path.join(featureRoot, "index.ts"), "utf8");
    const queryCollision = await invoke(["create", "query", "send-invoice", "--feature", "billing"], root);
    assert.equal(queryCollision.code, 1);
    assert.match(queryCollision.stderr, /Generated file collision/);
    assert.equal(await readFile(path.join(featureRoot, "index.ts"), "utf8"), boundaryBeforeCollision);
    assert.match(await readFile(path.join(featureRoot, "send-invoice.ts"), "utf8"), /action\(/);
  });
});

describe("app diff --architecture", () => {
  it("materializes many files exactly through one Git object reader", async () => {
    const app = await fixture({
      "src/features/billing/index.ts": "export const invoice = true;\n",
    });
    const assets = path.join(app.root, "assets");
    await mkdir(assets);
    const exactBytes = Buffer.from([0, 10, 13, 127, 128, 255]);
    await writeFile(path.join(assets, "exact.bin"), exactBytes);
    for (let index = 0; index < 24; index += 1) {
      await writeFile(path.join(assets, `file-${String(index)}.txt`), `content ${String(index)}\n`);
    }
    git(app.root, ["init", "-b", "main"]);
    git(app.root, ["add", "."]);
    git(app.root, ["commit", "-m", "snapshot"]);

    const traceRoot = await mkdtemp(path.join(tmpdir(), "tor-git-trace-"));
    cleanup.push(() => rm(traceRoot, { recursive: true, force: true }));
    const traceFile = path.join(traceRoot, "events.json");
    const priorTrace = process.env.GIT_TRACE2_EVENT;
    process.env.GIT_TRACE2_EVENT = traceFile;
    let inspectedSnapshot = false;
    try {
      await createGitArchitectureDiff(app.root, "HEAD", (root) => {
        if (root !== app.root) {
          inspectedSnapshot = true;
          assert.deepEqual(readFileSync(path.join(root, "assets", "exact.bin")), exactBytes);
        }
        return analyzeApplication(root);
      });
    } finally {
      if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
      else process.env.GIT_TRACE2_EVENT = priorTrace;
    }
    assert.equal(inspectedSnapshot, true);

    const starts = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly event?: string; readonly argv?: readonly string[] })
      .filter((entry) => entry.event === "start")
      .map((entry) => entry.argv ?? []);
    assert.equal(starts.filter((args) => args.includes("cat-file") && args.includes("--batch")).length, 1);
    assert.equal(starts.filter((args) => args.includes("show")).length, 0);
  });

  it("closes the object reader for missing, non-blob, and Git error responses", { timeout: 10_000 }, async () => {
    const missingRoot = await mkdtemp(path.join(tmpdir(), "tor-git-missing-"));
    cleanup.push(() => rm(missingRoot, { recursive: true, force: true }));
    await writeFile(path.join(missingRoot, "missing.txt"), "missing blob\n");
    git(missingRoot, ["init", "-b", "main"]);
    git(missingRoot, ["add", "."]);
    git(missingRoot, ["commit", "-m", "missing"]);
    const missingObject = git(missingRoot, ["rev-parse", "HEAD:missing.txt"]);
    await rm(path.join(missingRoot, ".git", "objects", missingObject.slice(0, 2), missingObject.slice(2)));
    await assert.rejects(createGitArchitectureDiff(missingRoot), /Missing Git object/);

    const nonBlobRoot = await mkdtemp(path.join(tmpdir(), "tor-git-nonblob-"));
    cleanup.push(() => rm(nonBlobRoot, { recursive: true, force: true }));
    git(nonBlobRoot, ["init", "-b", "main"]);
    const nestedTree = git(nonBlobRoot, ["mktree"], "");
    const nestedCommit = git(nonBlobRoot, ["commit-tree", nestedTree, "-m", "nested"]);
    const rootTree = git(nonBlobRoot, ["mktree"], `160000 commit ${nestedCommit}\tsubmodule\n`);
    const rootCommit = git(nonBlobRoot, ["commit-tree", rootTree, "-m", "root"]);
    git(nonBlobRoot, ["update-ref", "refs/heads/main", rootCommit]);
    await assert.rejects(
      createGitArchitectureDiff(nonBlobRoot),
      /Unsupported Git object type commit at submodule/,
    );

    await assert.rejects(
      createGitArchitectureDiff(nonBlobRoot, "missing-ref"),
      /not a valid object name|Not a valid object name|fatal:/,
    );
  });

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

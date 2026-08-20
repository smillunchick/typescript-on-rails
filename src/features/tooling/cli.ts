import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  analyzeApplication,
  formatArchitectureDiagnostic,
  type ArchitectureManifest,
} from "../architecture/index.js";
import {
  formatArchitectureDiff,
  formatFeatureExplanation,
  formatRouteExplanation,
  graphAsDot,
  graphAsText,
  inspectApplication,
  type ApplicationInspector,
  type ArchitectureDiff,
} from "../introspection/index.js";
import {
  createAction,
  createApplication,
  createFeature,
  createGitArchitectureDiff,
  createModel,
  createQuery,
  runProjectCommand,
  validateGitRef,
  type GenerationResult,
} from "../../infra/project/index.js";

export interface CliStream {
  write(chunk: string): unknown;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<number> | number;

export interface CliDependencies {
  readonly cwd?: string;
  readonly stdout?: CliStream;
  readonly stderr?: CliStream;
  readonly runCommand?: CommandRunner;
  readonly analyze?: (root: string) => ArchitectureManifest;
  readonly inspect?: (root: string) => ApplicationInspector;
  readonly architectureDiff?: (root: string, ref: string) => Promise<ArchitectureDiff>;
  readonly createApplication?: (
    cwd: string,
    target: string,
  ) => Promise<{ readonly created: readonly string[]; readonly unchanged: readonly string[] }>;
}

const usage = `Usage: app <command> [options]

TypeScript application architecture kernel and compiler with runtime contract primitives.
Does not provide HTTP serving, rendered UI, persistence or storage, or bundling.
No-emit TypeScript checks are not application builds.

Commands:
  new <directory>
  dev | build | test
  check [--json] [--with-tests]
  create feature <name>
  create model|action|query <name> --feature <feature>
  explain <feature-or-route> [--json]
  graph [--json | --dot]
  owners|boundaries|exceptions [--json]
  impact <public-symbol> [--json]
  diff --architecture [--base <git-ref>] [--json]
`;

class CliUsageError extends Error {}

function json(stream: CliStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function oneFlag(args: readonly string[], flag: string): boolean {
  const count = args.filter((entry) => entry === flag).length;
  if (count > 1) throw new CliUsageError(`Duplicate option: ${flag}`);
  return count === 1;
}

function onlyFlags(args: readonly string[], allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const invalid = args.find((entry) => !allowedSet.has(entry));
  if (invalid !== undefined) throw new CliUsageError(`Unknown option: ${invalid}`);
}

function formatList(values: readonly unknown[]): string {
  if (values.length === 0) return "none\n";
  return `${values.map((entry) => {
    if (typeof entry === "string") return entry;
    return JSON.stringify(entry);
  }).join("\n")}\n`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

async function hasAppOwnedScript(cwd: string, script: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path.join(cwd, "package.json"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  const packageJson: unknown = JSON.parse(source);
  if (!isRecord(packageJson)) return false;
  const scripts = packageJson["scripts"];
  return isRecord(scripts) && typeof scripts[script] === "string";
}

async function lifecycle(
  command: "dev" | "build" | "test",
  cwd: string,
  stderr: CliStream,
  runCommand: CommandRunner,
): Promise<number> {
  const script = `${command}:app`;
  if (!(await hasAppOwnedScript(cwd, script))) {
    stderr.write(`Missing app-owned script "${script}". The architecture kernel does not supply the ${command} lifecycle.\n`);
    return 1;
  }
  return runCommand({ command: "npm", args: ["run", script], cwd });
}

async function runCheck(
  args: readonly string[],
  cwd: string,
  stdout: CliStream,
  stderr: CliStream,
  analyze: (root: string) => ArchitectureManifest,
  runCommand: CommandRunner,
): Promise<number> {
  onlyFlags(args, ["--json", "--with-tests"]);
  const asJson = oneFlag(args, "--json");
  const withTests = oneFlag(args, "--with-tests");
  const manifest = analyze(cwd);
  const errors = manifest.diagnostics.filter((entry) => entry.severity === "error");
  for (const entry of manifest.diagnostics) stderr.write(`${formatArchitectureDiagnostic(entry)}\n`);
  if (errors.length > 0) {
    if (asJson) json(stdout, { ok: false, diagnostics: manifest.diagnostics });
    return 1;
  }
  if (withTests) {
    const testCode = await runCommand({ command: "npm", args: ["run", "test:app"], cwd });
    if (testCode !== 0) {
      stderr.write(`Application tests failed with exit code ${String(testCode)}.\n`);
      if (asJson) json(stdout, { ok: false, diagnostics: [], tests: { ok: false, exitCode: testCode } });
      return testCode;
    }
  }
  if (asJson) json(stdout, { ok: true, diagnostics: [] });
  else stdout.write("app check passed.\n");
  return 0;
}

function renderGeneration(stdout: CliStream, result: GenerationResult): void {
  for (const file of result.created) stdout.write(`created ${file}\n`);
  for (const file of result.unchanged) stdout.write(`unchanged ${file}\n`);
}

function parseFeatureOption(args: readonly string[]): { readonly name: string; readonly feature: string } {
  if (args.length !== 3 || args[1] !== "--feature" || args[2] === undefined || args[0] === undefined) {
    throw new CliUsageError("Expected <name> --feature <feature>");
  }
  return { name: args[0], feature: args[2] };
}

async function runCreate(args: readonly string[], cwd: string, stdout: CliStream): Promise<number> {
  const kind = args[0];
  if (kind === "feature") {
    if (args.length !== 2 || args[1] === undefined) throw new CliUsageError("Expected create feature <name>");
    renderGeneration(stdout, await createFeature(cwd, args[1]));
    return 0;
  }
  if (kind !== "model" && kind !== "action" && kind !== "query") throw new CliUsageError("Unknown generator");
  const parsed = parseFeatureOption(args.slice(1));
  const result = kind === "model"
    ? await createModel(cwd, parsed.name, parsed.feature)
    : kind === "action"
      ? await createAction(cwd, parsed.name, parsed.feature)
      : await createQuery(cwd, parsed.name, parsed.feature);
  renderGeneration(stdout, result);
  return 0;
}

function runExplain(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream, stderr: CliStream): number {
  const target = args[0];
  if (target === undefined) throw new CliUsageError("Expected a feature or route");
  onlyFlags(args.slice(1), ["--json"]);
  const asJson = oneFlag(args.slice(1), "--json");
  const route = inspector.explainRoute(target);
  const feature = inspector.explainFeature(target);
  const explanation = route ?? feature;
  if (explanation === null) {
    stderr.write(`No feature or route named ${target}.\n`);
    return 1;
  }
  if (asJson) json(stdout, explanation);
  else if (route !== null) stdout.write(formatRouteExplanation(route));
  else if (feature !== null) stdout.write(formatFeatureExplanation(feature));
  return 0;
}

function runGraph(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream): number {
  onlyFlags(args, ["--json", "--dot"]);
  const asJson = oneFlag(args, "--json");
  const asDot = oneFlag(args, "--dot");
  if (asJson && asDot) throw new CliUsageError("Choose either --json or --dot");
  if (asJson) json(stdout, { features: inspector.features().map((entry) => entry.name), dependencies: inspector.dependencies() });
  else stdout.write(asDot ? graphAsDot(inspector.manifest) : graphAsText(inspector.manifest));
  return 0;
}

function runProjection(
  command: "owners" | "boundaries" | "exceptions",
  args: readonly string[],
  inspector: ApplicationInspector,
  stdout: CliStream,
): number {
  onlyFlags(args, ["--json"]);
  const values = command === "owners"
    ? inspector.owners()
    : command === "boundaries"
      ? inspector.boundaries()
      : inspector.exceptions();
  if (oneFlag(args, "--json")) json(stdout, values);
  else stdout.write(formatList(values));
  return 0;
}

function runImpact(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream): number {
  const symbol = args[0];
  if (symbol === undefined) throw new CliUsageError("Expected a public symbol");
  onlyFlags(args.slice(1), ["--json"]);
  const impact = inspector.impact(symbol);
  if (oneFlag(args.slice(1), "--json")) json(stdout, impact);
  else stdout.write(`${symbol}\nOwner: ${impact.owner ?? "none"}\nCallers: ${impact.callers.length === 0 ? "none" : impact.callers.join(", ")}\n`);
  return 0;
}

function parseDiff(args: readonly string[]): { readonly base: string; readonly asJson: boolean } {
  if (args[0] !== "--architecture") throw new CliUsageError("Expected diff --architecture");
  let base = "HEAD";
  let asJson = false;
  for (let index = 1; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--json") {
      if (asJson) throw new CliUsageError("Duplicate option: --json");
      asJson = true;
    } else if (entry === "--base") {
      const value = args[index + 1];
      if (value === undefined) throw new CliUsageError("Expected a Git ref after --base");
      base = value;
      index += 1;
    } else throw new CliUsageError(`Unknown option: ${String(entry)}`);
  }
  try {
    validateGitRef(base);
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : "Invalid Git ref");
  }
  return { base, asJson };
}

function isUsageFailure(error: unknown): boolean {
  if (error instanceof CliUsageError) return true;
  return error instanceof Error
    && (error.message.startsWith("Invalid name:")
      || error.message.startsWith("Invalid generated identifier")
      || error.message.startsWith("Invalid target directory:")
      || error.message.startsWith("Invalid feature name:"));
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof AggregateError)) return message;
  return [message, ...error.errors.map(formatCliError)].join("\n");
}

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const runCommand = dependencies.runCommand ?? runProjectCommand;
  const analyze = dependencies.analyze ?? analyzeApplication;
  const inspect = dependencies.inspect ?? inspectApplication;
  const architectureDiff = dependencies.architectureDiff ?? createGitArchitectureDiff;
  const scaffoldApplication = dependencies.createApplication ?? createApplication;
  try {
    const command = args[0];
    const rest = args.slice(1);
    if (command === undefined) throw new CliUsageError("Missing command");
    if (command === "new") {
      if (rest.length !== 1 || rest[0] === undefined) throw new CliUsageError("Expected new <directory>");
      renderGeneration(stdout, await scaffoldApplication(cwd, rest[0]));
      return 0;
    }
    if (command === "dev" || command === "build" || command === "test") {
      if (rest.length !== 0) throw new CliUsageError(`Unexpected arguments for ${command}`);
      return await lifecycle(command, cwd, stderr, runCommand);
    }
    if (command === "check") return await runCheck(rest, cwd, stdout, stderr, analyze, runCommand);
    if (command === "create") return await runCreate(rest, cwd, stdout);
    if (command === "explain") return runExplain(rest, inspect(cwd), stdout, stderr);
    if (command === "graph") return runGraph(rest, inspect(cwd), stdout);
    if (command === "owners" || command === "boundaries" || command === "exceptions") {
      return runProjection(command, rest, inspect(cwd), stdout);
    }
    if (command === "impact") return runImpact(rest, inspect(cwd), stdout);
    if (command === "diff") {
      const parsed = parseDiff(rest);
      const diff = await architectureDiff(cwd, parsed.base);
      if (parsed.asJson) json(stdout, diff);
      else stdout.write(formatArchitectureDiff(diff));
      return 0;
    }
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (isUsageFailure(error)) {
      stderr.write(`${usage}${error instanceof Error ? `\n${error.message}\n` : ""}`);
      return 2;
    }
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

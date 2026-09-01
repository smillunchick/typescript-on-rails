import { architecture } from "../runtime/index.js";
import {
  analyzeApplication,
  analyzeApplicationV3,
  formatArchitectureDiagnostic,
  type AnalyzeApplicationV3Options,
  type ArchitectureManifest,
  type ArchitectureManifestV3,
} from "../architecture/index.js";
import {
  assertManifestV2,
  formatArchitectureDiff,
  formatFeatureExplanation,
  formatRouteExplanation,
  graphAsDot,
  graphAsText,
  inspectApplication,
  ManifestCompatibilityError,
  type ApplicationInspector,
  type ArchitectureDiff,
  type ResolvedSemanticSelector,
  type SemanticSelectorFailure,
} from "../introspection/index.js";
import {
  createAction,
  createApplication,
  createFeature,
  createGitArchitectureDiff,
  GitArchitectureDiffCompatibilityError,
  createModel,
  createQuery,
  hasAppOwnedScript,
  hasFullStackLifecycle,
  loadFullStackApplication,
  resolveFullStackLifecycleBin,
  runProjectCommand,
  validateGitRef,
  type GenerationResult,
} from "../../infra/project/index.js";

architecture.allow({
  rule: "feature-infrastructure-boundary",
  reason: "The tooling feature owns CLI behavior while project process and filesystem access remain infrastructure.",
});

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
  readonly resolveFullStackLifecycle?: (root: string) => string;
  readonly loadFullStackApplication?: (
    root: string,
  ) => Promise<AnalyzeApplicationV3Options["application"] | undefined>;
  readonly analyze?: (root: string) => ArchitectureManifest;
  readonly inspect?: (root: string) => ApplicationInspector;
  readonly architectureDiff?: (root: string, ref: string) => Promise<ArchitectureDiff>;
  readonly createApplication?: (
    cwd: string,
    target: string,
  ) => Promise<{ readonly created: readonly string[]; readonly unchanged: readonly string[] }>;
}

const usage = `Usage: app <command> [options]

Agent-native full-stack TypeScript framework with a small architecture compiler core.
Official modular packages provide web, PostgreSQL, durable work, lifecycle, and test runtimes.
Core-only applications keep the legacy lifecycle delegation path.

Commands:
  new <directory>
  dev | build | test | migrate | worker | scheduler | seed
  check [--json] [--with-tests]
  create feature <name>
  create model|action|query <name> --feature <feature>
  explain <semantic-record> [--json]
  graph [--json | --dot]
  owners|boundaries|exceptions [--json]
  impact <public-symbol> [--json]
  diff --architecture [--base <git-ref>] [--json]
  manifest --v3 [--json]
  brief <feature> [--json]
  trace <operation-or-route> [--json]
  tests-for <feature-or-operation> [--json]
  unknowns [--json]
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

type LifecycleCommand = "dev" | "build" | "test" | "check" | "migrate" | "worker" | "scheduler" | "seed";

async function lifecycle(
  command: LifecycleCommand,
  cwd: string,
  stderr: CliStream,
  runCommand: CommandRunner,
  resolveLifecycle: (root: string) => string,
): Promise<number> {
  if (await hasFullStackLifecycle(cwd)) {
    return runCommand({
      command: process.execPath,
      args: [resolveLifecycle(cwd), command],
      cwd,
    });
  }
  const script = `${command}:app`;
  if (!(await hasAppOwnedScript(cwd, script))) {
    stderr.write(`Missing full-stack lifecycle or legacy app-owned script "${script}" for ${command}.\n`);
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
  resolveLifecycle: (root: string) => string,
): Promise<number> {
  onlyFlags(args, ["--json", "--with-tests"]);
  const asJson = oneFlag(args, "--json");
  const withTests = oneFlag(args, "--with-tests");
  const manifest = analyze(cwd);
  assertManifestV2(manifest);
  const errors = manifest.diagnostics.filter((entry) => entry.severity === "error");
  for (const entry of manifest.diagnostics) stderr.write(`${formatArchitectureDiagnostic(entry)}\n`);
  if (errors.length > 0) {
    if (asJson) json(stdout, { ok: false, diagnostics: manifest.diagnostics });
    return 1;
  }
  if (await hasFullStackLifecycle(cwd)) {
    const fullStackCode = await lifecycle("check", cwd, stderr, runCommand, resolveLifecycle);
    if (fullStackCode !== 0) {
      if (asJson) json(stdout, { ok: false, diagnostics: [], fullStack: { ok: false, exitCode: fullStackCode } });
      return fullStackCode;
    }
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

function formatSelectorFailure(noun: string, result: SemanticSelectorFailure): string {
  if (result.status === "not-found") return `No ${noun} matches selector ${result.selector}.\n`;
  return [
    `Ambiguous ${noun} selector ${result.selector}. Candidate semantic IDs:`,
    ...result.candidates.map((candidate) => `  ${candidate.id} (${candidate.category}, ${candidate.displayName})`),
  ].join("\n") + "\n";
}

function formatResolvedRecord(result: ResolvedSemanticSelector): string {
  return [
    result.candidate.displayName,
    `Semantic ID: ${result.candidate.id}`,
    `Category: ${result.candidate.category}`,
    JSON.stringify(result.value, null, 2),
  ].join("\n") + "\n";
}

function runExplain(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream, stderr: CliStream): number {
  const target = args[0];
  if (target === undefined) throw new CliUsageError("Expected a semantic record");
  onlyFlags(args.slice(1), ["--json"]);
  const asJson = oneFlag(args.slice(1), "--json");
  const selected = inspector.resolve(target);
  if (selected.status !== "resolved") {
    stderr.write(formatSelectorFailure("semantic record", selected));
    if (asJson) json(stdout, selected);
    return 1;
  }
  if (selected.candidate.category === "route") {
    const explanation = inspector.explainRoute(selected.candidate.id);
    if (explanation.status !== "resolved") {
      stderr.write(formatSelectorFailure("semantic record", explanation));
      if (asJson) json(stdout, explanation);
      return 1;
    }
    if (asJson) json(stdout, explanation);
    else stdout.write(formatRouteExplanation(explanation.value));
    return 0;
  }
  if (selected.candidate.category === "feature") {
    const explanation = inspector.explainFeature(selected.candidate.id);
    if (explanation.status !== "resolved") {
      stderr.write(formatSelectorFailure("semantic record", explanation));
      if (asJson) json(stdout, explanation);
      return 1;
    }
    if (asJson) json(stdout, explanation);
    else stdout.write(formatFeatureExplanation(explanation.value));
    return 0;
  }
  if (asJson) json(stdout, selected);
  else stdout.write(formatResolvedRecord(selected));
  return 0;
}

function runGraph(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream): number {
  onlyFlags(args, ["--json", "--dot"]);
  const asJson = oneFlag(args, "--json");
  const asDot = oneFlag(args, "--dot");
  if (asJson && asDot) throw new CliUsageError("Choose either --json or --dot");
  if (asJson) json(stdout, { features: inspector.features().map((entry) => ({ id: entry.id, displayName: entry.name, name: entry.name })), dependencies: inspector.dependencies() });
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

function runImpact(args: readonly string[], inspector: ApplicationInspector, stdout: CliStream, stderr: CliStream): number {
  const symbol = args[0];
  if (symbol === undefined) throw new CliUsageError("Expected a public symbol");
  onlyFlags(args.slice(1), ["--json"]);
  const asJson = oneFlag(args.slice(1), "--json");
  const impact = inspector.impact(symbol);
  if (impact.status !== "resolved") {
    stderr.write(formatSelectorFailure("public export", impact));
    if (asJson) json(stdout, impact);
    return 1;
  }
  if (asJson) json(stdout, impact);
  else {
    const callers = impact.value.callers.map((caller, index) => {
      const callerId = impact.value.callerIds[index];
      return callerId === undefined ? caller : `${caller} [${callerId}]`;
    });
    stdout.write(`${impact.value.displayName}\nSemantic ID: ${impact.value.id}\nOwner: ${impact.value.owner} [${impact.value.ownerId}]\nCallers: ${callers.length === 0 ? "none" : callers.join(", ")}\n`);
  }
  return 0;
}

async function v3Manifest(
  cwd: string,
  loadApplication: (
    root: string,
  ) => Promise<AnalyzeApplicationV3Options["application"] | undefined>,
): Promise<ArchitectureManifestV3> {
  const application = await loadApplication(cwd);
  return analyzeApplicationV3(cwd, application === undefined ? {} : { application });
}

async function renderV3Projection(
  command: "manifest" | "brief" | "trace" | "tests-for" | "unknowns",
  args: readonly string[],
  cwd: string,
  stdout: CliStream,
  loadApplication: (
    root: string,
  ) => Promise<AnalyzeApplicationV3Options["application"] | undefined>,
): Promise<number> {
  const manifest = await v3Manifest(cwd, loadApplication);
  const asJson = args.includes("--json");
  if (command === "manifest") {
    onlyFlags(args, ["--v3", "--json"]);
    if (!args.includes("--v3")) throw new CliUsageError("Expected manifest --v3");
    json(stdout, manifest);
    return 0;
  }
  const positional = args.filter((entry) => entry !== "--json");
  if (command === "unknowns") {
    if (positional.length > 0) throw new CliUsageError("unknowns accepts only --json");
    const values = manifest.completeness.observations.filter(({ category }) => category !== "declared");
    if (asJson) json(stdout, { completeness: manifest.completeness, unknowns: values });
    else stdout.write(formatList(values));
    return 0;
  }
  const selector = positional[0];
  if (selector === undefined || positional.length !== 1) throw new CliUsageError(`Expected ${command} <selector>`);
  if (command === "brief") {
    const features = manifest.base.features.filter(({ name }) => name === selector);
    const composition = manifest.composition.filter(({ owner, name }) => owner === selector || name === selector);
    const dependencies = manifest.base.dependencies.filter(({ from, to }) => from === selector || to === selector);
    const value = { selector, features, composition, dependencies, completeness: manifest.completeness, sourceBodiesIncluded: false, contextBenefitClaim: false };
    if (asJson) json(stdout, value); else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return features.length > 0 || composition.length > 0 ? 0 : 1;
  }
  if (command === "tests-for") {
    const owners = new Set(manifest.composition.filter(({ owner, name }) => owner === selector || name === selector).map(({ owner }) => owner));
    if (manifest.base.features.some(({ name }) => name === selector)) owners.add(selector);
    const tests = manifest.composition.filter(({ kind, owner }) => kind === "test" && owners.has(owner)).map(({ name }) => name).sort();
    if (asJson) json(stdout, { selector, tests, completeness: manifest.completeness }); else stdout.write(formatList(tests));
    return 0;
  }
  const records = [
    ...manifest.base.operations.filter(({ name }) => name === selector),
    ...manifest.base.routes.filter(({ name, path }) => name === selector || path === selector),
  ];
  const owners = new Set(records.map(({ feature }) => feature).filter((feature): feature is string => feature !== null));
  const value = { selector, records, dependencies: manifest.base.dependencies.filter(({ from, to }) => owners.has(from) || owners.has(to)), completeness: manifest.completeness, runtimeTraceAvailable: false };
  if (asJson) json(stdout, value); else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return records.length > 0 ? 0 : 1;
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

function compatibilityError(error: unknown): { readonly name: string; readonly code: string; readonly message: string } | null {
  return error instanceof ManifestCompatibilityError || error instanceof GitArchitectureDiffCompatibilityError
    ? { name: error.name, code: error.code, message: error.message }
    : null;
}

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const runCommand = dependencies.runCommand ?? runProjectCommand;
  const resolveLifecycle = dependencies.resolveFullStackLifecycle ?? resolveFullStackLifecycleBin;
  const loadApplication =
    dependencies.loadFullStackApplication ??
    (async (root: string) =>
      (await hasFullStackLifecycle(root)) ? loadFullStackApplication(root) : undefined);
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
    if (command === "dev" || command === "build" || command === "test" || command === "migrate" || command === "worker" || command === "scheduler" || command === "seed") {
      if (rest.length !== 0) throw new CliUsageError(`Unexpected arguments for ${command}`);
      return await lifecycle(command, cwd, stderr, runCommand, resolveLifecycle);
    }
    if (command === "check") return await runCheck(rest, cwd, stdout, stderr, analyze, runCommand, resolveLifecycle);
    if (command === "create") return await runCreate(rest, cwd, stdout);
    if (command === "explain") return runExplain(rest, inspect(cwd), stdout, stderr);
    if (command === "graph") return runGraph(rest, inspect(cwd), stdout);
    if (command === "owners" || command === "boundaries" || command === "exceptions") {
      return runProjection(command, rest, inspect(cwd), stdout);
    }
    if (command === "impact") return runImpact(rest, inspect(cwd), stdout, stderr);
    if (command === "diff") {
      const parsed = parseDiff(rest);
      const diff = await architectureDiff(cwd, parsed.base);
      if (parsed.asJson) json(stdout, diff);
      else stdout.write(formatArchitectureDiff(diff));
      return 0;
    }
    if (command === "manifest" || command === "brief" || command === "trace" || command === "tests-for" || command === "unknowns") {
      return await renderV3Projection(command, rest, cwd, stdout, loadApplication);
    }
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (isUsageFailure(error)) {
      stderr.write(`${usage}${error instanceof Error ? `\n${error.message}\n` : ""}`);
      return 2;
    }
    const typedError = compatibilityError(error);
    if (typedError !== null && args.includes("--json")) json(stdout, { ok: false, error: typedError });
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

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
  createArchitectureBrief,
  createArchitectureCheckReceipt,
  createArchitectureTests,
  createArchitectureTrace,
  createArchitectureUnknowns,
  executableArchitectureSummary,
  formatArchitectureDiff,
  formatFeatureExplanation,
  formatRouteExplanation,
  graphAsDot,
  graphAsText,
  inspectApplication,
  ManifestCompatibilityError,
  resolveArchitectureSelector,
  type ApplicationInspector,
  type AmbiguousArchitectureSelector,
  type ArchitectureDiff,
  type MissingArchitectureSelector,
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
  inspectFullStackApplication,
  recoverProjectEdit,
  resolveFullStackLifecycleBin,
  runProjectCommand,
  validateGitRef,
  type ApplicationProfile,
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
  readonly stdio?: "inherit" | "stderr";
  readonly signal?: AbortSignal;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<number> | number;

export interface CliDependencies {
  readonly cwd?: string;
  readonly stdout?: CliStream;
  readonly stderr?: CliStream;
  readonly signal?: AbortSignal;
  readonly runCommand?: CommandRunner;
  readonly resolveFullStackLifecycle?: (root: string) => string;
  readonly loadFullStackApplication?: (
    root: string,
  ) => Promise<AnalyzeApplicationV3Options["application"] | undefined>;
  readonly inspectFullStackApplication?: (
    root: string,
    signal?: AbortSignal,
  ) => Promise<ArchitectureManifestV3>;
  readonly analyze?: (root: string) => ArchitectureManifest;
  readonly inspect?: (root: string) => ApplicationInspector;
  readonly architectureDiff?: (root: string, ref: string) => Promise<ArchitectureDiff>;
  readonly createApplication?: (
    cwd: string,
    target: string,
    profile?: ApplicationProfile,
  ) => Promise<{ readonly created: readonly string[]; readonly updated: readonly string[]; readonly unchanged: readonly string[] }>;
  readonly validateGeneratedApplication?: (root: string) => Promise<void>;
}

const usage = `Usage: app <command> [options]

Agent-native full-stack TypeScript framework with a small architecture compiler core.
Official modular packages provide web, PostgreSQL, durable work, lifecycle, and test runtimes.
Core-only applications keep the legacy lifecycle delegation path.

Commands:
  new <directory> [--core | --example projects]
  dev | build | test | migrate | worker | scheduler | seed
  recover
  check [--json] [--with-tests]
  create feature <name>
  create model <name> --feature <feature>
  create action|query <name> --feature <feature> (--public | --permission <permission>)
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
  stdio: "inherit" | "stderr" = "inherit",
  signal?: AbortSignal,
): Promise<number> {
  if (await hasFullStackLifecycle(cwd)) {
    return runCommand({
      command: process.execPath,
      args: [resolveLifecycle(cwd), command],
      cwd,
      ...(stdio === "inherit" ? {} : { stdio }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  const script = `${command}:app`;
  if (!(await hasAppOwnedScript(cwd, script))) {
    stderr.write(`Missing full-stack lifecycle or legacy app-owned script "${script}" for ${command}.\n`);
    return 1;
  }
  return runCommand({ command: "npm", args: ["run", script], cwd, ...(stdio === "inherit" ? {} : { stdio }), ...(signal === undefined ? {} : { signal }) });
}

async function runCheck(
  args: readonly string[],
  cwd: string,
  stdout: CliStream,
  stderr: CliStream,
  analyze: (root: string) => ArchitectureManifest,
  runCommand: CommandRunner,
  resolveLifecycle: (root: string) => string,
  analyzeV3: (root: string, signal?: AbortSignal) => Promise<ArchitectureManifestV3>,
  signal?: AbortSignal,
): Promise<number> {
  onlyFlags(args, ["--json", "--with-tests"]);
  const asJson = oneFlag(args, "--json");
  const withTests = oneFlag(args, "--with-tests");
  const manifest = analyze(cwd);
  assertManifestV2(manifest);
  let executable: ReturnType<typeof executableArchitectureSummary> | undefined;
  let lifecycleOutcome: { readonly ok: boolean; readonly exitCode: number } | undefined;
  let testsOutcome: { readonly ok: boolean; readonly exitCode: number } | undefined;
  const receipt = (cancelled = false) => createArchitectureCheckReceipt({
    diagnostics: manifest.diagnostics,
    ...(executable === undefined ? {} : { executable }),
    ...(lifecycleOutcome === undefined ? {} : { lifecycle: lifecycleOutcome }),
    ...(testsOutcome === undefined ? {} : { tests: testsOutcome }),
    ...(cancelled ? { cancelled: true } : {}),
  });
  const cancelled = (): boolean => {
    if (signal?.aborted !== true) return false;
    stderr.write("Command cancelled.\n");
    if (asJson) json(stdout, receipt(true));
    return true;
  };
  if (cancelled()) return 130;
  const errors = manifest.diagnostics.filter((entry) => entry.severity === "error");
  for (const entry of manifest.diagnostics) stderr.write(`${formatArchitectureDiagnostic(entry)}\n`);
  if (errors.length > 0) {
    if (asJson) json(stdout, receipt());
    return 1;
  }
  const fullStack = await hasFullStackLifecycle(cwd);
  if (fullStack) {
    let manifestV3: ArchitectureManifestV3;
    try {
      manifestV3 = await analyzeV3(cwd, signal);
    } catch (error) {
      if (cancelled()) return 130;
      throw error;
    }
    executable = executableArchitectureSummary(manifestV3);
    if (!executable.complete) {
      stderr.write("Manifest v3 executable graph is incomplete.\n");
      for (const unknown of executable.unknowns) stderr.write(`${unknown.kind}: ${unknown.name} — ${unknown.reason}\n`);
      if (asJson) json(stdout, receipt());
      return 1;
    }
    const exitCode = await lifecycle("check", cwd, stderr, runCommand, resolveLifecycle, asJson ? "stderr" : "inherit", signal);
    if (cancelled()) return 130;
    lifecycleOutcome = Object.freeze({ ok: exitCode === 0, exitCode });
    if (exitCode !== 0) {
      if (asJson) json(stdout, receipt());
      return exitCode;
    }
  }
  if (withTests) {
    const exitCode = fullStack
      ? await lifecycle("test", cwd, stderr, runCommand, resolveLifecycle, asJson ? "stderr" : "inherit", signal)
      : await runCommand({ command: "npm", args: ["run", "test:app"], cwd, ...(asJson ? { stdio: "stderr" as const } : {}), ...(signal === undefined ? {} : { signal }) });
    if (cancelled()) return 130;
    testsOutcome = Object.freeze({ ok: exitCode === 0, exitCode });
    if (exitCode !== 0) {
      stderr.write(`Application tests failed with exit code ${String(exitCode)}.\n`);
      if (asJson) json(stdout, receipt());
      return exitCode;
    }
  }
  if (cancelled()) return 130;
  if (asJson) json(stdout, receipt());
  else stdout.write("app check passed.\n");
  return 0;
}

function parseNew(args: readonly string[]): { readonly target: string; readonly profile: ApplicationProfile } {
  const target = args[0];
  if (target === undefined) throw new CliUsageError("Expected new <directory> [--core | --example projects]");
  if (args.length === 1) return { target, profile: "fullstack" };
  if (args.length === 2 && args[1] === "--core") return { target, profile: "core" };
  if (args.length === 3 && args[1] === "--example" && args[2] === "projects") return { target, profile: "projects-example" };
  throw new CliUsageError("Expected new <directory> [--core | --example projects]");
}

function renderGeneration(stdout: CliStream, result: GenerationResult): void {
  for (const file of result.created) stdout.write(`created ${file}\n`);
  for (const file of result.updated) stdout.write(`updated ${file}\n`);
  for (const file of result.unchanged) stdout.write(`unchanged ${file}\n`);
}

function parseFeatureOption(args: readonly string[]): { readonly name: string; readonly feature: string } {
  if (args.length !== 3 || args[1] !== "--feature" || args[2] === undefined || args[0] === undefined) {
    throw new CliUsageError("Expected <name> --feature <feature>");
  }
  return { name: args[0], feature: args[2] };
}

function parseOperationOptions(args: readonly string[]): {
  readonly name: string;
  readonly feature: string;
  readonly access: { readonly public: true } | { readonly permission: string };
} {
  const name = args[0];
  if (name === undefined) throw new CliUsageError("Expected <name> --feature <feature> (--public | --permission <permission>)");
  let feature: string | undefined;
  let access: { readonly public: true } | { readonly permission: string } | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--feature") {
      const value = args[index + 1];
      if (feature !== undefined || value === undefined) throw new CliUsageError("Expected one --feature <feature>");
      feature = value;
      index += 1;
    } else if (option === "--public") {
      if (access !== undefined) throw new CliUsageError("Choose exactly one of --public or --permission <permission>");
      access = { public: true };
    } else if (option === "--permission") {
      const value = args[index + 1];
      if (access !== undefined || value === undefined) throw new CliUsageError("Choose exactly one of --public or --permission <permission>");
      access = { permission: value };
      index += 1;
    } else {
      throw new CliUsageError(`Unknown option: ${String(option)}`);
    }
  }
  if (feature === undefined || access === undefined) throw new CliUsageError("Expected <name> --feature <feature> (--public | --permission <permission>)");
  return { name, feature, access };
}

async function runCreate(
  args: readonly string[],
  cwd: string,
  stdout: CliStream,
  validate: (root: string) => Promise<void>,
): Promise<number> {
  const kind = args[0];
  if (kind === "feature") {
    if (args.length !== 2 || args[1] === undefined) throw new CliUsageError("Expected create feature <name>");
    renderGeneration(stdout, await createFeature(cwd, args[1], { validate }));
    return 0;
  }
  if (kind !== "model" && kind !== "action" && kind !== "query") throw new CliUsageError("Unknown generator");
  if (kind === "model") {
    const parsed = parseFeatureOption(args.slice(1));
    renderGeneration(stdout, await createModel(cwd, parsed.name, parsed.feature, { validate }));
    return 0;
  }
  const parsed = parseOperationOptions(args.slice(1));
  const result = kind === "action"
    ? await createAction(cwd, parsed.name, parsed.feature, parsed.access, { validate })
    : await createQuery(cwd, parsed.name, parsed.feature, parsed.access, { validate });
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
  analyzeV3: (root: string, signal?: AbortSignal) => Promise<ArchitectureManifestV3>,
  signal?: AbortSignal,
): Promise<ArchitectureManifestV3> {
  return analyzeV3(cwd, signal);
}

function formatArchitectureProjectionFailure(
  result: AmbiguousArchitectureSelector | MissingArchitectureSelector,
): string {
  if (result.status === "not-found") return `No architecture record matches selector ${result.selector}.\n`;
  return [
    `Ambiguous architecture selector ${result.selector}. Candidates:`,
    ...result.candidates.map((entry) => `  ${entry.qualifiedSelector} (${entry.displayName})`),
  ].join("\n") + "\n";
}

async function renderV3Projection(
  command: "manifest" | "brief" | "trace" | "tests-for" | "unknowns",
  args: readonly string[],
  cwd: string,
  stdout: CliStream,
  stderr: CliStream,
  analyzeV3: (root: string, signal?: AbortSignal) => Promise<ArchitectureManifestV3>,
  signal?: AbortSignal,
): Promise<number> {
  if (command === "manifest") {
    onlyFlags(args, ["--v3", "--json"]);
    if (!args.includes("--v3")) throw new CliUsageError("Expected manifest --v3");
    oneFlag(args, "--json");
    json(stdout, await v3Manifest(cwd, analyzeV3, signal));
    return 0;
  }
  const invalidOption = args.find((entry) => entry.startsWith("--") && entry !== "--json");
  if (invalidOption !== undefined) throw new CliUsageError(`Unknown option: ${invalidOption}`);
  const asJson = oneFlag(args, "--json");
  const positional = args.filter((entry) => entry !== "--json");
  if (command === "unknowns" && positional.length > 0) throw new CliUsageError("unknowns accepts only --json");
  if (command !== "unknowns" && (positional[0] === undefined || positional.length !== 1)) throw new CliUsageError(`Expected ${command} <selector>`);
  const manifest = await v3Manifest(cwd, analyzeV3, signal);
  if (command === "unknowns") {
    const report = createArchitectureUnknowns(manifest);
    if (asJson) json(stdout, report); else stdout.write(formatList(report.unknowns));
    return 0;
  }
  const selector = positional[0];
  if (selector === undefined) throw new CliUsageError(`Expected ${command} <selector>`);
  const selected = resolveArchitectureSelector(manifest, selector);
  if (selected.status !== "resolved") {
    stderr.write(formatArchitectureProjectionFailure(selected));
    if (asJson) json(stdout, selected);
    return 1;
  }
  if (command === "brief") {
    const report = createArchitectureBrief(manifest, selected);
    if (asJson) json(stdout, report); else stdout.write(`${report.records.map(({ kind, owner, name }) => `${kind} ${owner}.${name}`).join("\n")}\n`);
    return report.records.length > 0 ? 0 : 1;
  }
  if (command === "tests-for") {
    const report = createArchitectureTests(manifest, selected, { kind: "completeness" });
    if (asJson) json(stdout, report);
    else stdout.write(formatList(report.tests.map(({ file, verification }) => `${file} (${verification})`)));
    return report.tests.some(({ verification }) => verification === "missing") ? 1 : 0;
  }
  const report = createArchitectureTrace(manifest, selected);
  if (asJson) json(stdout, report);
  else stdout.write(formatList(report.links.map(({ kind, from, to }) => `${kind}: ${from} -> ${to}`)));
  return report.records.length > 0 ? 0 : 1;
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
      || error.message.startsWith("Invalid generated permission")
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
  const signal = dependencies.signal;
  const runCommand = dependencies.runCommand ?? runProjectCommand;
  const resolveLifecycle = dependencies.resolveFullStackLifecycle ?? resolveFullStackLifecycleBin;
  const analyzeV3 = dependencies.inspectFullStackApplication ?? (async (root: string, childSignal?: AbortSignal) => {
    if (dependencies.loadFullStackApplication !== undefined) {
      const application = await dependencies.loadFullStackApplication(root);
      return analyzeApplicationV3(root, application === undefined ? {} : { application });
    }
    return (await hasFullStackLifecycle(root))
      ? inspectFullStackApplication(root, childSignal === undefined ? {} : { signal: childSignal })
      : analyzeApplicationV3(root);
  });
  const analyze = dependencies.analyze ?? analyzeApplication;
  const validateGeneratedApplication = dependencies.validateGeneratedApplication ?? (async (root: string) => {
    const manifest = analyze(root);
    assertManifestV2(manifest);
    const errors = manifest.diagnostics.filter(({ severity }) => severity === "error");
    if (errors.length > 0) throw new Error(`Generated application failed Manifest v2 validation: ${errors.map(({ code }) => code).join(", ")}`);
    if (await hasFullStackLifecycle(root)) {
      const manifestV3 = await analyzeV3(root, signal);
      const executable = executableArchitectureSummary(manifestV3);
      if (!executable.complete) {
        throw new Error(`Generated application failed Manifest v3 validation: ${executable.unknowns.map(({ kind, name }) => `${kind}:${name}`).join(", ")}`);
      }
    }
  });
  const inspect = dependencies.inspect ?? inspectApplication;
  const architectureDiff = dependencies.architectureDiff ?? createGitArchitectureDiff;
  const scaffoldApplication = dependencies.createApplication ?? createApplication;
  try {
    const command = args[0];
    const rest = args.slice(1);
    if (command === undefined) throw new CliUsageError("Missing command");
    if (command === "new") {
      const parsed = parseNew(rest);
      renderGeneration(stdout, await scaffoldApplication(cwd, parsed.target, parsed.profile));
      return 0;
    }
    if (command === "recover") {
      if (rest.length !== 0) throw new CliUsageError("recover accepts no arguments");
      await recoverProjectEdit(cwd);
      stdout.write("recovered project edit\n");
      return 0;
    }
    if (command === "dev" || command === "build" || command === "test" || command === "migrate" || command === "worker" || command === "scheduler" || command === "seed") {
      if (rest.length !== 0) throw new CliUsageError(`Unexpected arguments for ${command}`);
      const code = await lifecycle(command, cwd, stderr, runCommand, resolveLifecycle, "inherit", signal);
      return signal?.aborted === true ? 130 : code;
    }
    if (command === "check") return await runCheck(rest, cwd, stdout, stderr, analyze, runCommand, resolveLifecycle, analyzeV3, signal);
    if (command === "create") return await runCreate(rest, cwd, stdout, validateGeneratedApplication);
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
      return await renderV3Projection(command, rest, cwd, stdout, stderr, analyzeV3, signal);
    }
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    const asJson = args.includes("--json");
    if (isUsageFailure(error)) {
      if (asJson) json(stdout, { ok: false, error: { name: "CliUsageError", code: "INVALID_USAGE", message: error instanceof Error ? error.message : "Invalid command usage" } });
      stderr.write(`${usage}${error instanceof Error ? `\n${error.message}\n` : ""}`);
      return 2;
    }
    const typedError = compatibilityError(error);
    if (asJson) json(stdout, {
      ok: false,
      error: typedError ?? {
        name: error instanceof Error ? error.name : "Error",
        code: "COMMAND_FAILED",
        message: formatCliError(error),
      },
    });
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
}

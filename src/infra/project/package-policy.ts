import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import type { PackageCapability } from "../../features/runtime/index.js";

export const FRAMEWORK_PACKAGE = "typescript-on-rails";
export const PRECOMPUTED_PACKAGE_POLICY = Symbol("typescript-on-rails.precomputed-package-policy");
export const PACKAGE_POLICY_RULE = "package-policy";
const CAPABILITIES = new Set<string>([
  "pure",
  "ui",
  "external-system",
  "host-io",
]);
const HOST_IO_NODE_MODULES = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "process",
  "readline",
  "readline/promises",
  "repl",
  "sqlite",
  "tls",
  "trace_events",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);
const NODE_PREFIX_ONLY_MODULES = new Set(
  builtinModules.filter((name) => name.startsWith("node:")).map((name) => name.slice("node:".length)),
);
const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const PACKAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PackagePolicyEntry {
  readonly package: string;
  readonly capability: PackageCapability;
}

export interface PackagePolicyIssue {
  readonly kind:
    | "missing-package-json"
    | "malformed-package-json"
    | "missing-policy"
    | "malformed-policy"
    | "invalid-key"
    | "invalid-capability"
    | "conflicting-key"
    | "framework-capability"
    | "removed-option"
    | "fact-conflict"
    | "version-mismatch"
    | "invalid-official-metadata";
  readonly message: string;
  readonly key?: string;
}

export type PackageRuntimeLocation = "universal" | "browser" | "server" | "build";
export type PackageEffect = "none" | "filesystem" | "network" | "process" | "database" | "external-system";
export type PackageNondeterminism = "none" | "clock" | "random" | "environment" | "external" | "unknown";
export type PackageCapabilityProvenance = "official" | "override" | "declared-v2" | "migrated-v1";
export type PackageCapabilitySource = "official-package" | "application-v1" | "application-v2" | "options-v1" | "options-v2";

export interface PackageCapabilityV2Input {
  readonly version: 2;
  readonly package: string;
  readonly packageVersion: string;
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
  readonly provenance?: PackageCapabilityProvenance;
  readonly inheritedFrom?: string;
}

export interface PackageCapabilityCatalogEntry extends PackagePolicyEntry {
  readonly packageVersion: string;
  readonly versionSource: "installed" | "lockfile" | "installed+lockfile" | "node-runtime" | "unresolved";
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
  readonly provenance: PackageCapabilityProvenance;
  readonly source: PackageCapabilitySource;
  readonly officialOwner?: string;
}

export interface PackageCapabilityCatalog {
  readonly entries: readonly PackageCapabilityCatalogEntry[];
  readonly blockedPackages: readonly string[];
  readonly issues: readonly PackagePolicyIssue[];
}

export interface SelectedPackagePolicy {
  readonly entries: readonly PackagePolicyEntry[];
  readonly blockedPackages: readonly string[];
  readonly issues: readonly PackagePolicyIssue[];
  readonly source: "options" | "package.json";
  readonly derivedFromOfficialMetadata: boolean;
  readonly catalog: PackageCapabilityCatalog;
}

export interface RuntimePackageIdentity {
  readonly exact: string;
  readonly root: string;
  readonly framework: boolean;
  readonly nodeCapability?: PackageCapability;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPackageCapability(value: unknown): value is PackageCapability {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) return false;
  return value === "pure"
    || value === "ui"
    || value === "external-system"
    || value === "host-io";
}

function bareNodeModule(specifier: string): string | null {
  const prefixed = specifier.startsWith("node:");
  const bare = prefixed ? specifier.slice("node:".length) : specifier;
  if (!NODE_MODULES.has(bare) || (!prefixed && NODE_PREFIX_ONLY_MODULES.has(bare))) return null;
  return bare;
}

export function frameworkNodeCapability(specifier: string): PackageCapability | null {
  const bare = bareNodeModule(specifier);
  if (bare === null) return null;
  return HOST_IO_NODE_MODULES.has(bare) ? "host-io" : "pure";
}

export function normalizePackagePolicyKey(key: string): string | null {
  if (key.length === 0 || key !== key.trim() || key.includes("\\") || key.includes("?") || key.includes("#")) {
    return null;
  }
  const nodeModule = bareNodeModule(key);
  if (nodeModule !== null) return `node:${nodeModule}`;
  if (key.startsWith("node:") || key.startsWith(".") || key.startsWith("/") || key.endsWith("/")) return null;
  const segments = key.split("/");
  if (key.startsWith("@")) {
    const scope = segments[0]?.slice(1);
    const name = segments[1];
    if (scope === undefined || name === undefined || !PACKAGE_SEGMENT.test(scope) || !PACKAGE_SEGMENT.test(name)) {
      return null;
    }
    return segments.slice(2).every((segment) => PACKAGE_SEGMENT.test(segment)) ? key : null;
  }
  return segments.every((segment) => PACKAGE_SEGMENT.test(segment)) ? key : null;
}

function packageRoot(normalized: string): string {
  if (normalized.startsWith("node:")) return normalized;
  const segments = normalized.split("/");
  return normalized.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0] ?? normalized;
}

export function runtimePackageIdentity(specifier: string): RuntimePackageIdentity | null {
  const exact = normalizePackagePolicyKey(specifier);
  if (exact === null) return null;
  const nodeCapability = frameworkNodeCapability(exact);
  const root = packageRoot(exact);
  return {
    exact,
    root,
    framework: root === FRAMEWORK_PACKAGE,
    ...(nodeCapability === null ? {} : { nodeCapability }),
  };
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function readPolicyFile(root: string): { readonly value?: unknown; readonly issues: readonly PackagePolicyIssue[] } {
  const packageFile = path.join(root, "package.json");
  let source: string;
  try {
    source = readFileSync(packageFile, "utf8");
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    return {
      issues: [{
        kind: missing ? "missing-package-json" : "malformed-package-json",
        message: missing
          ? "Package capability policy source is missing: root package.json was not found"
          : "Package capability policy source could not be read: root package.json is not readable",
      }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {
      issues: [{
        kind: "malformed-package-json",
        message: "Package capability policy source is malformed: root package.json is not valid JSON",
      }],
    };
  }
  if (!isRecord(parsed)) {
    return {
      issues: [{
        kind: "malformed-package-json",
        message: "Package capability policy source is malformed: root package.json must contain a JSON object",
      }],
    };
  }
  if (!hasOwn(parsed, "typescriptOnRails")) {
    return {
      issues: [{
        kind: "missing-policy",
        message: "Package capability policy is missing: add typescriptOnRails.packageCapabilities to root package.json",
      }],
    };
  }
  const configuration = parsed.typescriptOnRails;
  if (!isRecord(configuration)) {
    return {
      issues: [{
        kind: "malformed-policy",
        message: "Package capability policy is malformed: typescriptOnRails must be an object",
      }],
    };
  }
  if (!hasOwn(configuration, "packageCapabilities")) {
    return {
      issues: [{
        kind: "missing-policy",
        message: "Package capability policy is missing: add typescriptOnRails.packageCapabilities to root package.json",
      }],
    };
  }
  return { value: configuration.packageCapabilities, issues: [] };
}

interface ValidatedPackagePolicy {
  readonly entries: readonly PackagePolicyEntry[];
  readonly blockedPackages: readonly string[];
  readonly issues: readonly PackagePolicyIssue[];
}

function validatePolicy(value: unknown): ValidatedPackagePolicy {
  if (!isRecord(value)) {
    return {
      entries: [],
      blockedPackages: [],
      issues: [{
        kind: "malformed-policy",
        message: "Package capability policy is malformed: packageCapabilities must be an object",
      }],
    };
  }

  const issues: PackagePolicyIssue[] = [];
  const blockedPackages = new Set<string>();
  const submitted = new Map<string, Array<{ readonly sourceKey: string; readonly capability: PackageCapability }>>();
  for (const [sourceKey, capabilityValue] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
    const normalized = normalizePackagePolicyKey(sourceKey);
    if (normalized === null) {
      issues.push({
        kind: "invalid-key",
        key: sourceKey,
        message: `Invalid package capability key ${JSON.stringify(sourceKey)}: use an exact package root or subpath`,
      });
      continue;
    }
    if (packageRoot(normalized) === FRAMEWORK_PACKAGE) {
      issues.push({
        kind: "invalid-key",
        key: sourceKey,
        message: `Invalid package capability key ${JSON.stringify(sourceKey)}: ${FRAMEWORK_PACKAGE} and its subpaths are framework-exempt`,
      });
      continue;
    }
    if (!isPackageCapability(capabilityValue)) {
      blockedPackages.add(normalized);
      issues.push({
        kind: "invalid-capability",
        key: sourceKey,
        message: `Invalid capability for ${JSON.stringify(sourceKey)}: expected pure, ui, external-system, or host-io`,
      });
      continue;
    }
    const values = submitted.get(normalized) ?? [];
    values.push({ sourceKey, capability: capabilityValue });
    submitted.set(normalized, values);
  }

  const entries: PackagePolicyEntry[] = [];
  for (const [normalized, values] of [...submitted].sort(([left], [right]) => compareText(left, right))) {
    const capabilities = [...new Set(values.map((entry) => entry.capability))];
    if (capabilities.length > 1) {
      blockedPackages.add(normalized);
      issues.push({
        kind: "conflicting-key",
        key: normalized,
        message: `Conflicting package capability keys normalize to ${JSON.stringify(normalized)}: ${values.map((entry) => JSON.stringify(entry.sourceKey)).join(", ")}`,
      });
      continue;
    }
    const capability = capabilities[0];
    if (capability === undefined || blockedPackages.has(normalized)) continue;
    const nodeCapability = frameworkNodeCapability(normalized);
    if (nodeCapability !== null && nodeCapability !== capability) {
      blockedPackages.add(normalized);
      issues.push({
        kind: "framework-capability",
        key: normalized,
        message: `Package policy cannot classify framework-owned ${normalized} as ${capability}; its capability is ${nodeCapability}`,
      });
      continue;
    }
    entries.push({ package: normalized, capability });
  }
  issues.sort((left, right) => compareText(left.key ?? "", right.key ?? "") || compareText(left.kind, right.kind));
  return {
    entries,
    blockedPackages: [...blockedPackages].sort(compareText),
    issues,
  };
}

type ExplicitPackagePolicy = Omit<SelectedPackagePolicy, "catalog" | "derivedFromOfficialMetadata">;

function selectExplicitPackagePolicy(root: string, options: unknown): ExplicitPackagePolicy {
  const optionRecord = isRecord(options) ? options : {};
  const issues: PackagePolicyIssue[] = [];
  if (hasOwn(optionRecord, "allowedExternalPackages")) {
    issues.push({
      kind: "removed-option",
      message: "AnalyzeApplicationOptions.allowedExternalPackages was removed. Migrate to packageCapabilities with explicit pure, ui, external-system, or host-io values",
    });
  }

  const fromOptions = hasOwn(optionRecord, "packageCapabilities");
  const selected = fromOptions
    ? { value: optionRecord.packageCapabilities, issues: [] }
    : readPolicyFile(root);
  const validated = selected.value === undefined && selected.issues.length > 0
    ? { entries: [], blockedPackages: [], issues: selected.issues }
    : validatePolicy(selected.value);
  return {
    entries: validated.entries,
    blockedPackages: validated.blockedPackages,
    issues: [...issues, ...validated.issues],
    source: fromOptions ? "options" : "package.json",
  };
}

interface DescriptiveFacts {
  readonly runtime: readonly PackageRuntimeLocation[];
  readonly effects: readonly PackageEffect[];
  readonly nondeterminism: readonly PackageNondeterminism[];
}

interface OfficialFact extends DescriptiveFacts {
  readonly package: string;
  readonly capability: PackageCapability;
  readonly owner: string;
}

interface InstalledPackage {
  readonly version: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly packageJsonPath: string;
}

export const OFFICIAL_PACKAGE_PREFIX = "@typescript-on-rails/";
const OFFICIAL_SUPPORTED_ROOTS = new Set(["typescript-on-rails", "typescript", "next", "react", "react-dom", "kysely", "pg", "tsx"]);

function rootPackageJson(root: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function workspacePatterns(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return isRecord(value) && Array.isArray(value.packages)
    ? value.packages.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function workspacePatternMatches(pattern: string, relative: string): boolean {
  const expression = pattern
    .split("/")
    .map((segment) => segment === "**" ? ".*" : segment === "*" ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^${expression}$`).test(relative);
}

function resolutionBoundary(root: string): string {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  while (true) {
    try {
      statSync(path.join(current, ".git"));
      return current;
    } catch {
      // A Git root is one explicit trust boundary.
    }
    const packageJson = rootPackageJson(current);
    const relative = path.relative(current, resolvedRoot).split(path.sep).join("/");
    if (relative !== "" && workspacePatterns(packageJson?.workspaces).some((pattern) => workspacePatternMatches(pattern, relative))) {
      try {
        statSync(path.join(current, "package-lock.json"));
        return current;
      } catch {
        // A workspace without its lockfile cannot authenticate a hoisted install.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return resolvedRoot;
    current = parent;
  }
}

function installedPackage(root: string, boundary: string, packageName: string): InstalledPackage | undefined {
  if (packageName.startsWith("node:")) return { version: process.versions.node, value: {}, packageJsonPath: "node:runtime" };
  let current = path.resolve(root);
  while (true) {
    for (const packageFile of [
      path.join(current, "node_modules", ...packageName.split("/"), "package.json"),
      path.join(current, "package.json"),
    ]) {
      try {
        const value: unknown = JSON.parse(readFileSync(packageFile, "utf8"));
        if (isRecord(value) && value.name === packageName && typeof value.version === "string" && value.version.trim() !== "") {
          return { version: value.version, value, packageJsonPath: packageFile };
        }
      } catch {
        // Continue through Node's package-resolution search path.
      }
    }
    if (current === boundary) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

interface ResolvedPackageLock {
  readonly directory: string;
  readonly packages: Readonly<Record<string, unknown>>;
}

function nearestPackageLock(root: string, boundary: string): ResolvedPackageLock | undefined {
  let current = path.resolve(root);
  while (true) {
    try {
      const value: unknown = JSON.parse(readFileSync(path.join(current, "package-lock.json"), "utf8"));
      if (isRecord(value) && typeof value.lockfileVersion === "number" && value.lockfileVersion >= 2 && isRecord(value.packages)) {
        return { directory: current, packages: value.packages };
      }
    } catch {
      // A lockfile is optional. Installed metadata remains authoritative when absent.
    }
    if (current === boundary) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function lockedPackageVersion(
  lock: ResolvedPackageLock | undefined,
  packageName: string,
  installedPackageJsonPath?: string,
): string | undefined {
  if (lock === undefined) return undefined;
  if (installedPackageJsonPath !== undefined && installedPackageJsonPath !== "node:runtime") {
    const exactKey = path.relative(lock.directory, path.dirname(installedPackageJsonPath)).split(path.sep).join("/");
    const exact = lock.packages[exactKey];
    if (isRecord(exact) && typeof exact.version === "string") return exact.version;
  }
  const suffix = `node_modules/${packageName}`;
  const candidates = Object.entries(lock.packages)
    .filter(([key, value]) => (key === suffix || key.endsWith(`/${suffix}`)) && isRecord(value) && typeof value.version === "string")
    .sort(([left], [right]) => left.length - right.length || compareText(left, right));
  const selected = candidates[0]?.[1];
  return isRecord(selected) && typeof selected.version === "string" ? selected.version : undefined;
}

function normalizedValues<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function runtimeLocation(value: unknown): value is PackageRuntimeLocation {
  return value === "universal" || value === "browser" || value === "server" || value === "build";
}

function packageEffect(value: unknown): value is PackageEffect {
  return value === "none" || value === "filesystem" || value === "network" || value === "process" || value === "database" || value === "external-system";
}

function packageNondeterminism(value: unknown): value is PackageNondeterminism {
  return value === "none" || value === "clock" || value === "random" || value === "environment" || value === "external" || value === "unknown";
}

function descriptiveFacts(value: Readonly<Record<string, unknown>>): DescriptiveFacts | undefined {
  if (
    !Array.isArray(value.runtime) || !value.runtime.every(runtimeLocation)
    || !Array.isArray(value.effects) || !value.effects.every(packageEffect)
    || !Array.isArray(value.nondeterminism) || !value.nondeterminism.every(packageNondeterminism)
  ) return undefined;
  return Object.freeze({
    runtime: normalizedValues(value.runtime),
    effects: normalizedValues(value.effects),
    nondeterminism: normalizedValues(value.nondeterminism),
  });
}

function factsFromCapability(packageName: string, capability: PackageCapability): DescriptiveFacts {
  switch (capability) {
    case "ui": return { runtime: ["browser"], effects: ["none"], nondeterminism: ["unknown"] };
    case "external-system": return { runtime: ["server"], effects: ["external-system", "network"], nondeterminism: ["external"] };
    case "host-io": return { runtime: ["build", "server"], effects: ["filesystem", "network", "process"], nondeterminism: ["environment", "unknown"] };
    case "pure": return { runtime: ["universal"], effects: ["none"], nondeterminism: packageName === "node:os" || packageName === "node:perf_hooks" ? ["clock", "environment"] : ["none"] };
  }
}

function sameFacts(left: DescriptiveFacts, right: DescriptiveFacts): boolean {
  return JSON.stringify(left.runtime) === JSON.stringify(right.runtime)
    && JSON.stringify(left.effects) === JSON.stringify(right.effects)
    && JSON.stringify(left.nondeterminism) === JSON.stringify(right.nondeterminism);
}

function officialFacts(
  root: string,
  boundary: string,
  issues: PackagePolicyIssue[],
  blocked: Set<string>,
  installedCache: Map<string, InstalledPackage | undefined>,
): ReadonlyMap<string, OfficialFact> {
  const application = rootPackageJson(root);
  const candidates = new Set<string>();
  for (const property of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const values = application?.[property];
    if (!isRecord(values)) continue;
    for (const name of Object.keys(values)) if (name === FRAMEWORK_PACKAGE || name.startsWith(OFFICIAL_PACKAGE_PREFIX)) candidates.add(name);
  }
  const facts = new Map<string, OfficialFact>();
  for (const owner of [...candidates].sort(compareText)) {
    const installed = installedCache.has(owner)
      ? installedCache.get(owner)
      : installedPackage(root, boundary, owner);
    installedCache.set(owner, installed);
    const configuration = installed?.value.typescriptOnRails;
    if (configuration === undefined) continue;
    if (!isRecord(configuration) || configuration.packageFactsVersion !== 1 || !Array.isArray(configuration.packageFacts)) {
      issues.push({ kind: "invalid-official-metadata", key: owner, message: `Invalid official package metadata for ${owner}` });
      continue;
    }
    for (const [index, raw] of configuration.packageFacts.entries()) {
      if (!isRecord(raw) || typeof raw.package !== "string" || !isPackageCapability(raw.capability)) {
        issues.push({ kind: "invalid-official-metadata", key: owner, message: `Invalid official package fact ${owner}[${String(index)}]` });
        continue;
      }
      const normalized = normalizePackagePolicyKey(raw.package);
      const description = descriptiveFacts(raw);
      const factRoot = normalized === null ? "" : packageRoot(normalized);
      if (normalized === null || description === undefined || (!factRoot.startsWith(OFFICIAL_PACKAGE_PREFIX) && !OFFICIAL_SUPPORTED_ROOTS.has(factRoot))) {
        issues.push({ kind: "invalid-official-metadata", key: raw.package, message: `Invalid official package fact ${owner}[${String(index)}]` });
        continue;
      }
      const candidate: OfficialFact = Object.freeze({ package: normalized, capability: raw.capability, ...description, owner });
      const prior = facts.get(normalized);
      if (prior !== undefined && (prior.capability !== candidate.capability || !sameFacts(prior, candidate))) {
        blocked.add(normalized);
        issues.push({ kind: "fact-conflict", key: normalized, message: `Conflicting official package facts for ${normalized}: ${prior.owner}, ${owner}` });
        continue;
      }
      facts.set(normalized, prior ?? candidate);
    }
  }
  return facts;
}

function configuredV2(
  root: string,
  options: unknown,
  issues: PackagePolicyIssue[],
  blocked: Set<string>,
): { readonly source: "application-v2" | "options-v2"; readonly values: readonly PackageCapabilityV2Input[] } {
  const optionRecord = isRecord(options) ? options : {};
  let source: "application-v2" | "options-v2" = "application-v2";
  let value: unknown;
  if (hasOwn(optionRecord, "packageCapabilitiesV2")) {
    source = "options-v2";
    value = optionRecord.packageCapabilitiesV2;
  } else {
    const application = rootPackageJson(root);
    const configuration = application?.typescriptOnRails;
    value = isRecord(configuration) ? configuration.packageCapabilitiesV2 : undefined;
  }
  if (value === undefined) return { source, values: [] };
  if (!Array.isArray(value)) {
    issues.push({ kind: "malformed-policy", key: "packageCapabilitiesV2", message: "Package capability policy is malformed: packageCapabilitiesV2 must be an array" });
    return { source, values: [] };
  }
  const values: PackageCapabilityV2Input[] = [];
  for (const [index, entry] of value.entries()) {
    const key = isRecord(entry) && typeof entry.package === "string" ? normalizePackagePolicyKey(entry.package) : null;
    const facts = isRecord(entry) ? descriptiveFacts(entry) : undefined;
    const provenance = isRecord(entry) ? entry.provenance : undefined;
    if (
      !isRecord(entry)
      || entry.version !== 2
      || typeof entry.package !== "string"
      || key === null
      || typeof entry.packageVersion !== "string"
      || facts === undefined
      || (provenance !== undefined && provenance !== "official" && provenance !== "override" && provenance !== "declared-v2" && provenance !== "migrated-v1")
    ) {
      if (key !== null) blocked.add(key);
      issues.push({ kind: "malformed-policy", ...(key === null ? {} : { key }), message: `Invalid packageCapabilitiesV2 entry at index ${String(index)}` });
      continue;
    }
    values.push(Object.freeze({
      version: 2,
      package: key,
      packageVersion: entry.packageVersion,
      ...facts,
      ...(provenance === undefined ? {} : { provenance }),
      ...(typeof entry.inheritedFrom === "string" ? { inheritedFrom: entry.inheritedFrom } : {}),
    }));
  }
  return { source, values: Object.freeze(values) };
}

function resolvedVersion(
  root: string,
  boundary: string,
  packageName: string,
  lock: ResolvedPackageLock | undefined,
  installedCache: Map<string, InstalledPackage | undefined>,
): {
  readonly packageVersion: string;
  readonly versionSource: PackageCapabilityCatalogEntry["versionSource"];
  readonly mismatch?: { readonly installed: string; readonly locked: string };
} {
  const rootName = packageRoot(packageName);
  const nodeCapability = frameworkNodeCapability(rootName);
  if (nodeCapability !== null) return { packageVersion: process.versions.node, versionSource: "node-runtime" };
  const installedPackageValue = installedCache.has(rootName)
    ? installedCache.get(rootName)
    : installedPackage(root, boundary, rootName);
  installedCache.set(rootName, installedPackageValue);
  const installed = installedPackageValue?.version;
  const locked = lockedPackageVersion(lock, rootName, installedPackageValue?.packageJsonPath);
  if (installed !== undefined && locked !== undefined && installed !== locked) {
    return { packageVersion: installed, versionSource: "installed", mismatch: { installed, locked } };
  }
  if (installed !== undefined && locked !== undefined) return { packageVersion: installed, versionSource: "installed+lockfile" };
  if (installed !== undefined) return { packageVersion: installed, versionSource: "installed" };
  if (locked !== undefined) return { packageVersion: locked, versionSource: "lockfile" };
  return { packageVersion: "unresolved", versionSource: "unresolved" };
}

function buildCatalog(
  root: string,
  options: unknown,
  explicit: ExplicitPackagePolicy,
): PackageCapabilityCatalog {
  const issues = [...explicit.issues];
  const blocked = new Set(explicit.blockedPackages);
  const boundary = resolutionBoundary(root);
  const installedCache = new Map<string, InstalledPackage | undefined>();
  const lock = nearestPackageLock(root, boundary);
  const official = officialFacts(root, boundary, issues, blocked, installedCache);
  const v1 = new Map(explicit.entries.map((entry) => [entry.package, entry.capability]));
  const configured = configuredV2(root, options, issues, blocked);
  const v2 = new Map<string, PackageCapabilityV2Input>();
  for (const decision of configured.values) {
    const normalized = decision.package;
    const prior = v2.get(normalized);
    if (prior !== undefined && (!sameFacts(prior, decision) || prior.packageVersion !== decision.packageVersion)) {
      blocked.add(normalized);
      issues.push({ kind: "fact-conflict", key: normalized, message: `Conflicting application package facts for ${normalized}` });
      continue;
    }
    v2.set(normalized, Object.freeze({ ...decision, package: normalized }));
  }
  const entries: PackageCapabilityCatalogEntry[] = [];
  const keys = new Set([...official.keys(), ...v1.keys(), ...v2.keys()]);
  for (const packageName of [...keys].sort(compareText)) {
    if (blocked.has(packageName) || packageRoot(packageName) === FRAMEWORK_PACKAGE) continue;
    const officialFact = official.get(packageName);
    const legacy = v1.get(packageName);
    const declared = v2.get(packageName);
    if (legacy !== undefined && officialFact !== undefined && legacy !== officialFact.capability) {
      blocked.add(packageName);
      issues.push({ kind: "fact-conflict", key: packageName, message: `Application capability ${legacy} contradicts official capability ${officialFact.capability} for ${packageName}` });
      continue;
    }
    if (declared !== undefined && officialFact !== undefined && !sameFacts(declared, officialFact)) {
      blocked.add(packageName);
      issues.push({ kind: "fact-conflict", key: packageName, message: `Application package facts contradict official facts for ${packageName}` });
      continue;
    }
    const facts = declared ?? officialFact ?? (legacy === undefined ? undefined : factsFromCapability(packageName, legacy));
    const capability = legacy ?? officialFact?.capability;
    if (facts === undefined) continue;
    if (capability === undefined) {
      blocked.add(packageName);
      issues.push({ kind: "fact-conflict", key: packageName, message: `Package capability v2 facts for ${packageName} need an explicit packageCapabilities enforcement decision` });
      continue;
    }
    const version = resolvedVersion(root, boundary, packageName, lock, installedCache);
    if (version.mismatch !== undefined) {
      blocked.add(packageName);
      issues.push({
        kind: "version-mismatch",
        key: packageName,
        message: `Installed version ${version.mismatch.installed} of ${packageName} does not match package-lock.json version ${version.mismatch.locked}; reinstall with npm ci before trusting package facts`,
      });
      continue;
    }
    if (declared !== undefined && version.packageVersion !== "unresolved" && declared.packageVersion !== version.packageVersion) {
      blocked.add(packageName);
      issues.push({ kind: "version-mismatch", key: packageName, message: `Configured version ${declared.packageVersion} of ${packageName} does not match resolved version ${version.packageVersion}` });
      continue;
    }
    const source: PackageCapabilitySource = declared !== undefined
      ? configured.source
      : legacy !== undefined
        ? explicit.source === "options" ? "options-v1" : "application-v1"
        : "official-package";
    const provenance: PackageCapabilityProvenance = officialFact !== undefined && (declared !== undefined || legacy !== undefined)
      ? "override"
      : declared !== undefined
        ? declared.provenance ?? "declared-v2"
        : legacy !== undefined
          ? "migrated-v1"
          : "official";
    entries.push(Object.freeze({
      package: packageName,
      capability,
      packageVersion: version.packageVersion,
      versionSource: version.versionSource,
      runtime: normalizedValues(facts.runtime),
      effects: normalizedValues(facts.effects),
      nondeterminism: normalizedValues(facts.nondeterminism),
      provenance,
      source,
      ...(officialFact === undefined ? {} : { officialOwner: officialFact.owner }),
    }));
  }
  issues.sort((left, right) => compareText(left.key ?? "", right.key ?? "") || compareText(left.kind, right.kind));
  return Object.freeze({ entries: Object.freeze(entries), blockedPackages: Object.freeze([...blocked].sort(compareText)), issues: Object.freeze(issues) });
}

export function buildPackageCapabilityCatalog(root: string, options: unknown): PackageCapabilityCatalog {
  return buildCatalog(root, options, selectExplicitPackagePolicy(root, options));
}

function isSelectedPackagePolicy(value: unknown): value is SelectedPackagePolicy {
  return isRecord(value)
    && Array.isArray(value.entries)
    && Array.isArray(value.blockedPackages)
    && Array.isArray(value.issues)
    && (value.source === "options" || value.source === "package.json")
    && typeof value.derivedFromOfficialMetadata === "boolean"
    && isRecord(value.catalog);
}

export function selectPackagePolicy(root: string, options: unknown): SelectedPackagePolicy {
  if (typeof options === "object" && options !== null) {
    const precomputed: unknown = Reflect.get(options, PRECOMPUTED_PACKAGE_POLICY);
    if (isSelectedPackagePolicy(precomputed)) return precomputed;
  }
  const explicit = selectExplicitPackagePolicy(root, options);
  const catalog = buildCatalog(root, options, explicit);
  const blocked = new Set(catalog.blockedPackages);
  const derivedFromOfficialMetadata = explicit.entries.length === 0 && explicit.issues.length === 0;
  const derived = derivedFromOfficialMetadata
    ? catalog.entries
        .filter(({ package: packageName }) => packageRoot(packageName) !== FRAMEWORK_PACKAGE)
        .map(({ package: packageName, capability }) => ({ package: packageName, capability }))
    : explicit.entries.filter(({ package: packageName }) => !blocked.has(packageName));
  return Object.freeze({
    entries: Object.freeze(derived),
    blockedPackages: catalog.blockedPackages,
    issues: catalog.issues,
    source: explicit.source,
    derivedFromOfficialMetadata,
    catalog,
  });
}

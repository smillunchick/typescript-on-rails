import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import type { PackageCapability } from "../../features/runtime/index.js";

const FRAMEWORK_PACKAGE = "typescript-on-rails";
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
    | "removed-option";
  readonly message: string;
  readonly key?: string;
}

export interface SelectedPackagePolicy {
  readonly entries: readonly PackagePolicyEntry[];
  readonly blockedPackages: readonly string[];
  readonly issues: readonly PackagePolicyIssue[];
  readonly source: "options" | "package.json";
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

export function selectPackagePolicy(root: string, options: unknown): SelectedPackagePolicy {
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

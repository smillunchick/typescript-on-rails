import {
  analyzeApplication,
  formatArchitectureDiagnostic,
  type AnalyzeApplicationOptions,
  type ArchitectureManifest,
} from "../architecture/index.js";
import { assertManifestV2 } from "../introspection/index.js";
import type { ExecutionContext } from "../runtime/index.js";

export function executionContext(...permissions: readonly string[]): ExecutionContext {
  return { permissions: new Set(permissions) };
}

function formatValidatedArchitectureDiagnostics(manifest: ArchitectureManifest): string {
  if (manifest.diagnostics.length === 0) return "Architecture check passed.\n";
  return `${manifest.diagnostics.map(formatArchitectureDiagnostic).join("\n")}\n`;
}

export function formatArchitectureDiagnostics(manifest: ArchitectureManifest): string {
  assertManifestV2(manifest);
  return formatValidatedArchitectureDiagnostics(manifest);
}

export function assertArchitecture(manifest: ArchitectureManifest): ArchitectureManifest {
  assertManifestV2(manifest);
  const errors = manifest.diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length === 0) return manifest;
  throw new Error(`Architecture check failed.\n${formatValidatedArchitectureDiagnostics(manifest)}`);
}

export function analyzeAndAssertArchitecture(
  root: string,
  options: AnalyzeApplicationOptions = {},
): ArchitectureManifest {
  return assertArchitecture(analyzeApplication(root, options));
}

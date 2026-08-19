import {
  analyzeApplication,
  formatArchitectureDiagnostic,
  type AnalyzeApplicationOptions,
  type ArchitectureManifest,
} from "../architecture/index.js";
import type { ExecutionContext } from "../runtime/index.js";

export function executionContext(...permissions: readonly string[]): ExecutionContext {
  return { permissions: new Set(permissions) };
}

export function formatArchitectureDiagnostics(manifest: ArchitectureManifest): string {
  if (manifest.diagnostics.length === 0) return "Architecture check passed.\n";
  return `${manifest.diagnostics.map(formatArchitectureDiagnostic).join("\n")}\n`;
}

export function assertArchitecture(manifest: ArchitectureManifest): ArchitectureManifest {
  const errors = manifest.diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length === 0) return manifest;
  throw new Error(`Architecture check failed.\n${formatArchitectureDiagnostics(manifest)}`);
}

export function analyzeAndAssertArchitecture(
  root: string,
  options: AnalyzeApplicationOptions = {},
): ArchitectureManifest {
  return assertArchitecture(analyzeApplication(root, options));
}

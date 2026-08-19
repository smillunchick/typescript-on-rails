import { analyzeApplication } from "../architecture/analyze.js";
import type { AnalyzeApplicationOptions, ArchitectureManifest } from "../architecture/manifest.js";
import type { ExecutionContext } from "../domain/executable.js";

export function executionContext(...permissions: readonly string[]): ExecutionContext {
  return { permissions: new Set(permissions) };
}

export function formatArchitectureDiagnostics(manifest: ArchitectureManifest): string {
  if (manifest.diagnostics.length === 0) return "Architecture check passed.\n";
  return `${manifest.diagnostics.map((entry) => {
    const suggestion = entry.suggestion === undefined ? "" : ` Suggestion: ${entry.suggestion}`;
    return `[${entry.code}] ${entry.file}:${entry.line} ${entry.message}${suggestion}`;
  }).join("\n")}\n`;
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

import type { ArchitectureDiagnostic } from "./manifest.js";

export function formatArchitectureDiagnostic(entry: ArchitectureDiagnostic): string {
  const suggestion = entry.suggestion === undefined ? "" : ` Suggestion: ${entry.suggestion}`;
  return `[${entry.code}] ${entry.file}:${entry.line} ${entry.message}${suggestion}`;
}

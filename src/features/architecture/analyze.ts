import { analyzeWithTypescript } from "../../infra/typescript/index.js";

import type { AnalyzeApplicationOptions, ArchitectureManifest } from "./manifest.js";

export function analyzeApplication(
  applicationRoot: string,
  options: AnalyzeApplicationOptions = {},
): ArchitectureManifest {
  return analyzeWithTypescript(applicationRoot, options);
}

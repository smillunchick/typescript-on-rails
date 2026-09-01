import { analyzeWithTypescript } from "../../infra/typescript/index.js";
import { architecture } from "../runtime/index.js";

import type { AnalyzeApplicationOptions, ArchitectureManifest } from "./manifest.js";

architecture.allow({
  rule: "feature-infrastructure-boundary",
  reason: "The architecture feature owns the public compiler operation while the TypeScript compiler API implementation remains infrastructure.",
});

export function analyzeApplication(
  applicationRoot: string,
  options: AnalyzeApplicationOptions = {},
): ArchitectureManifest {
  return analyzeWithTypescript(applicationRoot, options);
}

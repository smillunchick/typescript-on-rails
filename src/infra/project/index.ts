export { createGitArchitectureDiff, validateGitRef, type AnalyzeForDiff } from "./git-snapshot.js";
export {
  createAction,
  createApplication,
  createFeature,
  createModel,
  createQuery,
  type ApplicationScaffoldFileSystem,
  type GenerationResult,
} from "./scaffold.js";

export {
  frameworkNodeCapability,
  normalizePackagePolicyKey,
  runtimePackageIdentity,
  selectPackagePolicy,
  type PackagePolicyEntry,
  type PackagePolicyIssue,
  type RuntimePackageIdentity,
  type SelectedPackagePolicy,
} from "./package-policy.js";
export { hasAppOwnedScript } from "./package-script.js";
export { runProjectCommand, type ProjectCommandInvocation } from "./process.js";

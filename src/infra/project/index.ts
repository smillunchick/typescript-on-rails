export {
  createGitArchitectureDiff,
  GitArchitectureDiffCompatibilityError,
  validateGitRef,
  type AnalyzeForDiff,
  type GitArchitectureDiffCompatibilityErrorCode,
} from "./git-snapshot.js";
export {
  createAction,
  createApplication,
  createFeature,
  createModel,
  createQuery,
  type ApplicationProfile,
  type ApplicationScaffoldFileSystem,
  type ApplicationScaffoldOptions,
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
export {
  hasAppOwnedScript,
  hasFullStackLifecycle,
  loadFullStackApplication,
  resolveFullStackLifecycleBin,
} from "./package-script.js";
export { runProjectCommand, type ProjectCommandInvocation } from "./process.js";

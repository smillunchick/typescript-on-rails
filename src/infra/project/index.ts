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
  type ApplicationScaffoldContent,
  type ApplicationScaffoldFileSystem,
  type ApplicationScaffoldOptions,
  type GeneratedOperationAccess,
  type GenerationResult,
  type ProjectGenerationOptions,
} from "./scaffold.js";

export {
  buildPackageCapabilityCatalog,
  frameworkNodeCapability,
  normalizePackagePolicyKey,
  runtimePackageIdentity,
  selectPackagePolicy,
  type PackageCapabilityCatalog,
  type PackageCapabilityCatalogEntry,
  type PackageCapabilityProvenance,
  type PackageCapabilitySource,
  type PackageCapabilityV2Input,
  type PackageEffect,
  type PackageNondeterminism,
  type PackagePolicyEntry,
  type PackageRuntimeLocation,
  type PackagePolicyIssue,
  type RuntimePackageIdentity,
  type SelectedPackagePolicy,
} from "./package-policy.js";
export {
  hasAppOwnedScript,
  hasFullStackLifecycle,
  inspectFullStackApplication,
  loadFullStackApplication,
  resolveFullStackLifecycleBin,
  FullStackIntrospectionError,
  type FullStackIntrospectionOptions,
} from "./package-script.js";
export {
  updateAppRegistrationSource,
  updateFeatureRegistrationSource,
  validateFeatureRegistrationSource,
  type AppRegistrationSourceEdit,
  type FeatureArtifactCollection,
  type FeatureRegistrationSourceEdit,
} from "./application-shape.js";
export {
  executeProjectEdit,
  planProjectEdit,
  recoverProjectEdit,
  ProjectEditError,
  type ProjectEditOptions,
  type ProjectEditPlan,
  type ProjectEditRequest,
} from "./project-edit.js";
export { runProjectCommand, type ProjectCommandInvocation } from "./process.js";

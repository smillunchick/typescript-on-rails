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

export { hasAppOwnedScript } from "./package-script.js";
export { runProjectCommand, type ProjectCommandInvocation } from "./process.js";

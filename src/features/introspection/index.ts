export {
  diffArchitecture,
  formatArchitectureDiff,
  type AdapterSemantic,
  type ArchitectureDiff,
  type DependencySemantic,
  type EventSemantic,
  type FeatureSemantic,
  type ModelSemantic,
  type OperationSemantic,
  type PublicApiSemantic,
  type RouteSemantic,
  type SemanticCategory,
  type SemanticChange,
} from "./diff.js";
export {
  inspectApplication,
  inspectManifest,
  type ApplicationInspector,
  type BoundaryProjection,
  type CallerProjection,
  type FeatureExplanation,
  type ImpactProjection,
  type OwnerProjection,
  type RouteExplanation,
} from "./inspector.js";
export {
  formatFeatureExplanation,
  formatRouteExplanation,
  graphAsDot,
  graphAsText,
} from "./render.js";

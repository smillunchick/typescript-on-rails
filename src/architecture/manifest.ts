export type ArchitectureSeverity = "error" | "warning";

export interface ArchitectureDiagnostic {
  readonly code: string;
  readonly rule: string;
  readonly severity: ArchitectureSeverity;
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly suggestion?: string;
  readonly target?: string;
}

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

export interface PublicExportManifest extends SourceLocation {
  readonly name: string;
  readonly kind: string;
}

export interface FeatureManifest extends SourceLocation {
  readonly name: string;
  readonly publicBoundary: string | null;
  readonly exports: readonly PublicExportManifest[];
}

export interface ModelManifest extends SourceLocation {
  readonly name: string;
  readonly feature: string | null;
}

export interface OperationManifest extends SourceLocation {
  readonly name: string;
  readonly kind: "action" | "query";
  readonly feature: string | null;
  readonly permission?: string;
}

export interface RouteManifest extends SourceLocation {
  readonly name: string;
  readonly method: string | null;
  readonly path: string | null;
  readonly feature: string | null;
  readonly permission?: string;
}

export interface EventManifest extends SourceLocation {
  readonly name: string;
  readonly feature: string | null;
}

export interface AdapterManifest extends SourceLocation {
  readonly name: string;
  readonly kind: "contract" | "implementation";
  readonly feature: string | null;
}

export interface DependencyManifest extends SourceLocation {
  readonly from: string;
  readonly to: string;
}

export interface ArchitectureExceptionManifest extends SourceLocation {
  readonly rule: string | null;
  readonly reason: string | null;
  readonly expires?: string;
  readonly target?: string;
  readonly valid: boolean;
}

export interface ArchitectureManifest {
  readonly version: 1;
  readonly root: string;
  readonly features: readonly FeatureManifest[];
  readonly models: readonly ModelManifest[];
  readonly operations: readonly OperationManifest[];
  readonly routes: readonly RouteManifest[];
  readonly events: readonly EventManifest[];
  readonly adapters: readonly AdapterManifest[];
  readonly permissions: readonly string[];
  readonly dependencies: readonly DependencyManifest[];
  readonly exceptions: readonly ArchitectureExceptionManifest[];
  readonly diagnostics: readonly ArchitectureDiagnostic[];
}

export interface AnalyzeApplicationOptions {
  readonly tsconfig?: string;
  readonly allowedExternalPackages?: readonly string[];
}

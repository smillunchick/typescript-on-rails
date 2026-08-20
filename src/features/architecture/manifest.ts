import type { PackageCapability, SchemaMetadata } from "../runtime/index.js";
import type { SemanticIdOwner } from "./semantic-id.js";

export type TypeContractPrimitive = "bigint" | "boolean" | "number" | "string" | "symbol";

export interface TypeContractProperty {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly readonly: boolean;
}

export interface TypeContractTupleElement {
  readonly type: string;
  readonly optional: boolean;
  readonly rest: boolean;
}

export type TypeContractNode =
  | { readonly id: string; readonly kind: "primitive"; readonly name: TypeContractPrimitive }
  | { readonly id: string; readonly kind: "literal"; readonly value: string | number | boolean | null; readonly valueType: "bigint" | "boolean" | "number" | "string" | "null" }
  | { readonly id: string; readonly kind: "unknown" }
  | { readonly id: string; readonly kind: "undefined" }
  | { readonly id: string; readonly kind: "void" }
  | { readonly id: string; readonly kind: "date" }
  | { readonly id: string; readonly kind: "array"; readonly element: string; readonly readonly: boolean }
  | { readonly id: string; readonly kind: "tuple"; readonly elements: readonly TypeContractTupleElement[]; readonly readonly: boolean }
  | { readonly id: string; readonly kind: "object"; readonly properties: readonly TypeContractProperty[] }
  | { readonly id: string; readonly kind: "union"; readonly members: readonly string[] };

export interface TypeContract {
  readonly version: 1;
  readonly root: string;
  readonly nodes: readonly TypeContractNode[];
}

export interface TypeContractDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  /** Checker display text is diagnostic detail only and never enters TypeContract. */
  readonly detail?: string;
}

export type ContractProvenance = "declared-schema" | "inferred-typescript";

export type StaticTypeFacet =
  | {
      readonly status: "resolved";
      readonly provenance: "inferred-typescript";
      readonly contract: TypeContract;
      readonly labels: readonly string[];
    }
  | {
      readonly status: "unresolved";
      readonly provenance: "inferred-typescript";
      readonly diagnostic: TypeContractDiagnostic;
      readonly labels: readonly string[];
    };

export type RuntimeSchemaFacet =
  | {
      readonly status: "resolved";
      readonly provenance: "declared-schema";
      readonly validator: "declared";
      readonly metadata: SchemaMetadata;
    }
  | {
      readonly status: "unresolved";
      readonly provenance: "declared-schema";
      readonly validator: "declared";
      readonly diagnostic: TypeContractDiagnostic;
    }
  | {
      readonly status: "unresolved";
      readonly validator: "not-declared";
      readonly diagnostic: TypeContractDiagnostic;
    }
  | {
      readonly status: "not-declared";
      readonly validator: "not-declared";
    };

export interface ContractSlot {
  readonly staticType: StaticTypeFacet;
  readonly runtimeSchema: RuntimeSchemaFacet;
}

export type DeclaredRuntimeSchemaFacet = Extract<RuntimeSchemaFacet, { readonly validator: "declared" }>;

export interface DeclaredContractSlot extends ContractSlot {
  readonly runtimeSchema: DeclaredRuntimeSchemaFacet;
}

export interface AdapterOperationFacet {
  readonly input: DeclaredRuntimeSchemaFacet;
  readonly output: DeclaredRuntimeSchemaFacet;
}

export type AdapterOperationsFacet =
  | {
      readonly status: "resolved";
      readonly operations: Readonly<Record<string, AdapterOperationFacet>>;
    }
  | {
      readonly status: "unresolved";
      readonly diagnostic: TypeContractDiagnostic;
    };

export interface ManifestCompilerMetadata {
  readonly manifestVersion: 2;
  readonly typescriptVersion: "5.9.3";
  readonly schemaProtocolVersion: "1";
  readonly canonicalSchemaVersion: "1";
  readonly typeContractVersion: 1;
}

export interface PackagePolicyManifest {
  readonly package: string;
  readonly capability: PackageCapability;
}

export interface PackageUseManifest extends SourceLocation {
  readonly package: string;
  readonly capability: PackageCapability;
}

export type ArchitectureSeverity = "error" | "warning";

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

export interface UnknownPackageInventoryEntry {
  readonly package: string;
  readonly uses: readonly SourceLocation[];
}

export interface PackageCapabilityMigration {
  readonly inventory: readonly UnknownPackageInventoryEntry[];
  readonly packageCapabilities: Readonly<Record<string, string>>;
}

export interface ArchitectureDiagnostic extends SourceLocation {
  readonly code: string;
  readonly rule: string;
  readonly severity: ArchitectureSeverity;
  readonly message: string;
  readonly suggestion?: string;
  readonly target?: string;
  readonly related?: readonly SourceLocation[];
  readonly packageCapabilityMigration?: PackageCapabilityMigration;
}

interface SemanticManifestRecord extends SourceLocation {
  readonly id: string | null;
  readonly owner: SemanticIdOwner;
  readonly name: string;
  readonly feature: string | null;
}

export interface PublicExportManifest extends SemanticManifestRecord {
  readonly kind: string;
}

export interface FeatureManifest extends SemanticManifestRecord {
  readonly publicBoundary: string | null;
  readonly exports: readonly PublicExportManifest[];
}

export interface ModelManifest extends SemanticManifestRecord {
  readonly fields: RuntimeSchemaFacet;
}

export type OperationAccess = "public" | "permission" | "authorize" | "missing";

export interface OperationManifest extends SemanticManifestRecord {
  readonly kind: "action" | "query";
  readonly input: ContractSlot;
  readonly output: ContractSlot;
  readonly access: OperationAccess;
  readonly permission?: string;
}

export interface RouteManifest extends SemanticManifestRecord {
  readonly method: string | null;
  readonly path: string | null;
  readonly input: ContractSlot;
  readonly output: ContractSlot;
  readonly access: OperationAccess;
  readonly permission?: string;
}

export interface EventManifest extends SemanticManifestRecord {
  readonly payload: RuntimeSchemaFacet;
}

export interface AdapterContractManifest extends SemanticManifestRecord {
  readonly kind: "contract";
  readonly operations: AdapterOperationsFacet;
}

export interface AdapterImplementationManifest extends SemanticManifestRecord {
  readonly kind: "implementation";
  readonly contractId: string | null;
}

export type AdapterManifest = AdapterContractManifest | AdapterImplementationManifest;

export interface DependencyManifest extends SourceLocation {
  readonly from: string;
  readonly to: string;
  readonly symbols: readonly string[];
}

export interface ArchitectureExceptionManifest extends SourceLocation {
  readonly rule: string | null;
  readonly reason: string | null;
  readonly expires?: string;
  readonly target?: string;
  readonly valid: boolean;
}

export interface ArchitectureManifest {
  readonly version: 2;
  readonly compiler: ManifestCompilerMetadata;
  readonly packagePolicy: readonly PackagePolicyManifest[];
  readonly packageUses: readonly PackageUseManifest[];
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
  readonly packageCapabilities?: Readonly<Record<string, PackageCapability>>;
}

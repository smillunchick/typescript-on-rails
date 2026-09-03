import type { ArchitectureManifestV3 } from "./manifest-v3.js";

export const APPLICATION_INTROSPECTION_PROTOCOL = "typescript-on-rails.application-introspection/v1" as const;

export interface ApplicationIntrospectionSuccess {
  readonly protocol: typeof APPLICATION_INTROSPECTION_PROTOCOL;
  readonly ok: true;
  readonly manifest: ArchitectureManifestV3;
}

export interface ApplicationIntrospectionFailure {
  readonly protocol: typeof APPLICATION_INTROSPECTION_PROTOCOL;
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type ApplicationIntrospectionResult = ApplicationIntrospectionSuccess | ApplicationIntrospectionFailure;

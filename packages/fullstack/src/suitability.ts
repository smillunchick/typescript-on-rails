import {
  assertRelationExceptions,
  assertRuntimeSuitability,
  type AnyAdapterInstance,
  type App,
  type ExecutionContext,
} from "typescript-on-rails";

export function runtimeSuitability(
  environment: Readonly<Record<string, string | undefined>>,
): "local-only" | "production" {
  return environment.NODE_ENV === "production" ? "production" : "local-only";
}

export function assertApplicationSuitability(
  application: App<Readonly<Record<string, AnyAdapterInstance>>, ExecutionContext>,
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly asOf?: Date } = {},
): void {
  assertRuntimeSuitability(application, runtimeSuitability(environment));
  assertRelationExceptions(application, { asOf: options.asOf ?? new Date() });
}

import type { AnyAdapterInstance } from "./adapter.js";
import type { ApplicationGraph } from "./app.js";

export interface AdapterSuitabilityIssue {
  readonly adapter: string;
  readonly contract: string;
  readonly provider: string;
  readonly suitability: "local-only";
  readonly reason: string;
}

export function adapterSuitabilityIssues(
  adapters: readonly AnyAdapterInstance[],
  target: "local-only" | "production",
): readonly AdapterSuitabilityIssue[] {
  if (target === "local-only") return Object.freeze([]);
  return Object.freeze([...adapters]
    .filter(({ suitability }) => suitability === "local-only")
    .map((adapter) => Object.freeze({
      adapter: adapter.metadata.name,
      contract: adapter.contract.name,
      provider: adapter.provider,
      suitability: "local-only" as const,
      reason: "local-only adapter cannot start in a production runtime",
    }))
    .sort((left, right) => `${left.contract}:${left.provider}`.localeCompare(`${right.contract}:${right.provider}`)));
}

export function assertAdapterSuitability(
  adapters: readonly AnyAdapterInstance[],
  target: "local-only" | "production",
): void {
  const issues = adapterSuitabilityIssues(adapters, target);
  if (issues.length > 0) {
    throw new Error(`ADAPTER_NOT_PRODUCTION_SUITABLE:${issues.map(({ contract }) => contract).join(",")}`);
  }
}

export function assertRuntimeSuitability(
  application: { readonly graph: Pick<ApplicationGraph, "adapters"> },
  target: "local-only" | "production",
): void {
  assertAdapterSuitability(application.graph.adapters.map(({ definition }) => definition), target);
}

import type { ArchitectureManifest } from "../architecture/index.js";
import type { FeatureExplanation, RouteExplanation } from "./inspector.js";

function escapeDot(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function graphAsText(manifest: ArchitectureManifest): string {
  const dependencies = new Map<string, string[]>();
  for (const feature of manifest.features) dependencies.set(feature.name, []);
  for (const edge of manifest.dependencies) {
    const targets = dependencies.get(edge.from) ?? [];
    targets.push(edge.to);
    dependencies.set(edge.from, targets);
  }
  return [...dependencies]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, targets]) => {
      const uniqueTargets = [...new Set(targets)].sort();
      return uniqueTargets.length === 0 ? feature : `${feature} -> ${uniqueTargets.join(", ")}`;
    })
    .join("\n") + "\n";
}

export function graphAsDot(manifest: ArchitectureManifest): string {
  const lines = ["digraph architecture {"];
  for (const feature of manifest.features.map((entry) => entry.name).sort()) {
    lines.push(`  "${escapeDot(feature)}";`);
  }
  const edges = [...new Set(manifest.dependencies.map((entry) => `${entry.from}\0${entry.to}`))]
    .map((entry) => {
      const separator = entry.indexOf("\0");
      return { from: entry.slice(0, separator), to: entry.slice(separator + 1) };
    })
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  for (const edge of edges) lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}";`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function list(label: string, values: readonly string[]): string {
  return `${label}: ${values.length === 0 ? "none" : values.join(", ")}`;
}

export function formatFeatureExplanation(explanation: FeatureExplanation): string {
  return [
    explanation.name,
    `Public boundary: ${explanation.publicBoundary ?? "missing"}`,
    list("Public API", explanation.publicApi.map((entry) => entry.name)),
    list("Models", explanation.models),
    list("Actions", explanation.actions),
    list("Queries", explanation.queries),
    list("Routes", explanation.routes),
    list("Permissions", explanation.permissions),
    list("Events", explanation.events),
    list("Adapters", explanation.adapters),
    list("Depends on", explanation.dependencies),
    list("Called by", explanation.dependents),
  ].join("\n") + "\n";
}

export function formatRouteExplanation(explanation: RouteExplanation): string {
  return [
    `${explanation.method ?? "?"} ${explanation.path ?? explanation.name}`,
    `Name: ${explanation.name}`,
    `Feature: ${explanation.feature ?? "none"}`,
    `Permission: ${explanation.permission ?? "none"}`,
  ].join("\n") + "\n";
}

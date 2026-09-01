import type { ArchitectureManifestV3 } from "../architecture/index.js";
import { diffArchitecture, type ArchitectureDiff } from "./diff.js";

export interface ArchitectureDiffV3 {
  readonly version: 3;
  readonly base: ArchitectureDiff;
  readonly composition: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  readonly completeness: {
    readonly before: ArchitectureManifestV3["completeness"]["counts"];
    readonly after: ArchitectureManifestV3["completeness"]["counts"];
  };
  readonly packageCapabilities: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function compositionKey(record: ArchitectureManifestV3["composition"][number]): string {
  return `${record.kind}/${record.owner}/${record.name}`;
}

function capabilityKey(record: ArchitectureManifestV3["packageCapabilities"][number]): string {
  return `${record.package}@${record.packageVersion}`;
}

export function diffArchitectureV3(before: ArchitectureManifestV3, after: ArchitectureManifestV3): ArchitectureDiffV3 {
  const beforeComposition = new Set(before.composition.map(compositionKey));
  const afterComposition = new Set(after.composition.map(compositionKey));
  const beforeCapabilities = new Map(before.packageCapabilities.map((record) => [capabilityKey(record), canonical(record)]));
  const afterCapabilities = new Map(after.packageCapabilities.map((record) => [capabilityKey(record), canonical(record)]));
  return Object.freeze({
    version: 3,
    base: diffArchitecture(before.base, after.base),
    composition: Object.freeze({
      added: Object.freeze([...afterComposition].filter((key) => !beforeComposition.has(key)).sort()),
      removed: Object.freeze([...beforeComposition].filter((key) => !afterComposition.has(key)).sort()),
    }),
    completeness: Object.freeze({ before: before.completeness.counts, after: after.completeness.counts }),
    packageCapabilities: Object.freeze({
      added: Object.freeze([...afterCapabilities.keys()].filter((key) => !beforeCapabilities.has(key)).sort()),
      removed: Object.freeze([...beforeCapabilities.keys()].filter((key) => !afterCapabilities.has(key)).sort()),
      changed: Object.freeze([...afterCapabilities.keys()].filter((key) => beforeCapabilities.has(key) && beforeCapabilities.get(key) !== afterCapabilities.get(key)).sort()),
    }),
  });
}

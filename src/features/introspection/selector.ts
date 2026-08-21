import {
  decodeSemanticId,
  type AdapterManifest,
  type ArchitectureManifest,
  type EventManifest,
  type FeatureManifest,
  type ModelManifest,
  type OperationManifest,
  type PublicExportManifest,
  type RouteManifest,
  type SemanticIdCategory,
} from "../architecture/index.js";
import { assertComparableManifestV2 } from "./manifest-compatibility.js";

export type SemanticSelectorCategory = SemanticIdCategory;
export type SemanticSelectorRecord =
  | FeatureManifest
  | PublicExportManifest
  | ModelManifest
  | OperationManifest
  | RouteManifest
  | EventManifest
  | AdapterManifest;

export interface SemanticSelectorCandidate {
  readonly id: string;
  readonly category: SemanticSelectorCategory;
  readonly displayName: string;
}

export interface ResolvedSemanticSelector<T = SemanticSelectorRecord> {
  readonly status: "resolved";
  readonly selector: string;
  readonly candidate: SemanticSelectorCandidate;
  readonly value: T;
}

export interface SemanticSelectorNotFound {
  readonly status: "not-found";
  readonly selector: string;
  readonly candidates: readonly SemanticSelectorCandidate[];
}

export interface AmbiguousSemanticSelector {
  readonly status: "ambiguous";
  readonly selector: string;
  readonly candidates: readonly SemanticSelectorCandidate[];
}

export type SemanticSelectorFailure = SemanticSelectorNotFound | AmbiguousSemanticSelector;
export type SemanticSelectorResult<T = SemanticSelectorRecord> = ResolvedSemanticSelector<T> | SemanticSelectorFailure;

interface SelectorEntry {
  readonly candidate: SemanticSelectorCandidate;
  readonly aliases: readonly string[];
  readonly value: SemanticSelectorRecord;
}

export function semanticDisplayName(record: Pick<SemanticSelectorRecord, "name" | "owner">, category?: SemanticSelectorCategory): string {
  if (category === "feature") return record.name;
  const owner = record.owner.kind === "feature" ? record.owner.name : record.owner.kind;
  return `${owner}.${record.name}`;
}

export function requiredSemanticId(value: { readonly id: string | null }): string {
  if (value.id === null) throw new Error("Manifest v2 validation did not provide a semantic ID");
  return value.id;
}

function entry(
  value: SemanticSelectorRecord,
  category: SemanticSelectorCategory,
  aliases: readonly string[] = [value.name],
): SelectorEntry {
  return {
    candidate: {
      id: requiredSemanticId(value),
      category,
      displayName: semanticDisplayName(value, category),
    },
    aliases,
    value,
  };
}

function entries(manifest: ArchitectureManifest): SelectorEntry[] {
  return [
    ...manifest.features.map((value) => entry(value, "feature")),
    ...manifest.features.flatMap((feature) => feature.exports.map((value) => entry(value, "public-export"))),
    ...manifest.models.map((value) => entry(value, "model")),
    ...manifest.operations.map((value) => entry(value, "operation")),
    ...manifest.routes.map((value) => entry(
      value,
      "route",
      value.path === null || value.path === value.name ? [value.name] : [value.name, value.path],
    )),
    ...manifest.events.map((value) => entry(value, "event")),
    ...manifest.adapters.map((value) => entry(
      value,
      value.kind === "contract" ? "adapter-contract" : "adapter-implementation",
    )),
  ];
}

function isCanonicalSemanticId(selector: string): boolean {
  try {
    decodeSemanticId(selector);
    return true;
  } catch {
    return false;
  }
}

export interface SemanticSelectorResolver {
  resolve(
    selector: string,
    categories?: readonly SemanticSelectorCategory[],
  ): SemanticSelectorResult;
}

/** Builds one validated selector index for repeated lookups against the same manifest. */
export function createSemanticSelectorResolver(manifest: ArchitectureManifest): SemanticSelectorResolver {
  assertComparableManifestV2(manifest);
  const allEntries = entries(manifest);
  const byId = new Map(allEntries.map((item) => [item.candidate.id, item]));
  const byAlias = new Map<string, SelectorEntry[]>();
  for (const item of allEntries) {
    for (const alias of item.aliases) {
      const matches = byAlias.get(alias) ?? [];
      matches.push(item);
      byAlias.set(alias, matches);
    }
  }
  for (const matches of byAlias.values()) {
    matches.sort((left, right) => left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0);
  }

  return {
    resolve(selector, categories) {
      const allowed = categories === undefined ? null : new Set(categories);
      const categoryAllowed = (item: SelectorEntry): boolean => allowed === null || allowed.has(item.candidate.category);

      if (isCanonicalSemanticId(selector)) {
        const selected = byId.get(selector);
        return selected === undefined || !categoryAllowed(selected)
          ? { status: "not-found", selector, candidates: [] }
          : { status: "resolved", selector, candidate: selected.candidate, value: selected.value };
      }

      const matches = (byAlias.get(selector) ?? []).filter(categoryAllowed);
      const [selected] = matches;
      if (selected === undefined) return { status: "not-found", selector, candidates: [] };
      if (matches.length > 1) return { status: "ambiguous", selector, candidates: matches.map(({ candidate }) => candidate) };
      return { status: "resolved", selector, candidate: selected.candidate, value: selected.value };
    },
  };
}

/** Resolves one selector at a standalone trust boundary. */
export function resolveSemanticSelector(
  manifest: ArchitectureManifest,
  selector: string,
  categories?: readonly SemanticSelectorCategory[],
): SemanticSelectorResult {
  return createSemanticSelectorResolver(manifest).resolve(selector, categories);
}

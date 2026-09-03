import { sql, type Kysely } from "kysely";

import {
  RELATION_NAME_PATTERN,
  defineRepository,
  type RegisteredRelation,
  type RepositoryDefinition,
} from "typescript-on-rails";

export { defineRepository, isRepositoryDefinition, type RepositoryDefinition } from "typescript-on-rails";

export interface RelationOwnership { readonly relation: string; readonly feature: string }
export interface RelationAccess { readonly relation: string; readonly feature: string; readonly file?: string; readonly operation?: "read" | "write" }
export interface LegacyRelationException { readonly relation: string; readonly feature: string; readonly reason: string; readonly expires?: string }
export interface RelationOwnershipDiagnostic { readonly code: "RELATION_OWNER_MISSING" | "FOREIGN_RELATION_ACCESS"; readonly relation: string; readonly feature: string; readonly owner?: string; readonly file?: string; readonly message: string }

function resolveOwners(ownership: readonly RelationOwnership[]): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const entry of ownership) {
    if (!RELATION_NAME_PATTERN.test(entry.relation)) throw new TypeError(`Invalid relation: ${entry.relation}`);
    const prior = owners.get(entry.relation);
    if (prior !== undefined && prior !== entry.feature) throw new Error(`CONFLICTING_RELATION_OWNER:${entry.relation}`);
    owners.set(entry.relation, entry.feature);
  }
  return owners;
}

/** @deprecated Migration input only. Registered application repositories are authoritative. */
export function checkRelationOwnership(
  ownership: readonly RelationOwnership[],
  accesses: readonly RelationAccess[],
  exceptions: readonly LegacyRelationException[] = [],
): readonly RelationOwnershipDiagnostic[] {
  const owners = resolveOwners(ownership);
  const allowed = new Map<string, LegacyRelationException>();
  for (const exception of exceptions) {
    if (!RELATION_NAME_PATTERN.test(exception.relation)) throw new TypeError(`Invalid relation: ${exception.relation}`);
    if (!/^[a-z][a-z0-9-]*$/.test(exception.feature)) throw new TypeError(`Invalid exception feature: ${exception.feature}`);
    if (exception.reason.trim() === "") throw new TypeError(`RELATION_EXCEPTION_REASON_REQUIRED:${exception.feature}:${exception.relation}`);
    const key = `${exception.feature}:${exception.relation}`;
    const prior = allowed.get(key);
    if (prior !== undefined && (prior.reason !== exception.reason || prior.expires !== exception.expires)) {
      throw new Error(`CONFLICTING_RELATION_EXCEPTION:${exception.feature}:${exception.relation}`);
    }
    allowed.set(key, exception);
  }
  const diagnostics: RelationOwnershipDiagnostic[] = [];
  for (const access of accesses) {
    const owner = owners.get(access.relation);
    if (owner === undefined) diagnostics.push({ code: "RELATION_OWNER_MISSING", relation: access.relation, feature: access.feature, ...(access.file === undefined ? {} : { file: access.file }), message: `${access.relation} has no declared feature owner` });
    else if (owner !== access.feature && !allowed.has(`${access.feature}:${access.relation}`)) diagnostics.push({ code: "FOREIGN_RELATION_ACCESS", relation: access.relation, feature: access.feature, owner, ...(access.file === undefined ? {} : { file: access.file }), message: `${access.feature} cannot access ${access.relation}; use ${owner}'s public boundary` });
  }
  return Object.freeze(diagnostics.sort((a, b) => `${a.code}:${a.relation}:${a.feature}`.localeCompare(`${b.code}:${b.relation}:${b.feature}`)));
}

export function migrateRelationOwnership(
  ownership: readonly RelationOwnership[],
): readonly RepositoryDefinition<unknown>[] {
  resolveOwners(ownership);
  const byFeature = new Map<string, string[]>();
  for (const entry of ownership) {
    const relations = byFeature.get(entry.feature) ?? [];
    if (!relations.includes(entry.relation)) relations.push(entry.relation);
    byFeature.set(entry.feature, relations);
  }
  return Object.freeze([...byFeature]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, relations]) => defineRepository({ name: `${feature}-repository`, feature, relations })));
}

export function relationOwnershipFromGraph(
  graph: { readonly relations: readonly RegisteredRelation[] },
): readonly RelationOwnership[] {
  return Object.freeze(graph.relations
    .map(({ relation, owner }) => Object.freeze({ relation, feature: owner }))
    .sort((left, right) => left.relation.localeCompare(right.relation)));
}

export interface RelationVerification {
  readonly relation: string;
  readonly resolved: boolean;
  readonly resolvedAs?: string;
}

export async function resolveDeclaredRelationNames<DB>(
  db: Kysely<DB>,
  relations: readonly string[],
): Promise<readonly RelationVerification[]> {
  const output: RelationVerification[] = [];
  for (const relation of [...new Set(relations)].sort()) {
    if (!RELATION_NAME_PATTERN.test(relation)) throw new TypeError(`Invalid relation: ${relation}`);
    const localName = relation.slice(relation.indexOf(".") + 1);
    const result = await sql<{ resolved_as: string | null }>`select to_regclass(${localName})::text as resolved_as`.execute(db);
    const resolvedAs = result.rows[0]?.resolved_as ?? null;
    output.push(Object.freeze({ relation, resolved: resolvedAs !== null, ...(resolvedAs === null ? {} : { resolvedAs }) }));
  }
  return Object.freeze(output);
}

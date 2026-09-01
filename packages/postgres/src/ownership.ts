export interface RelationOwnership { readonly relation: string; readonly feature: string }
export interface RelationAccess { readonly relation: string; readonly feature: string; readonly file?: string; readonly operation?: "read" | "write" }
export interface RelationOwnershipDiagnostic { readonly code: "RELATION_OWNER_MISSING" | "FOREIGN_RELATION_ACCESS"; readonly relation: string; readonly feature: string; readonly owner?: string; readonly file?: string; readonly message: string }

export function checkRelationOwnership(ownership: readonly RelationOwnership[], accesses: readonly RelationAccess[], exceptions: readonly { readonly relation: string; readonly feature: string; readonly reason: string }[] = []): readonly RelationOwnershipDiagnostic[] {
  const owners = new Map<string, string>();
  for (const entry of ownership) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(entry.relation)) throw new TypeError(`Invalid relation: ${entry.relation}`);
    const prior = owners.get(entry.relation);
    if (prior !== undefined && prior !== entry.feature) throw new Error(`CONFLICTING_RELATION_OWNER:${entry.relation}`);
    owners.set(entry.relation, entry.feature);
  }
  const allowed = new Set(exceptions.map(({ relation, feature }) => `${feature}:${relation}`));
  const diagnostics: RelationOwnershipDiagnostic[] = [];
  for (const access of accesses) {
    const owner = owners.get(access.relation);
    if (owner === undefined) diagnostics.push({ code: "RELATION_OWNER_MISSING", relation: access.relation, feature: access.feature, ...(access.file === undefined ? {} : { file: access.file }), message: `${access.relation} has no declared feature owner` });
    else if (owner !== access.feature && !allowed.has(`${access.feature}:${access.relation}`)) diagnostics.push({ code: "FOREIGN_RELATION_ACCESS", relation: access.relation, feature: access.feature, owner, ...(access.file === undefined ? {} : { file: access.file }), message: `${access.feature} cannot access ${access.relation}; use ${owner}'s public boundary` });
  }
  return Object.freeze(diagnostics.sort((a, b) => `${a.code}:${a.relation}:${a.feature}`.localeCompare(`${b.code}:${b.relation}:${b.feature}`)));
}

export interface RepositoryDefinition<TRepository> {
  readonly feature: string;
  readonly relations: readonly string[];
  create(): TRepository;
}

export function defineRepository<TRepository>(definition: RepositoryDefinition<TRepository>): RepositoryDefinition<TRepository> {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.feature)) throw new TypeError("Repository feature must be kebab-case");
  const duplicates = definition.relations.find((relation, index) => definition.relations.indexOf(relation) !== index);
  if (duplicates !== undefined) throw new TypeError(`Duplicate repository relation: ${duplicates}`);
  return Object.freeze({ ...definition, relations: Object.freeze([...definition.relations].sort()) });
}

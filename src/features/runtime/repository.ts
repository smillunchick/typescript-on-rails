export const REPOSITORY_PROTOCOL_MARKER = "typescript-on-rails.repository" as const;
export const REPOSITORY_PROTOCOL_VERSION = 1 as const;
export const RELATION_NAME_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface RepositoryMetadata {
  readonly kind: "repository";
  readonly name: string;
  readonly feature: string;
  readonly relations: readonly string[];
}

export interface AnyRepositoryDefinition {
  readonly [REPOSITORY_PROTOCOL_MARKER]: typeof REPOSITORY_PROTOCOL_VERSION;
  readonly name: string;
  readonly feature: string;
  readonly relations: readonly string[];
  readonly metadata: RepositoryMetadata;
}

export interface RepositoryDefinition<TPort> extends AnyRepositoryDefinition {
  readonly portType?: TPort;
}

export interface RelationExceptionInput {
  readonly relation: string;
  readonly reason: string;
  readonly expires?: string;
}

export interface RelationException {
  readonly relation: string;
  readonly feature: string;
  readonly reason: string;
  readonly expires?: string;
}

export interface RegisteredRelationException extends RelationException {
  readonly owner: string;
}

export interface RelationExceptionIssue extends RegisteredRelationException {
  readonly code: "RELATION_EXCEPTION_EXPIRED";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validFeatureName(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(value) && value !== "application";
}

function validExpiry(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isRepositoryDefinition(value: unknown): value is AnyRepositoryDefinition {
  return typeof value === "object"
    && value !== null
    && REPOSITORY_PROTOCOL_MARKER in value
    && value[REPOSITORY_PROTOCOL_MARKER] === REPOSITORY_PROTOCOL_VERSION
    && "metadata" in value
    && typeof value.metadata === "object"
    && value.metadata !== null
    && "kind" in value.metadata
    && value.metadata.kind === "repository";
}

export function defineRepository<TPort>(definition: {
  readonly name: string;
  readonly feature: string;
  readonly relations: readonly string[];
}): RepositoryDefinition<TPort> {
  if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) throw new TypeError(`INVALID_REPOSITORY_NAME:${definition.name}`);
  if (!validFeatureName(definition.feature)) throw new TypeError(`INVALID_REPOSITORY_FEATURE:${definition.feature}`);
  if (definition.relations.length === 0) throw new TypeError(`REPOSITORY_RELATIONS_REQUIRED:${definition.feature}:${definition.name}`);
  const relations = [...definition.relations].sort(compareText);
  const seen = new Set<string>();
  for (const relation of relations) {
    if (!RELATION_NAME_PATTERN.test(relation)) throw new TypeError(`INVALID_RELATION:${relation}`);
    if (seen.has(relation)) throw new TypeError(`DUPLICATE_REPOSITORY_RELATION:${definition.feature}:${definition.name}:${relation}`);
    seen.add(relation);
  }
  const frozenRelations = Object.freeze(relations);
  return Object.freeze({
    [REPOSITORY_PROTOCOL_MARKER]: REPOSITORY_PROTOCOL_VERSION,
    name: definition.name,
    feature: definition.feature,
    relations: frozenRelations,
    metadata: Object.freeze({
      kind: "repository" as const,
      name: definition.name,
      feature: definition.feature,
      relations: frozenRelations,
    }),
  });
}

export function normalizeRelationException(feature: string, input: RelationExceptionInput): RelationException {
  if (!validFeatureName(feature)) throw new TypeError(`INVALID_REPOSITORY_FEATURE:${feature}`);
  if (!RELATION_NAME_PATTERN.test(input.relation)) throw new TypeError(`INVALID_RELATION:${input.relation}`);
  if (input.reason.trim() === "") throw new TypeError(`RELATION_EXCEPTION_REASON_REQUIRED:${feature}:${input.relation}`);
  if (input.expires !== undefined && !validExpiry(input.expires)) {
    throw new TypeError(`INVALID_RELATION_EXCEPTION_EXPIRY:${feature}:${input.relation}:${input.expires}`);
  }
  return Object.freeze({
    relation: input.relation,
    feature,
    reason: input.reason,
    ...(input.expires === undefined ? {} : { expires: input.expires }),
  });
}

export function relationExceptionIssues(
  graph: { readonly relationExceptions: readonly RegisteredRelationException[] },
  options: { readonly asOf: Date },
): readonly RelationExceptionIssue[] {
  if (!(options.asOf instanceof Date) || !Number.isFinite(options.asOf.getTime())) throw new TypeError("RELATION_EXCEPTION_TIME_INVALID");
  const issues = graph.relationExceptions.flatMap((exception): readonly RelationExceptionIssue[] => {
    if (exception.expires === undefined) return [];
    const expiresAt = Date.parse(`${exception.expires}T00:00:00.000Z`) + 86_400_000;
    return options.asOf.getTime() < expiresAt
      ? []
      : [Object.freeze({ code: "RELATION_EXCEPTION_EXPIRED" as const, ...exception })];
  });
  return Object.freeze(issues.sort((left, right) => compareText(`${left.feature}:${left.relation}`, `${right.feature}:${right.relation}`)));
}

export function assertRelationExceptions(
  application: { readonly graph: { readonly relationExceptions: readonly RegisteredRelationException[] } },
  options: { readonly asOf: Date },
): void {
  const issues = relationExceptionIssues(application.graph, options);
  if (issues.length > 0) {
    throw new Error(`RELATION_EXCEPTION_EXPIRED:${issues.map(({ feature, relation }) => `${feature}.${relation}`).join(",")}`);
  }
}

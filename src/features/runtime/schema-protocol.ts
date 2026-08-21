import { architecture } from "./architecture.js";
import {
  InvalidInput,
  Unexpected,
  normalizeError,
  type ValidationIssue,
  type ValidationPathSegment,
} from "./errors.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "Runtime protocol validation proves unknown metadata, parser results, and adapter issues match their generic types.",
});

export const SCHEMA_PROTOCOL_MARKER = "typescript-on-rails.schema" as const;
export const SCHEMA_PROTOCOL_VERSION = "1" as const;
export const CANONICAL_SCHEMA_VERSION = "1" as const;

const descriptorFailureTrust = new WeakMap<object, boolean>();

export type LiteralValue = string | number | boolean | null;
export type CanonicalJsonValue =
  | LiteralValue
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type SchemaMetadata =
  | { readonly kind: "string" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  | { readonly kind: "date" }
  | { readonly kind: "id"; readonly entity?: string }
  | { readonly kind: "money"; readonly currency: "minor-unit" }
  | { readonly kind: "enum"; readonly values: readonly LiteralValue[] }
  | { readonly kind: "literal"; readonly value: LiteralValue }
  | { readonly kind: "optional"; readonly inner: SchemaMetadata }
  | { readonly kind: "array"; readonly items: SchemaMetadata }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, SchemaMetadata>> }
  | {
      readonly kind: "extension";
      readonly namespace: string;
      readonly name: string;
      readonly version: string;
      readonly payload: CanonicalJsonValue;
      readonly underlying: SchemaMetadata;
    };

export type SchemaParserResult<TValue, TError> =
  | { readonly success: true; readonly value: TValue }
  | { readonly success: false; readonly error: TError };

export interface SchemaProtocolFailure {
  readonly message: string;
  readonly issues: readonly ValidationIssue[];
}

export interface SchemaProtocolDescriptor<
  TValue,
  TMetadata extends SchemaMetadata = SchemaMetadata,
> {
  readonly protocolVersion: typeof SCHEMA_PROTOCOL_VERSION;
  readonly canonicalVersion: typeof CANONICAL_SCHEMA_VERSION;
  readonly metadata: TMetadata;
  parse(
    value: unknown,
    path: readonly ValidationPathSegment[],
  ): SchemaParserResult<TValue, SchemaProtocolFailure>;
}

export interface Schema<TValue, TMetadata extends SchemaMetadata = SchemaMetadata> {
  readonly metadata: TMetadata;
  parse(value: unknown, path?: readonly ValidationPathSegment[]): TValue;
  readonly [SCHEMA_PROTOCOL_MARKER]?: SchemaProtocolDescriptor<TValue, TMetadata>;
  readonly provenance?: SchemaProvenance;
}

export type SchemaProvenance = "protocol" | "legacy";

export interface NormalizedSchema<
  TValue,
  TMetadata extends SchemaMetadata = SchemaMetadata,
> extends Schema<TValue, TMetadata> {
  readonly [SCHEMA_PROTOCOL_MARKER]: SchemaProtocolDescriptor<TValue, TMetadata>;
  readonly provenance: SchemaProvenance;
}

export type SchemaAdapterIssueCode = "invalid_type" | "invalid_value" | "required";

export interface SchemaAdapterIssue {
  readonly path?: readonly ValidationPathSegment[];
  readonly code: SchemaAdapterIssueCode;
  readonly expected?: string;
  readonly received?: string;
}

const ADAPTER_ISSUE_MESSAGES: Readonly<Record<SchemaAdapterIssueCode, string>> = {
  invalid_type: "Invalid type",
  invalid_value: "Invalid value",
  required: "Required value",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function ownKeys(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).sort();
}

export function setOwn<TValue>(target: Record<string, TValue>, key: string, value: TValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function snapshotArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected an array");
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("Expected a valid array length");
  }
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) snapshot[index] = value[index];
  return snapshot;
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && ownKeys(value).every((key) => allowed.has(key));
}

function declarationError(path: readonly ValidationPathSegment[], message: string): InvalidInput {
  return new InvalidInput("Invalid schema protocol", [{
    path,
    code: "invalid_schema",
    message,
  }]);
}

function requireNonEmptyString(value: unknown, path: readonly ValidationPathSegment[]): string {
  if (typeof value !== "string" || value.length === 0) {
    throw declarationError(path, "Expected a non-empty string");
  }
  return value;
}

function canonicalJson(
  value: unknown,
  path: readonly ValidationPathSegment[],
  ancestors: Set<object>,
): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw declarationError(path, "Expected a finite JSON number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) {
    throw declarationError(path, "Expected a canonical JSON value");
  }
  if (ancestors.has(value)) throw declarationError(path, "Canonical JSON must not contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = snapshotArray(value);
      const normalized = new Array<CanonicalJsonValue>(entries.length);
      for (let index = 0; index < entries.length; index += 1) {
        normalized[index] = canonicalJson(entries[index], [...path, index], ancestors);
      }
      return normalized;
    }
    if (!isPlainRecord(value)) throw declarationError(path, "Expected a canonical JSON object");
    const output: Record<string, CanonicalJsonValue> = {};
    for (const key of ownKeys(value)) {
      setOwn(output, key, canonicalJson(value[key], [...path, key], ancestors));
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function invalidNode(path: readonly ValidationPathSegment[], message: string): never {
  throw declarationError(path, message);
}

function canonicalMetadata(
  value: unknown,
  path: readonly ValidationPathSegment[],
  ancestors: Set<object>,
): SchemaMetadata {
  if (!isPlainRecord(value)) invalidNode(path, "Expected schema metadata");
  if (ancestors.has(value)) invalidNode(path, "Schema metadata must not contain cycles");
  ancestors.add(value);
  try {
    const kind = value["kind"];
    if (typeof kind !== "string") invalidNode([...path, "kind"], "Expected a schema metadata kind");
    switch (kind) {
      case "string":
      case "number":
      case "boolean":
      case "date":
        if (!hasOnlyKeys(value, ["kind"])) invalidNode(path, `Invalid ${kind} metadata`);
        return { kind };
      case "id": {
        if (!hasOnlyKeys(value, ["kind"], ["entity"])) invalidNode(path, "Invalid id metadata");
        const entity = value["entity"];
        if (entity === undefined) return { kind: "id" };
        return { kind: "id", entity: requireNonEmptyString(entity, [...path, "entity"]) };
      }
      case "money":
        if (!hasOnlyKeys(value, ["kind", "currency"]) || value["currency"] !== "minor-unit") {
          invalidNode([...path, "currency"], "Expected minor-unit money metadata");
        }
        return { kind: "money", currency: "minor-unit" };
      case "enum": {
        if (!hasOnlyKeys(value, ["kind", "values"]) || !Array.isArray(value["values"])) {
          invalidNode([...path, "values"], "Expected one or more enum values");
        }
        const entries = snapshotArray(value["values"]);
        if (entries.length === 0) invalidNode([...path, "values"], "Expected one or more enum values");
        const values = new Array<LiteralValue>(entries.length);
        for (let index = 0; index < entries.length; index += 1) {
          const normalized = canonicalJson(entries[index], [...path, "values", index], new Set());
          if (normalized !== null && typeof normalized === "object") {
            invalidNode([...path, "values", index], "Expected a literal enum value");
          }
          values[index] = normalized;
        }
        return { kind: "enum", values };
      }
      case "literal": {
        if (!hasOnlyKeys(value, ["kind", "value"])) invalidNode(path, "Invalid literal metadata");
        const literal = canonicalJson(value["value"], [...path, "value"], new Set());
        if (literal !== null && typeof literal === "object") invalidNode([...path, "value"], "Expected a literal value");
        return { kind: "literal", value: literal };
      }
      case "optional":
        if (!hasOnlyKeys(value, ["kind", "inner"])) invalidNode(path, "Invalid optional metadata");
        return { kind: "optional", inner: canonicalMetadata(value["inner"], [...path, "inner"], ancestors) };
      case "array":
        if (!hasOnlyKeys(value, ["kind", "items"])) invalidNode(path, "Invalid array metadata");
        return { kind: "array", items: canonicalMetadata(value["items"], [...path, "items"], ancestors) };
      case "object": {
        if (!hasOnlyKeys(value, ["kind", "fields"]) || !isPlainRecord(value["fields"])) {
          invalidNode([...path, "fields"], "Expected schema fields");
        }
        const fields: Record<string, SchemaMetadata> = {};
        for (const key of ownKeys(value["fields"])) {
          setOwn(fields, key, canonicalMetadata(value["fields"][key], [...path, "fields", key], ancestors));
        }
        return { kind: "object", fields };
      }
      case "extension": {
        if (!hasOnlyKeys(value, ["kind", "namespace", "name", "version", "payload", "underlying"])) {
          invalidNode(path, "Invalid extension metadata");
        }
        return {
          kind: "extension",
          namespace: requireNonEmptyString(value["namespace"], [...path, "namespace"]),
          name: requireNonEmptyString(value["name"], [...path, "name"]),
          version: requireNonEmptyString(value["version"], [...path, "version"]),
          payload: canonicalJson(value["payload"], [...path, "payload"], new Set()),
          underlying: canonicalMetadata(value["underlying"], [...path, "underlying"], ancestors),
        };
      }
      default:
        return invalidNode([...path, "kind"], `Unknown schema metadata kind: ${kind}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? typeof (value as { then?: unknown }).then === "function"
    : false;
}

type InspectedProtocolResult<TValue> =
  | { readonly success: true; readonly value: TValue }
  | { readonly success: false; readonly message: string; readonly issues: readonly unknown[] };

function inspectProtocolResult<TValue>(result: unknown): InspectedProtocolResult<TValue> {
  if (isThenable(result)) throw new TypeError("Schema parser returned a thenable");
  if (!isRecord(result) || typeof result["success"] !== "boolean") {
    throw new TypeError("Schema parser returned an invalid result");
  }
  if (result["success"] === true) {
    if (!Object.hasOwn(result, "value")) throw new TypeError("Schema parser success omitted its value");
    const parsed = result["value"] as TValue;
    if (isThenable(parsed)) throw new TypeError("Schema parser returned a thenable value");
    return { success: true, value: parsed };
  }
  const failure = result["error"];
  if (!isRecord(failure) || typeof failure["message"] !== "string" || !Array.isArray(failure["issues"])) {
    throw new TypeError("Schema parser returned an invalid failure");
  }
  return { success: false, message: failure["message"], issues: failure["issues"] };
}

function parseProtocolResult<TValue>(
  descriptor: SchemaProtocolDescriptor<TValue>,
  value: unknown,
  path: readonly ValidationPathSegment[],
  trustFailureDetails: boolean,
): TValue {
  let result: unknown;
  try {
    result = descriptor.parse(value, path);
  } catch (error) {
    if (trustFailureDetails) throw normalizeError(error);
    throw new Unexpected(undefined, { cause: error });
  }

  let inspected: InspectedProtocolResult<TValue>;
  try {
    inspected = inspectProtocolResult<TValue>(result);
  } catch (error) {
    if (trustFailureDetails) throw normalizeError(error);
    throw new Unexpected(undefined, { cause: error });
  }
  if (inspected.success) return inspected.value;
  if (trustFailureDetails) throw new InvalidInput(inspected.message, inspected.issues as readonly ValidationIssue[]);

  let issues: readonly ValidationIssue[];
  try {
    const rawIssues = snapshotArray(inspected.issues);
    const normalizedIssues = new Array<ValidationIssue>(rawIssues.length);
    for (let index = 0; index < rawIssues.length; index += 1) {
      normalizedIssues[index] = normalizeProtocolIssue(rawIssues[index]);
    }
    issues = normalizedIssues;
  } catch (error) {
    throw new Unexpected(undefined, { cause: error });
  }
  throw new InvalidInput("Invalid input", issues);
}

function schemaFromCanonical<TValue, TMetadata extends SchemaMetadata>(
  metadata: TMetadata,
  parse: SchemaProtocolDescriptor<TValue, TMetadata>["parse"],
  provenance: SchemaProvenance,
  trustFailureDetails = true,
): NormalizedSchema<TValue, TMetadata> {
  const descriptor: SchemaProtocolDescriptor<TValue, TMetadata> = Object.freeze({
    protocolVersion: SCHEMA_PROTOCOL_VERSION,
    canonicalVersion: CANONICAL_SCHEMA_VERSION,
    metadata,
    parse,
  });
  descriptorFailureTrust.set(descriptor, trustFailureDetails);
  return {
    metadata,
    provenance,
    [SCHEMA_PROTOCOL_MARKER]: descriptor,
    parse(input, path = []) {
      return parseProtocolResult(descriptor, input, path, trustFailureDetails);
    },
  };
}

function schemaFromThrowingParser<TValue, TMetadata extends SchemaMetadata>(
  metadata: TMetadata,
  parser: (value: unknown, path: readonly ValidationPathSegment[]) => TValue,
  provenance: SchemaProvenance,
): NormalizedSchema<TValue, TMetadata> {
  return schemaFromCanonical(
    metadata,
    (value, path) => {
      try {
        return { success: true, value: parser(value, path) };
      } catch (error) {
        if (error instanceof InvalidInput) {
          return { success: false, error: { message: error.message, issues: error.issues } };
        }
        throw error;
      }
    },
    provenance,
  );
}

function isExactLegacySchema(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === 2
    && keys.includes("metadata")
    && keys.includes("parse")
    && typeof value["parse"] === "function";
}

export function isSchema(value: unknown): value is Schema<unknown> {
  if (!isRecord(value)) return false;
  return Object.hasOwn(value, SCHEMA_PROTOCOL_MARKER) || isExactLegacySchema(value);
}

export function normalizeSchema<TValue, TMetadata extends SchemaMetadata = SchemaMetadata>(
  value: Schema<TValue, TMetadata>,
): NormalizedSchema<TValue, TMetadata> {
  if (!isRecord(value)) throw declarationError([SCHEMA_PROTOCOL_MARKER], "Expected a schema protocol");
  if (Object.hasOwn(value, SCHEMA_PROTOCOL_MARKER)) {
    const descriptor = value[SCHEMA_PROTOCOL_MARKER];
    if (!isPlainRecord(descriptor)) throw declarationError([SCHEMA_PROTOCOL_MARKER], "Expected a protocol descriptor");
    if (descriptor["protocolVersion"] !== SCHEMA_PROTOCOL_VERSION) {
      throw declarationError([SCHEMA_PROTOCOL_MARKER, "protocolVersion"], "Unsupported schema protocol version");
    }
    if (descriptor["canonicalVersion"] !== CANONICAL_SCHEMA_VERSION) {
      throw declarationError([SCHEMA_PROTOCOL_MARKER, "canonicalVersion"], "Unsupported canonical schema version");
    }
    if (typeof descriptor["parse"] !== "function") {
      throw declarationError([SCHEMA_PROTOCOL_MARKER, "parse"], "Expected a synchronous schema parser");
    }
    const metadata = canonicalMetadata(
      descriptor["metadata"],
      [SCHEMA_PROTOCOL_MARKER, "metadata"],
      new Set(),
    ) as TMetadata;
    return schemaFromCanonical(
      metadata,
      descriptor["parse"] as SchemaProtocolDescriptor<TValue, TMetadata>["parse"],
      "protocol",
      descriptorFailureTrust.get(descriptor) === true,
    );
  }

  if (!isExactLegacySchema(value)) {
    throw declarationError([SCHEMA_PROTOCOL_MARKER], "Expected the schema protocol marker or exact legacy shape");
  }
  const metadata = canonicalMetadata(value["metadata"], ["metadata"], new Set()) as TMetadata;
  const legacyParse = value["parse"] as (input: unknown, path?: readonly ValidationPathSegment[]) => TValue;
  return schemaFromThrowingParser(
    metadata,
    (input, path) => {
      const parsed: unknown = legacyParse(input, path);
      if (isThenable(parsed)) {
        throw new Unexpected(undefined, { cause: new TypeError("Schema parser returned a thenable") });
      }
      return parsed as TValue;
    },
    "legacy",
  );
}

export function createSchema<TValue, const TMetadata extends SchemaMetadata>(
  metadata: TMetadata,
  parser: (value: unknown, path: readonly ValidationPathSegment[]) => TValue,
): NormalizedSchema<TValue, TMetadata> {
  const normalizedMetadata = canonicalMetadata(
    metadata,
    [SCHEMA_PROTOCOL_MARKER, "metadata"],
    new Set(),
  ) as TMetadata;
  return schemaFromThrowingParser(normalizedMetadata, parser, "protocol");
}

function normalizeProtocolIssue(value: unknown): ValidationIssue {
  if (!isPlainRecord(value)) throw new TypeError("Schema parser returned an invalid issue");
  const candidateCode = value["code"];
  const code: SchemaAdapterIssueCode = typeof candidateCode === "string"
    && Object.hasOwn(ADAPTER_ISSUE_MESSAGES, candidateCode)
    ? candidateCode as SchemaAdapterIssueCode
    : "invalid_value";
  return normalizeAdapterIssue({ path: value["path"], code }, []);
}

function normalizeAdapterIssue(
  value: unknown,
  prefix: readonly ValidationPathSegment[],
): ValidationIssue {
  if (!isPlainRecord(value)) throw new TypeError("Schema error mapper returned an invalid issue");
  const candidateCode = value["code"];
  if (typeof candidateCode !== "string" || !Object.hasOwn(ADAPTER_ISSUE_MESSAGES, candidateCode)) {
    throw new TypeError("Schema error mapper returned an invalid issue");
  }
  const code = candidateCode as SchemaAdapterIssueCode;
  const rawRelativePath = value["path"] === undefined ? [] : value["path"];
  const rawPrefix = snapshotArray(prefix);
  const rawPath = snapshotArray(rawRelativePath);
  const normalizedPath = new Array<ValidationPathSegment>(rawPrefix.length + rawPath.length);
  for (let index = 0; index < normalizedPath.length; index += 1) {
    const segment = index < rawPrefix.length ? rawPrefix[index] : rawPath[index - rawPrefix.length];
    if (typeof segment !== "string" && typeof segment !== "number") {
      throw new TypeError("Schema error mapper returned an invalid issue path");
    }
    normalizedPath[index] = segment;
  }
  const expected = value["expected"];
  const received = value["received"];
  if (expected !== undefined && typeof expected !== "string") throw new TypeError("Schema issue expected type must be a string");
  if (received !== undefined && typeof received !== "string") throw new TypeError("Schema issue received type must be a string");
  return {
    path: normalizedPath,
    code,
    message: ADAPTER_ISSUE_MESSAGES[code],
    ...(expected === undefined ? {} : { expected }),
    ...(received === undefined ? {} : { received }),
  };
}

export function adaptSchema<
  TValue,
  TError,
  const TMetadata extends SchemaMetadata,
>(definition: {
  readonly metadata: TMetadata;
  readonly parse: (value: unknown) => SchemaParserResult<TValue, TError>;
  readonly mapError: (error: TError) => readonly SchemaAdapterIssue[];
}): NormalizedSchema<TValue, TMetadata> {
  if (typeof definition.parse !== "function") {
    throw declarationError(["parse"], "Expected a synchronous schema parser");
  }
  if (typeof definition.mapError !== "function") {
    throw declarationError(["mapError"], "Expected a schema error mapper");
  }
  const metadata = canonicalMetadata(definition.metadata, ["metadata"], new Set()) as TMetadata;
  return schemaFromThrowingParser(metadata, (value, path) => {
    let result: unknown;
    try {
      result = definition.parse(value);
    } catch (error) {
      // Vendor callbacks are never trusted to throw a safe public framework error.
      throw new Unexpected(undefined, { cause: error });
    }

    let vendorError: TError;
    try {
      if (isThenable(result)) throw new TypeError("Schema parser returned a thenable");
      if (!isRecord(result) || typeof result["success"] !== "boolean") {
        throw new TypeError("Adapted schema parser returned an invalid result");
      }
      if (result["success"] === true) {
        if (!Object.hasOwn(result, "value")) {
          throw new TypeError("Adapted schema parser success omitted its value");
        }
        const parsed = result["value"] as TValue;
        if (isThenable(parsed)) throw new TypeError("Schema parser returned a thenable value");
        return parsed;
      }
      vendorError = result["error"] as TError;
    } catch (error) {
      throw new Unexpected(undefined, { cause: error });
    }

    let mapped: unknown;
    try {
      mapped = definition.mapError(vendorError);
    } catch (error) {
      // The mapper is also vendor code, including when it throws a FrameworkError.
      throw new Unexpected(undefined, { cause: error });
    }
    let issues: readonly ValidationIssue[];
    try {
      if (isThenable(mapped) || !Array.isArray(mapped)) {
        throw new TypeError("Schema error mapper must return issues synchronously");
      }
      const rawIssues = snapshotArray(mapped);
      const normalizedIssues = new Array<ValidationIssue>(rawIssues.length);
      for (let index = 0; index < rawIssues.length; index += 1) {
        normalizedIssues[index] = normalizeAdapterIssue(rawIssues[index], path);
      }
      issues = normalizedIssues;
    } catch (error) {
      throw new Unexpected(undefined, { cause: error });
    }

    // This framework-created error stays outside both vendor callback catches.
    throw new InvalidInput("Invalid input", issues);
  }, "protocol");
}

import { architecture } from "./architecture.js";
import { InvalidInput, type ValidationIssue, type ValidationPathSegment } from "./errors.js";
import {
  createSchema,
  isRecord,
  normalizeSchema,
  setOwn,
  type LiteralValue,
  type NormalizedSchema,
  type Schema,
  type SchemaMetadata,
} from "./schema-protocol.js";

export {
  CANONICAL_SCHEMA_VERSION,
  SCHEMA_PROTOCOL_MARKER,
  SCHEMA_PROTOCOL_VERSION,
  adaptSchema,
} from "./schema-protocol.js";
export type {
  CanonicalJsonValue,
  LiteralValue,
  NormalizedSchema,
  Schema,
  SchemaAdapterIssue,
  SchemaAdapterIssueCode,
  SchemaMetadata,
  SchemaParserResult,
  SchemaProtocolDescriptor,
  SchemaProtocolFailure,
  SchemaProvenance,
} from "./schema-protocol.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "Runtime validation proves the dynamically assembled object matches its inferred field map.",
});

export type Infer<TSchema extends Schema<unknown>> = TSchema extends Schema<infer TOutput>
  ? TOutput
  : never;

export type SchemaFields = Readonly<Record<string, Schema<unknown>>>;
export type ObjectOutput<TFields extends SchemaFields> = {
  readonly [TKey in keyof TFields]: Infer<TFields[TKey]>;
};
export type SchemaMetadataOf<TSchema extends Schema<unknown>> =
  TSchema extends Schema<unknown, infer TMetadata> ? TMetadata : never;
export type ObjectSchemaMetadata<TFields extends SchemaFields> = {
  readonly kind: "object";
  readonly fields: { readonly [TKey in keyof TFields]: SchemaMetadataOf<TFields[TKey]> };
};

function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}

function issue(
  path: readonly ValidationPathSegment[],
  message: string,
  expected: string,
  value: unknown,
): InvalidInput {
  return new InvalidInput(message, [{ path, message, expected, received: receivedType(value) }]);
}

export function string(): NormalizedSchema<string, { readonly kind: "string" }> {
  return createSchema({ kind: "string" }, (value, path) => {
    if (typeof value !== "string") throw issue(path, "Expected a string", "string", value);
    return value;
  });
}

export function number(): NormalizedSchema<number, { readonly kind: "number" }> {
  return createSchema({ kind: "number" }, (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw issue(path, "Expected a finite number", "finite number", value);
    }
    return value;
  });
}

export function boolean(): NormalizedSchema<boolean, { readonly kind: "boolean" }> {
  return createSchema({ kind: "boolean" }, (value, path) => {
    if (typeof value !== "boolean") throw issue(path, "Expected a boolean", "boolean", value);
    return value;
  });
}

export function date(): NormalizedSchema<Date, { readonly kind: "date" }> {
  return createSchema({ kind: "date" }, (value, path) => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw issue(path, "Expected a valid Date", "Date", value);
    }
    return value;
  });
}

export function id(): NormalizedSchema<string, { readonly kind: "id" }>;
export function id<const TEntity extends string>(entityName: TEntity): NormalizedSchema<string, { readonly kind: "id"; readonly entity: TEntity }>;
export function id(entityName?: string): NormalizedSchema<string, { readonly kind: "id"; readonly entity?: string }> {
  const metadata = entityName === undefined
    ? { kind: "id" } as const
    : { kind: "id", entity: entityName } as const;

  return createSchema(metadata, (value, path) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw issue(path, "Expected a non-empty identifier", "non-empty string", value);
    }
    return value;
  });
}

export function money(): NormalizedSchema<number, { readonly kind: "money"; readonly currency: "minor-unit" }> {
  return createSchema({ kind: "money", currency: "minor-unit" }, (value, path) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw issue(path, "Expected a non-negative integer money amount", "minor-unit integer", value);
    }
    return value;
  });
}

function isEnumValue<const TValues extends readonly LiteralValue[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.some((candidate) => Object.is(candidate, value));
}

export function enumOf<const TValues extends readonly [LiteralValue, ...LiteralValue[]]>(
  ...values: TValues
): NormalizedSchema<TValues[number], { readonly kind: "enum"; readonly values: TValues }> {
  return createSchema({ kind: "enum", values }, (value, path) => {
    if (!isEnumValue(values, value)) {
      throw issue(path, `Expected one of: ${values.join(", ")}`, "enum value", value);
    }
    return value;
  });
}

export function literal<const TValue extends LiteralValue>(
  value: TValue,
): NormalizedSchema<TValue, { readonly kind: "literal"; readonly value: TValue }> {
  return createSchema({ kind: "literal", value }, (input, path) => {
    if (!Object.is(input, value)) {
      throw issue(path, `Expected literal ${String(value)}`, JSON.stringify(value), input);
    }
    return value;
  });
}

export function optional<TValue, const TMetadata extends SchemaMetadata>(
  inner: Schema<TValue, TMetadata>,
): NormalizedSchema<TValue | undefined, { readonly kind: "optional"; readonly inner: TMetadata }> {
  const normalizedInner = normalizeSchema(inner);
  return createSchema({ kind: "optional", inner: normalizedInner.metadata }, (value, path) => {
    if (value === undefined) return undefined;
    return normalizedInner.parse(value, path);
  });
}

export function array<TValue, const TMetadata extends SchemaMetadata>(
  items: Schema<TValue, TMetadata>,
): NormalizedSchema<readonly TValue[], { readonly kind: "array"; readonly items: TMetadata }> {
  const normalizedItems = normalizeSchema(items);
  return createSchema({ kind: "array", items: normalizedItems.metadata }, (value, path) => {
    if (!Array.isArray(value)) throw issue(path, "Expected an array", "array", value);

    const output: TValue[] = [];
    const issues: ValidationIssue[] = [];
    for (const [index, item] of value.entries()) {
      try {
        output.push(normalizedItems.parse(item, [...path, index]));
      } catch (error) {
        if (error instanceof InvalidInput) issues.push(...error.issues);
        else throw error;
      }
    }
    if (issues.length > 0) throw new InvalidInput("Invalid array", issues);
    return output;
  });
}

export function object<const TFields extends SchemaFields>(
  fields: TFields,
): NormalizedSchema<ObjectOutput<TFields>, ObjectSchemaMetadata<TFields>> {
  const normalizedFields: Record<string, Schema<unknown>> = {};
  const fieldMetadata: Record<string, SchemaMetadata> = {};
  for (const [name, field] of Object.entries(fields)) {
    const normalized = normalizeSchema(field);
    setOwn(normalizedFields, name, normalized);
    setOwn(fieldMetadata, name, normalized.metadata);
  }

  return createSchema(
    { kind: "object", fields: fieldMetadata } as ObjectSchemaMetadata<TFields>,
    (value, path) => {
      if (!isRecord(value)) throw issue(path, "Expected an object", "object", value);

      const output: Record<string, unknown> = {};
      const issues: ValidationIssue[] = [];
      for (const [name, field] of Object.entries(normalizedFields)) {
        try {
          setOwn(output, name, field.parse(value[name], [...path, name]));
        } catch (error) {
          if (error instanceof InvalidInput) issues.push(...error.issues);
          else throw error;
        }
      }
      if (issues.length > 0) throw new InvalidInput("Invalid object", issues);
      return output as ObjectOutput<TFields>;
    },
  );
}

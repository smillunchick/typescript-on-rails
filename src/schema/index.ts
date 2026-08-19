import { InvalidInput, type ValidationIssue, type ValidationPathSegment } from "../errors.js";

export type LiteralValue = string | number | boolean | null;

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
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, SchemaMetadata>> };

export interface Schema<T> {
  readonly metadata: SchemaMetadata;
  parse(value: unknown, path?: readonly ValidationPathSegment[]): T;
}

export type Infer<TSchema extends Schema<unknown>> = TSchema extends Schema<infer TOutput>
  ? TOutput
  : never;

export type SchemaFields = Readonly<Record<string, Schema<unknown>>>;
export type ObjectOutput<TFields extends SchemaFields> = {
  readonly [TKey in keyof TFields]: Infer<TFields[TKey]>;
};

function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  path: readonly ValidationPathSegment[],
  message: string,
  expected: string,
  value: unknown,
): InvalidInput {
  return new InvalidInput(message, [{ path, message, expected, received: receivedType(value) }]);
}

function schema<T>(
  metadata: SchemaMetadata,
  parser: (value: unknown, path: readonly ValidationPathSegment[]) => T,
): Schema<T> {
  return {
    metadata,
    parse(value, path = []) {
      return parser(value, path);
    },
  };
}

export function string(): Schema<string> {
  return schema({ kind: "string" }, (value, path) => {
    if (typeof value !== "string") throw issue(path, "Expected a string", "string", value);
    return value;
  });
}

export function number(): Schema<number> {
  return schema({ kind: "number" }, (value, path) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw issue(path, "Expected a finite number", "finite number", value);
    }
    return value;
  });
}

export function boolean(): Schema<boolean> {
  return schema({ kind: "boolean" }, (value, path) => {
    if (typeof value !== "boolean") throw issue(path, "Expected a boolean", "boolean", value);
    return value;
  });
}

export function date(): Schema<Date> {
  return schema({ kind: "date" }, (value, path) => {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw issue(path, "Expected a valid Date", "Date", value);
    }
    return value;
  });
}

export function id(entityName?: string): Schema<string> {
  const metadata: SchemaMetadata = entityName === undefined
    ? { kind: "id" }
    : { kind: "id", entity: entityName };

  return schema(metadata, (value, path) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw issue(path, "Expected a non-empty identifier", "non-empty string", value);
    }
    return value;
  });
}

export function money(): Schema<number> {
  return schema({ kind: "money", currency: "minor-unit" }, (value, path) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw issue(path, "Expected a non-negative integer money amount", "minor-unit integer", value);
    }
    return value;
  });
}

export function enumOf<const TValues extends readonly [LiteralValue, ...LiteralValue[]]>(
  ...values: TValues
): Schema<TValues[number]> {
  return schema({ kind: "enum", values }, (value, path) => {
    if (!values.some((candidate) => Object.is(candidate, value))) {
      throw issue(path, `Expected one of: ${values.join(", ")}`, "enum value", value);
    }
    return value as TValues[number];
  });
}

export function literal<const TValue extends LiteralValue>(value: TValue): Schema<TValue> {
  return schema({ kind: "literal", value }, (input, path) => {
    if (!Object.is(input, value)) {
      throw issue(path, `Expected literal ${String(value)}`, JSON.stringify(value), input);
    }
    return value;
  });
}

export function optional<TValue>(inner: Schema<TValue>): Schema<TValue | undefined> {
  return schema({ kind: "optional", inner: inner.metadata }, (value, path) => {
    if (value === undefined) return undefined;
    return inner.parse(value, path);
  });
}

export function array<TValue>(items: Schema<TValue>): Schema<readonly TValue[]> {
  return schema({ kind: "array", items: items.metadata }, (value, path) => {
    if (!Array.isArray(value)) throw issue(path, "Expected an array", "array", value);

    const output: TValue[] = [];
    const issues: ValidationIssue[] = [];
    for (const [index, item] of value.entries()) {
      try {
        output.push(items.parse(item, [...path, index]));
      } catch (error) {
        if (error instanceof InvalidInput) issues.push(...error.issues);
        else throw error;
      }
    }
    if (issues.length > 0) throw new InvalidInput("Invalid array", issues);
    return output;
  });
}

export function object<const TFields extends SchemaFields>(fields: TFields): Schema<ObjectOutput<TFields>> {
  const fieldMetadata: Record<string, SchemaMetadata> = {};
  for (const [name, field] of Object.entries(fields)) fieldMetadata[name] = field.metadata;

  return schema({ kind: "object", fields: fieldMetadata }, (value, path) => {
    if (!isRecord(value)) {
      throw issue(path, "Expected an object", "object", value);
    }

    const input = value;
    const output: Record<string, unknown> = {};
    const issues: ValidationIssue[] = [];
    for (const [name, field] of Object.entries(fields)) {
      try {
        output[name] = field.parse(input[name], [...path, name]);
      } catch (error) {
        if (error instanceof InvalidInput) issues.push(...error.issues);
        else throw error;
      }
    }
    if (issues.length > 0) throw new InvalidInput("Invalid object", issues);
    return output as ObjectOutput<TFields>;
  });
}

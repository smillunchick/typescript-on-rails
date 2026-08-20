import { InvalidInput, type ValidationIssue } from "./errors.js";
import { object, type ObjectOutput, type Schema, type SchemaFields, type SchemaMetadata } from "./schema.js";
import { normalizeSchema } from "./schema-protocol.js";

export interface Invariant<TValue> {
  readonly name: string;
  readonly valueType?: TValue;
  test(value: TValue): boolean;
}

export interface ModelMetadata {
  readonly kind: "model";
  readonly name: string;
  readonly fields: Readonly<Record<string, SchemaMetadata>>;
  readonly invariants: readonly string[];
}

export interface Model<TFields extends SchemaFields> {
  readonly name: string;
  readonly fields: TFields;
  readonly metadata: ModelMetadata;
  parse(value: unknown): ObjectOutput<TFields>;
  validate(value: unknown): ObjectOutput<TFields>;
}

export function invariant<TValue>(name: string, predicate: (value: TValue) => boolean): Invariant<TValue> {
  return { name, test: predicate };
}

export function defineModel<const TFields extends SchemaFields>(definition: {
  readonly name: string;
  readonly fields: TFields;
  readonly invariants?: readonly Invariant<ObjectOutput<TFields>>[];
}): Model<TFields> {
  const normalizedFields: Record<string, Schema<unknown>> = {};
  for (const [name, field] of Object.entries(definition.fields)) {
    normalizedFields[name] = normalizeSchema(field);
  }
  const fields = normalizedFields as TFields;
  const modelSchema = object(fields);
  const invariants = definition.invariants ?? [];

  const validate = (value: unknown): ObjectOutput<TFields> => {
    const parsed = modelSchema.parse(value);
    const issues: ValidationIssue[] = [];
    for (const rule of invariants) {
      if (!rule.test(parsed)) {
        issues.push({ path: [], message: `Invariant failed: ${rule.name}` });
      }
    }
    if (issues.length > 0) {
      throw new InvalidInput(issues.map((entry) => entry.message).join("; "), issues);
    }
    return parsed;
  };

  const metadata: ModelMetadata = {
    kind: "model",
    name: definition.name,
    fields: modelSchema.metadata.kind === "object" ? modelSchema.metadata.fields : {},
    invariants: invariants.map((rule) => rule.name),
  };

  return {
    name: definition.name,
    fields,
    metadata,
    parse: validate,
    validate,
  };
}

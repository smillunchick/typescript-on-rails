const SECRET = Symbol("SecretReference");

export interface SecretReference {
  readonly [SECRET]: true;
  readonly name: string;
  toString(): "[secret]";
  toJSON(): "[secret]";
}

export function secretReference(name: string): SecretReference {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new TypeError(`Invalid secret name: ${name}`);
  return Object.freeze({ [SECRET]: true as const, name, toString: () => "[secret]" as const, toJSON: () => "[secret]" as const });
}

export interface SecretResolver {
  resolve(reference: SecretReference): Promise<string>;
}

export type ConfigField =
  | { readonly kind: "string"; readonly required?: boolean; readonly default?: string; readonly validate?: (value: string) => boolean }
  | { readonly kind: "integer"; readonly required?: boolean; readonly default?: number; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: "boolean"; readonly required?: boolean; readonly default?: boolean }
  | { readonly kind: "secret"; readonly required?: boolean };

export type ConfigShape = Readonly<Record<string, ConfigField>>;
type ConfigValue<TField extends ConfigField> =
  TField extends { kind: "integer" }
    ? number
    : TField extends { kind: "boolean" }
      ? boolean
      : TField extends { kind: "secret" }
        ? SecretReference
        : string;
type ConfigValueWithPresence<TField extends ConfigField> =
  TField extends { required: true }
    ? ConfigValue<TField>
    : TField extends { default: string | number | boolean }
      ? ConfigValue<TField>
      : ConfigValue<TField> | undefined;
export type ParsedConfig<TShape extends ConfigShape> = Readonly<{
  [K in keyof TShape]: ConfigValueWithPresence<TShape[K]>;
}>;

export class ConfigurationError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`Invalid configuration: ${fields.join(", ")}`);
    this.name = "ConfigurationError";
    this.fields = Object.freeze([...fields]);
  }
}

export function parseConfig<const TShape extends ConfigShape>(shape: TShape, environment: Readonly<Record<string, string | undefined>>): ParsedConfig<TShape> {
  const output: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const raw = environment[name];
    if (field.kind === "secret") {
      if (raw === undefined || raw === "") {
        if (field.required) invalid.push(name);
        output[name] = undefined;
      } else output[name] = secretReference(name);
      continue;
    }
    if (raw === undefined || raw === "") {
      if (field.default !== undefined) output[name] = field.default;
      else {
        if (field.required) invalid.push(name);
        output[name] = undefined;
      }
      continue;
    }
    if (field.kind === "string") {
      if (field.validate !== undefined && !field.validate(raw)) invalid.push(name);
      else output[name] = raw;
    } else if (field.kind === "boolean") {
      if (raw !== "true" && raw !== "false") invalid.push(name);
      else output[name] = raw === "true";
    } else {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) invalid.push(name);
      else output[name] = value;
    }
  }
  if (invalid.length > 0) throw new ConfigurationError(invalid.sort());
  return Object.freeze(output) as ParsedConfig<TShape>;
}

export function environmentSecretResolver(environment: Readonly<Record<string, string | undefined>>): SecretResolver {
  return Object.freeze({
    async resolve(reference: SecretReference) {
      const value = environment[reference.name];
      if (value === undefined || value === "") throw new ConfigurationError([reference.name]);
      return value;
    },
  });
}

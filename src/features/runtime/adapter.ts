import { architecture } from "./architecture.js";
import type { Infer, Schema, SchemaMetadata } from "./schema.js";
import { normalizeSchema } from "./schema-protocol.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "Runtime schema validation rebuilds adapter operation maps and preserves typed compatibility accessors.",
});

type MaybePromise<TValue> = TValue | Promise<TValue>;

export const ADAPTER_PROTOCOL_MARKER = "typescript-on-rails.adapter" as const;
export const ADAPTER_PROTOCOL_VERSION = 1 as const;

export type AdapterSuitability = "local-only" | "production";

export interface AdapterOperationDefinition<TInput extends Schema<unknown>, TOutput extends Schema<unknown>> {
  readonly input: TInput;
  readonly output: TOutput;
}

export type AdapterOperations = Readonly<Record<string, AdapterOperationDefinition<Schema<unknown>, Schema<unknown>>>>;

export interface AdapterContractMetadata {
  readonly kind: "adapter-contract";
  readonly name: string;
  readonly operations: Readonly<Record<string, { readonly input: SchemaMetadata; readonly output: SchemaMetadata }>>;
}

export interface AnyAdapterContract {
  readonly [ADAPTER_PROTOCOL_MARKER]: typeof ADAPTER_PROTOCOL_VERSION;
  readonly name: string;
  readonly operations: Readonly<Record<string, unknown>>;
  readonly metadata: AdapterContractMetadata;
}

export interface AdapterContract<TOperations extends AdapterOperations> extends AnyAdapterContract {
  readonly operations: TOperations;
}

export type AdapterImplementation<TOperations extends AdapterOperations> = {
  readonly [TName in keyof TOperations]: TOperations[TName] extends AdapterOperationDefinition<infer TInput, infer TOutput>
    ? (input: Infer<TInput>) => MaybePromise<Infer<TOutput>>
    : never;
};

export type AdapterRuntimeOperations<TOperations extends AdapterOperations> = {
  readonly [TName in keyof TOperations]: TOperations[TName] extends AdapterOperationDefinition<infer TInput, infer TOutput>
    ? (input: Infer<TInput>) => Promise<Infer<TOutput>>
    : never;
};

export interface AdapterInstanceMetadata {
  readonly kind: "adapter";
  readonly name: string;
  readonly provider: string;
  readonly suitability: AdapterSuitability;
  readonly operations: Readonly<Record<string, { readonly input: SchemaMetadata; readonly output: SchemaMetadata }>>;
}

export interface AnyAdapterInstance {
  readonly [ADAPTER_PROTOCOL_MARKER]: typeof ADAPTER_PROTOCOL_VERSION;
  readonly contract: AnyAdapterContract;
  readonly operations: Readonly<Record<string, unknown>>;
  readonly provider: string;
  readonly suitability: AdapterSuitability;
  readonly metadata: AdapterInstanceMetadata;
}

export interface AdapterInstance<TOperations extends AdapterOperations> extends AnyAdapterInstance {
  readonly contract: AdapterContract<TOperations>;
  readonly operations: AdapterRuntimeOperations<TOperations>;
}

export type AdapterInstanceOf<TContract extends AnyAdapterContract> =
  TContract extends AdapterContract<infer TOperations> ? AdapterInstance<TOperations> : never;

export function isAdapterContract(value: unknown): value is AnyAdapterContract {
  return typeof value === "object"
    && value !== null
    && ADAPTER_PROTOCOL_MARKER in value
    && value[ADAPTER_PROTOCOL_MARKER] === ADAPTER_PROTOCOL_VERSION
    && "metadata" in value
    && typeof value.metadata === "object"
    && value.metadata !== null
    && "kind" in value.metadata
    && value.metadata.kind === "adapter-contract";
}

export function isAdapterInstance(value: unknown): value is AnyAdapterInstance {
  return typeof value === "object"
    && value !== null
    && ADAPTER_PROTOCOL_MARKER in value
    && value[ADAPTER_PROTOCOL_MARKER] === ADAPTER_PROTOCOL_VERSION
    && "contract" in value
    && isAdapterContract(value.contract)
    && "metadata" in value
    && typeof value.metadata === "object"
    && value.metadata !== null
    && "kind" in value.metadata
    && value.metadata.kind === "adapter";
}

export function defineAdapterContract<const TOperations extends AdapterOperations>(definition: {
  readonly name: string;
  readonly operations: TOperations;
}): AdapterContract<TOperations> {
  if (definition.name.trim() === "") throw new TypeError("ADAPTER_CONTRACT_NAME_INVALID");
  const normalizedOperations: Record<string, AdapterOperationDefinition<Schema<unknown>, Schema<unknown>>> = {};
  const operations: Record<string, { input: SchemaMetadata; output: SchemaMetadata }> = {};
  for (const [name, operation] of Object.entries(definition.operations)) {
    if (name.trim() === "") throw new TypeError("ADAPTER_OPERATION_NAME_INVALID");
    const input = normalizeSchema(operation.input);
    const output = normalizeSchema(operation.output);
    normalizedOperations[name] = Object.freeze({ input, output });
    operations[name] = Object.freeze({ input: input.metadata, output: output.metadata });
  }
  return Object.freeze({
    [ADAPTER_PROTOCOL_MARKER]: ADAPTER_PROTOCOL_VERSION,
    name: definition.name,
    operations: Object.freeze(normalizedOperations) as TOperations,
    metadata: Object.freeze({
      kind: "adapter-contract" as const,
      name: definition.name,
      operations: Object.freeze(operations),
    }),
  });
}

export function implementAdapter<const TOperations extends AdapterOperations>(
  contract: AdapterContract<TOperations>,
  implementation: AdapterImplementation<TOperations>,
  options: { readonly provider: string; readonly suitability: AdapterSuitability },
): AdapterInstance<TOperations> {
  if (!isAdapterContract(contract)) throw new TypeError("ADAPTER_CONTRACT_INVALID");
  if (!/^[a-z][a-z0-9-]*$/.test(options.provider)) throw new TypeError(`INVALID_ADAPTER_PROVIDER:${options.provider}`);
  if (options.suitability !== "local-only" && options.suitability !== "production") throw new TypeError("INVALID_ADAPTER_SUITABILITY");
  const validatedOperations: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const [name, operation] of Object.entries(contract.operations)) {
    const implementedOperation: unknown = implementation[name];
    if (typeof implementedOperation !== "function") {
      throw new TypeError(`Adapter ${contract.name} must implement operation ${name}`);
    }
    validatedOperations[name] = async (input) => {
      const parsedInput = operation.input.parse(input);
      const output = await implementedOperation(parsedInput);
      return operation.output.parse(output);
    };
  }
  return Object.freeze({
    [ADAPTER_PROTOCOL_MARKER]: ADAPTER_PROTOCOL_VERSION,
    contract,
    operations: Object.freeze(validatedOperations) as AdapterRuntimeOperations<TOperations>,
    provider: options.provider,
    suitability: options.suitability,
    metadata: Object.freeze({
      kind: "adapter" as const,
      name: contract.name,
      provider: options.provider,
      suitability: options.suitability,
      operations: contract.metadata.operations,
    }),
  });
}

const RESERVED_ACCESSORS = new Set<PropertyKey>([
  ADAPTER_PROTOCOL_MARKER,
  "contract",
  "operations",
  "provider",
  "suitability",
  "metadata",
]);

export function withAdapterAccessors<TOperations extends AdapterOperations, TAccessors extends object>(
  instance: AdapterInstance<TOperations>,
  accessors: TAccessors,
): AdapterInstance<TOperations> & TAccessors {
  const descriptors = Object.getOwnPropertyDescriptors(accessors);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (RESERVED_ACCESSORS.has(key)) throw new TypeError(`ADAPTER_ACCESSOR_CONFLICT:${String(key)}`);
  }
  return Object.freeze(Object.defineProperties({ ...instance }, descriptors)) as AdapterInstance<TOperations> & TAccessors;
}

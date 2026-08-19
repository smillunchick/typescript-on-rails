import type { Infer, Schema, SchemaMetadata } from "../schema/index.js";

type MaybePromise<TValue> = TValue | Promise<TValue>;

export interface AdapterOperationDefinition<TInput extends Schema<unknown>, TOutput extends Schema<unknown>> {
  readonly input: TInput;
  readonly output: TOutput;
}

export type AdapterOperations = Readonly<Record<string, AdapterOperationDefinition<Schema<unknown>, Schema<unknown>>>>;

export interface AdapterContract<TOperations extends AdapterOperations> {
  readonly name: string;
  readonly operations: TOperations;
  readonly metadata: {
    readonly kind: "adapter-contract";
    readonly name: string;
    readonly operations: Readonly<Record<string, { readonly input: SchemaMetadata; readonly output: SchemaMetadata }>>;
  };
}

export type AdapterImplementation<TOperations extends AdapterOperations> = {
  readonly [TName in keyof TOperations]: TOperations[TName] extends AdapterOperationDefinition<infer TInput, infer TOutput>
    ? (input: Infer<TInput>) => MaybePromise<Infer<TOutput>>
    : never;
};

export interface AdapterInstance<TOperations extends AdapterOperations> {
  readonly contract: AdapterContract<TOperations>;
  readonly operations: AdapterImplementation<TOperations>;
  readonly metadata: {
    readonly kind: "adapter";
    readonly name: string;
    readonly operations: Readonly<Record<string, { readonly input: SchemaMetadata; readonly output: SchemaMetadata }>>;
  };
}

export function defineAdapterContract<const TOperations extends AdapterOperations>(definition: {
  readonly name: string;
  readonly operations: TOperations;
}): AdapterContract<TOperations> {
  const operations: Record<string, { input: SchemaMetadata; output: SchemaMetadata }> = {};
  for (const [name, operation] of Object.entries(definition.operations)) {
    operations[name] = { input: operation.input.metadata, output: operation.output.metadata };
  }
  return {
    name: definition.name,
    operations: definition.operations,
    metadata: { kind: "adapter-contract", name: definition.name, operations },
  };
}

export function implementAdapter<const TOperations extends AdapterOperations>(
  contract: AdapterContract<TOperations>,
  implementation: AdapterImplementation<TOperations>,
): AdapterInstance<TOperations> {
  return {
    contract,
    operations: implementation,
    metadata: {
      kind: "adapter",
      name: contract.name,
      operations: contract.metadata.operations,
    },
  };
}

import { architecture } from "./architecture.js";
import type { Infer, Schema, SchemaMetadata } from "./schema.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "Runtime schema validation rebuilds the adapter contract's mapped operation type.",
});

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

  return {
    contract,
    operations: validatedOperations as AdapterImplementation<TOperations>,
    metadata: {
      kind: "adapter",
      name: contract.name,
      operations: contract.metadata.operations,
    },
  };
}

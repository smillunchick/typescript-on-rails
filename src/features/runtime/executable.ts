import { architecture } from "./architecture.js";
import { Forbidden, InvalidInput, normalizeError } from "./errors.js";
import {
  object,
  type Infer,
  type ObjectOutput,
  type Schema,
  type SchemaFields,
  type SchemaMetadata,
} from "./schema.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "The schema-or-fields branch preserves a generic input relation that TypeScript cannot narrow.",
});

export interface ExecutionContext {
  readonly permissions: ReadonlySet<string>;
}

export type InputDefinition = Schema<unknown> | SchemaFields;
export type InputFrom<TDefinition extends InputDefinition> =
  TDefinition extends Schema<unknown>
    ? Infer<TDefinition>
    : TDefinition extends SchemaFields
      ? ObjectOutput<TDefinition>
      : never;

type MaybePromise<TValue> = TValue | Promise<TValue>;

type AccessRule<TInput, TContext extends ExecutionContext> =
  | { readonly permission: string; readonly authorize?: never; readonly public?: never }
  | {
      readonly authorize: (input: TInput, context: TContext) => MaybePromise<boolean>;
      readonly permission?: never;
      readonly public?: never;
    }
  | { readonly public: true; readonly permission?: never; readonly authorize?: never };

interface OperationShape<TInputDefinition extends InputDefinition, TResult, TContext extends ExecutionContext> {
  readonly input: TInputDefinition;
  readonly output?: Schema<TResult>;
  readonly run: (input: InputFrom<TInputDefinition>, context: TContext) => MaybePromise<TResult>;
}

export type OperationConfig<
  TInputDefinition extends InputDefinition,
  TResult,
  TContext extends ExecutionContext,
> = OperationShape<TInputDefinition, TResult, TContext> & AccessRule<InputFrom<TInputDefinition>, TContext>;

export interface ExecutableMetadata {
  readonly kind: "action" | "query";
  readonly input: SchemaMetadata;
  readonly output?: SchemaMetadata;
  readonly access:
    | { readonly type: "public" }
    | { readonly type: "permission"; readonly permission: string }
    | { readonly type: "authorize" };
}

export interface Executable<TInput, TResult, TContext extends ExecutionContext> {
  readonly metadata: ExecutableMetadata;
  execute(input: unknown, context: TContext): Promise<TResult>;
}

function isSchema(value: InputDefinition): value is Schema<unknown> {
  return "parse" in value && typeof value.parse === "function" && "metadata" in value;
}

function normalizeInput<TInputDefinition extends InputDefinition>(
  input: TInputDefinition,
): Schema<InputFrom<TInputDefinition>> {
  if (isSchema(input)) return input as Schema<InputFrom<TInputDefinition>>;
  return object(input) as Schema<InputFrom<TInputDefinition>>;
}

function accessMetadata<TInput, TContext extends ExecutionContext>(
  definition: AccessRule<TInput, TContext>,
): ExecutableMetadata["access"] {
  const hasPermission = typeof definition.permission === "string";
  const hasAuthorize = typeof definition.authorize === "function";
  const isPublic = definition.public === true;
  if (Number(hasPermission) + Number(hasAuthorize) + Number(isPublic) !== 1) {
    throw new InvalidInput("An operation must declare exactly one access decision");
  }
  if (hasPermission) return { type: "permission", permission: definition.permission };
  if (hasAuthorize) return { type: "authorize" };
  return { type: "public" };
}

async function authorize<TInput, TContext extends ExecutionContext>(
  definition: AccessRule<TInput, TContext>,
  input: TInput,
  context: TContext,
): Promise<void> {
  if (typeof definition.permission === "string" && !context.permissions.has(definition.permission)) {
    throw new Forbidden(`Missing permission: ${definition.permission}`);
  }
  if (typeof definition.authorize === "function" && !(await definition.authorize(input, context))) {
    throw new Forbidden();
  }
}

export function createExecutable<
  TInputDefinition extends InputDefinition,
  TResult,
  TContext extends ExecutionContext,
>(
  kind: "action" | "query",
  definition: OperationConfig<TInputDefinition, TResult, TContext>,
): Executable<InputFrom<TInputDefinition>, TResult, TContext> {
  const inputSchema = normalizeInput(definition.input);
  const access = accessMetadata(definition);
  const metadata: ExecutableMetadata = definition.output === undefined
    ? { kind, input: inputSchema.metadata, access }
    : { kind, input: inputSchema.metadata, output: definition.output.metadata, access };

  return {
    metadata,
    async execute(input, context) {
      try {
        const parsedInput = inputSchema.parse(input);
        await authorize(definition, parsedInput, context);
        const result = await definition.run(parsedInput, context);
        return definition.output === undefined ? result : definition.output.parse(result);
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

export function action<
  TInputDefinition extends InputDefinition,
  TResult,
  TContext extends ExecutionContext = ExecutionContext,
>(definition: OperationConfig<TInputDefinition, TResult, TContext>): Executable<InputFrom<TInputDefinition>, TResult, TContext> {
  return createExecutable("action", definition);
}

export function query<
  TInputDefinition extends InputDefinition,
  TResult,
  TContext extends ExecutionContext = ExecutionContext,
>(definition: OperationConfig<TInputDefinition, TResult, TContext>): Executable<InputFrom<TInputDefinition>, TResult, TContext> {
  return createExecutable("query", definition);
}

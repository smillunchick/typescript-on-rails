import { architecture } from "./architecture.js";
import { Forbidden, InvalidInput, normalizeError } from "./errors.js";
import { object, type Infer, type ObjectOutput, type Schema, type SchemaFields, type SchemaMetadata } from "./schema.js";
import { isSchema, normalizeSchema } from "./schema-protocol.js";
import type { ExecutionContext } from "./executable.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "Runtime input validation restores the route's conditional generic input type.",
});

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type MaybePromise<TValue> = TValue | Promise<TValue>;
type RouteInputDefinition = Schema<unknown> | SchemaFields | undefined;
type RouteInput<TDefinition extends RouteInputDefinition> = TDefinition extends Schema<unknown>
  ? Infer<TDefinition>
  : TDefinition extends SchemaFields
    ? ObjectOutput<TDefinition>
    : undefined;

type RouteAccess<TInput, TContext extends ExecutionContext> =
  | { readonly permission: string; readonly authorize?: never; readonly public?: never }
  | { readonly authorize: (input: TInput, context: TContext) => MaybePromise<boolean>; readonly permission?: never; readonly public?: never }
  | { readonly public: true; readonly permission?: never; readonly authorize?: never };

export interface RouteMetadata {
  readonly kind: "route";
  readonly method: RouteMethod;
  readonly path: string;
  readonly input?: SchemaMetadata;
  readonly output?: SchemaMetadata;
  readonly access: "public" | "permission" | "authorize";
  readonly permission?: string;
}

export interface RouteDefinition<TInput, TResult, TContext extends ExecutionContext> {
  readonly metadata: RouteMetadata;
  execute(input: unknown, context: TContext): Promise<TResult>;
}

export function route<
  TInputDefinition extends RouteInputDefinition = undefined,
  TResult = unknown,
  TContext extends ExecutionContext = ExecutionContext,
>(definition: {
  readonly method: RouteMethod;
  readonly path: string;
  readonly input?: TInputDefinition;
  readonly output?: Schema<TResult>;
  readonly handler: (input: RouteInput<TInputDefinition>, context: TContext) => MaybePromise<TResult>;
} & RouteAccess<RouteInput<TInputDefinition>, TContext>): RouteDefinition<RouteInput<TInputDefinition>, TResult, TContext> {
  const inputSchema: Schema<unknown> | undefined = definition.input === undefined
    ? undefined
    : isSchema(definition.input)
      ? normalizeSchema(definition.input)
      : object(definition.input);
  const outputSchema = definition.output === undefined ? undefined : normalizeSchema(definition.output);
  const hasPermission = typeof definition.permission === "string";
  const hasAuthorize = typeof definition.authorize === "function";
  const isPublic = definition.public === true;
  if (Number(hasPermission) + Number(hasAuthorize) + Number(isPublic) !== 1) {
    throw new InvalidInput("A route must declare exactly one access decision");
  }

  const access = hasPermission ? "permission" : hasAuthorize ? "authorize" : "public";
  const metadata: RouteMetadata = {
    kind: "route",
    method: definition.method,
    path: definition.path,
    ...(inputSchema === undefined ? {} : { input: inputSchema.metadata }),
    ...(outputSchema === undefined ? {} : { output: outputSchema.metadata }),
    access,
    ...(hasPermission ? { permission: definition.permission } : {}),
  };

  return {
    metadata,
    async execute(input, context) {
      try {
        if (hasPermission && !context.permissions.has(definition.permission)) {
          throw new Forbidden(`Missing permission: ${definition.permission}`);
        }
        // This assertion restores the generic relation after runtime schema dispatch.
        const parsedInput = (inputSchema === undefined ? undefined : inputSchema.parse(input)) as RouteInput<TInputDefinition>;
        if (hasAuthorize && !(await definition.authorize(parsedInput, context))) {
          throw new Forbidden();
        }
        const result = await definition.handler(parsedInput, context);
        return outputSchema === undefined ? result : outputSchema.parse(result);
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

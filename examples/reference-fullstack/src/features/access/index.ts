import {
  Unauthorized,
  action,
  defineFeature,
  identityContract,
  object,
  operationRoute,
  sessionContract,
  string,
  type ExecutionContext,
} from "typescript-on-rails";

interface AccessContext extends ExecutionContext {
  authenticate(input: {
    readonly subject: string;
    readonly proof: string;
  }): Promise<{ readonly actorId: string } | undefined>;
}

export const authenticateSession = action({
  input: object({ subject: string(), proof: string() }),
  output: object({ actorId: string() }),
  public: true,
  async run(input, context: AccessContext) {
    const actor = await context.authenticate(input);
    if (actor === undefined) throw new Unauthorized();
    return actor;
  },
});

export const sessionRoute = operationRoute({
  method: "POST",
  path: "/api/session",
  operation: authenticateSession,
});

export const accessFeature = defineFeature<AccessContext>({
  name: "access",
  operations: { authenticateSession },
  routes: [sessionRoute],
  permissions: ["session.create"],
  adapters: [identityContract, sessionContract],
});

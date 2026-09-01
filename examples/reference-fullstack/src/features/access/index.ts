import {
  Unauthorized,
  action,
  boolean,
  defineFeature,
  object,
  route,
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

export const sessionRoute = route({
  method: "POST",
  path: "/api/session",
  input: object({ subject: string(), proof: string() }),
  output: object({ signedIn: boolean() }),
  public: true,
  async handler(input, context: AccessContext) {
    await authenticateSession.execute(input, context);
    return { signedIn: true };
  },
});

export const accessFeature = defineFeature<AccessContext>({
  name: "access",
  operations: { authenticateSession },
  routes: [sessionRoute],
  permissions: ["session.create"],
  tests: ["test/reference.test.ts"],
});

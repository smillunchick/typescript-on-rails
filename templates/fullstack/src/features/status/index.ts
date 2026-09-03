import { defineFeature, object, operationRoute, page, query, string } from "typescript-on-rails";

export const readStatus = query({
  input: object({}),
  output: object({ status: string(), framework: string() }),
  public: true,
  run: () => ({ status: "ready", framework: "TypeScript on Rails" }),
});

export const statusRoute = operationRoute({
  method: "GET",
  path: "/api/status",
  operation: readStatus,
});

export const statusFeature = defineFeature({
  name: "status",
  operations: { readStatus },
  routes: [statusRoute],
  pages: [page({ name: "home", path: "/", runtime: "hybrid" })],
  tests: ["test/status.test.ts"],
});

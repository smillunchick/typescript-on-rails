# typescript-on-rails

An agent-native TypeScript framework that keeps application code organized by feature and makes architectural boundaries explicit.

## Install

```sh
npm install typescript-on-rails
```

## Quick start

Define schemas and executable domain operations with explicit access rules:

```ts
import { action, object, string } from "typescript-on-rails";

export const greet = action({
  input: object({ name: string() }),
  public: true,
  run: ({ name }) => `Hello, ${name}`,
});
```

Run the project health check with `app check` when using a generated application.

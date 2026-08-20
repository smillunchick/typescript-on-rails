# typescript-on-rails

An agent-native TypeScript application architecture kernel and compiler with runtime contract primitives. It keeps application code organized by feature and makes architectural boundaries explicit.

## Current scope

The package provides architecture analysis, strict TypeScript conventions, application structure, generators, introspection, and runtime contract primitives.

It does not provide HTTP serving, rendered UI, persistence or storage, or bundling. Applications own those runtime layers and their development, build, and test scripts. No-emit TypeScript checks are not application builds.

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

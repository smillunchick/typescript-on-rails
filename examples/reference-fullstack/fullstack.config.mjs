import { LifecycleRegistry, processLifecyclePlugin } from "@typescript-on-rails/fullstack";

export default new LifecycleRegistry([
  processLifecyclePlugin("reference-runtime", {
    dev: { command: "npm", args: ["run", "dev:runtime"] },
    build: { command: "npm", args: ["run", "build:runtime"] },
    test: { command: "npm", args: ["run", "test:runtime"] },
    check: { command: "npm", args: ["run", "check:runtime"] },
    migrate: { command: "npm", args: ["run", "migrate:runtime"] },
    worker: { command: "npm", args: ["run", "worker:runtime"] },
    scheduler: { command: "npm", args: ["run", "scheduler:runtime"] },
    seed: { command: "npm", args: ["run", "seed:runtime"] }
  })
]);

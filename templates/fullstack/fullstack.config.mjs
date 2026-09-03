import { applicationLifecyclePlugin } from "@typescript-on-rails/fullstack/application-lifecycle";
import {
  LifecycleRegistry,
  processLifecyclePlugin,
} from "@typescript-on-rails/fullstack";

export default new LifecycleRegistry([
  applicationLifecyclePlugin(),
  processLifecyclePlugin("web-runtime", {
    build: { command: "npm", args: ["run", "build:runtime"] },
    test: { command: "npm", args: ["run", "test:runtime"] },
    check: { command: "npm", args: ["run", "check:runtime"] },
  }),
]);

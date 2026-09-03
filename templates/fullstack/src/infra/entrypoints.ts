import { processEntrypoint } from "@typescript-on-rails/fullstack";

import { statusHttpRoute } from "./http.js";

export const webEntrypoint = processEntrypoint({
  name: "next-web",
  process: "web",
  command: "npm",
  args: ["run", "dev:runtime"],
  bindings: [statusHttpRoute],
});

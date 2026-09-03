import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { analyzeApplicationV3 } from "typescript-on-rails";

import { application } from "../src/app-definition.js";
import { readStatus } from "../src/features/status/index.js";
import { statusNextRoute } from "../src/infra/next-routes.js";

describe("generated application status", () => {
  it("keeps the status behavior and executable graph connected", async () => {
    assert.deepEqual(
      await readStatus.execute({}, { permissions: new Set<string>() }),
      { status: "ready", framework: "TypeScript on Rails" },
    );
    const response = await statusNextRoute(new Request("https://framework.test/api/status"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ready", framework: "TypeScript on Rails" });

    const manifest = analyzeApplicationV3(process.cwd(), { application });
    assert.equal(manifest.completeness.complete, true);
    assert.ok(manifest.linkage.links.some(({ kind }) => kind === "route-operation"));
    assert.ok(manifest.linkage.links.some(({ kind }) => kind === "entrypoint-route"));
  });
});

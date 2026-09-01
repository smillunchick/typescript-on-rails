import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { action, object, string } from "typescript-on-rails";
import { deterministicClock, deterministicIds, httpHarness, jobHarness, operationHarness } from "../src/index.js";

describe("full-stack test harnesses", () => {
  it("runs operations and HTTP handlers through real boundaries", async () => {
    const operation = action({ input: object({ name: string() }), permission: "create", run: ({ name }) => ({ name }) });
    const harness = operationHarness(operation, { permissions: new Set(["create"]) });
    assert.deepEqual(await harness.execute({ name: "Project" }), { name: "Project" });
    const response = await httpHarness({ handle: async (request) => Response.json({ path: new URL(request.url).pathname }) }).request("/projects");
    assert.deepEqual(await response.json(), { path: "/projects" });
  });

  it("runs jobs with deterministic peers", async () => {
    const clock = deterministicClock();
    const id = deterministicIds("job");
    const calls: string[] = [];
    const harness = jobHarness({ work: (payload) => { calls.push(String(payload)); } }, clock.now);
    await harness.enqueue("work", id(), "work:one");
    assert.equal(await harness.worker.runOnce(new AbortController().signal), "succeeded");
    assert.deepEqual(calls, ["job_000001"]);
    clock.advance(100);
    assert.equal(clock.now().getTime(), 100);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

import {
  cookie,
  defineHttpHandler,
  requireTrustedMutation,
  safeErrorResponse,
} from "../src/index.js";
import { nextRoute } from "../src/next.js";
import { renderReact } from "../src/react-render.js";

describe("official web runtime", () => {
  it("decodes JSON, creates context, authorizes, secures, and observes a request", async () => {
    const observations: Array<[number, boolean]> = [];
    const handler = defineHttpHandler({
      name: "create-project",
      method: "POST",
      path: "/projects/:projectId",
      context: (request) => ({ requestId: request.headers.get("x-request-id") ?? "missing", actor: { id: "actor" }, signal: request.signal }),
      authorize: (_input, context) => context.actor?.id === "actor",
      handle: (input, context) => ({ projectId: input.params.projectId, body: input.body, requestId: context.requestId }),
      observe: { start: () => ({ end: (status, error) => { observations.push([status, error !== undefined]); } }) },
    });
    const response = await handler.handle(new Request("https://example.test/projects/one", { method: "POST", headers: { "content-type": "application/json", "x-request-id": "req-1" }, body: JSON.stringify({ name: "Project" }) }), { projectId: "one" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { projectId: "one", body: { name: "Project" }, requestId: "req-1" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.deepEqual(observations, [[200, false]]);
  });

  it("parses bounded multipart fields and files", async () => {
    const received: Array<{ field: string; name: string; text: string }> = [];
    const handler = defineHttpHandler({
      name: "upload",
      method: "POST",
      path: "/upload",
      context: (request) => ({ requestId: "upload", signal: request.signal }),
      handle: async (input) => {
        for (const file of input.files) {
          received.push({ field: file.field, name: file.name, text: new TextDecoder().decode(file.bytes) });
        }
        return { body: input.body };
      },
    });
    const form = new FormData();
    form.append("label", "first");
    form.append("label", "second");
    form.append("evidence", new File(["safe"], "evidence.txt", { type: "text/plain" }));
    const response = await handler.handle(new Request("https://example.test/upload", { method: "POST", body: form }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { body: { label: ["first", "second"] } });
    assert.deepEqual(received, [{ field: "evidence", name: "evidence.txt", text: "safe" }]);
  });

  it("fails closed for method, authorization, body, origin, and CSRF errors", async () => {
    const handler = defineHttpHandler({ name: "bounded", method: "POST", path: "/bounded", maximumBodyBytes: 2, context: (request) => ({ requestId: "one", signal: request.signal }), authorize: () => false, handle: () => ({ ok: true }) });
    assert.equal((await handler.handle(new Request("https://example.test/bounded"))).status, 405);
    assert.equal((await handler.handle(new Request("https://example.test/bounded", { method: "POST", body: "abc" }))).status, 413);
    assert.equal((await handler.handle(new Request("https://example.test/bounded", { method: "POST", body: "a" }))).status, 403);
    assert.throws(() => requireTrustedMutation({ request: new Request("https://example.test", { method: "POST", headers: { origin: "https://evil.test" } }), trustedOrigins: ["https://example.test"], csrfCookie: "a".repeat(32), csrfValue: "a".repeat(32) }), /origin/i);
    assert.throws(() => requireTrustedMutation({ request: new Request("https://example.test", { method: "POST", headers: { origin: "https://example.test", "sec-fetch-site": "same-origin" } }), trustedOrigins: ["https://example.test"], csrfCookie: "a".repeat(32), csrfValue: "b".repeat(32) }), /CSRF/i);
    assert.match(cookie("__Host-session", "token", { maxAgeSeconds: 60 }), /HttpOnly; Secure/);
    const hidden = safeErrorResponse(Object.assign(new Error("database"), { code: "42P01" }));
    assert.equal(hidden.status, 500);
    assert.deepEqual(await hidden.json(), {
      error: { code: "UNEXPECTED", message: "Unexpected server error" },
    });
  });

  it("binds handlers to Next-compatible functions and renders React streams", async () => {
    const handler = defineHttpHandler({ name: "read", method: "GET", path: "/projects/:projectId", context: (request) => ({ requestId: "one", signal: request.signal }), handle: (input) => ({ id: input.params.projectId }) });
    const response = await nextRoute(handler)(new Request("https://example.test/projects/one"), { params: Promise.resolve({ projectId: "one" }) });
    assert.deepEqual(await response.json(), { id: "one" });
    const page = await renderReact(createElement("main", null, createElement("h1", null, "Projects")));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<h1>Projects<\/h1>/);
    await assert.rejects(
      renderReact(createElement("main"), { bootstrapScripts: ["/app.js"] }),
      /NONCE_REQUIRED/,
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Forbidden, NotFound } from "typescript-on-rails";

import { getCurrentUser, type AuthenticatedContext } from "../src/features/identity/index.js";

const permissions = new Set(["user.read"]);

function authenticated(userId: string, customerId: string): AuthenticatedContext {
  return { userId, customerId, permissions };
}

describe("reference SaaS identity promises", () => {
  it("returns only the user authenticated for the current customer", async () => {
    assert.deepEqual(await getCurrentUser.execute({}, authenticated("user_1", "customer_1")), {
      id: "user_1",
      customerId: "customer_1",
      email: "owner@example.com",
      role: "admin",
    });
    assert.deepEqual(await getCurrentUser.execute({}, authenticated("user_2", "customer_2")), {
      id: "user_2",
      customerId: "customer_2",
      email: "member@example.com",
      role: "member",
    });
  });

  it("requires user.read permission", async () => {
    await assert.rejects(
      () => getCurrentUser.execute({}, {
        userId: "user_1",
        customerId: "customer_1",
        permissions: new Set(),
      }),
      Forbidden,
    );
  });

  it("does not reveal a user across customers or for an unknown identity", async () => {
    await assert.rejects(
      () => getCurrentUser.execute({}, authenticated("user_1", "customer_2")),
      NotFound,
    );
    await assert.rejects(
      () => getCurrentUser.execute({}, authenticated("missing_user", "customer_1")),
      NotFound,
    );
  });
});

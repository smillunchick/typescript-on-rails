import { localEmailAdapter, localIdentityAdapter, localSessionAdapter } from "@typescript-on-rails/fullstack";
import { Unauthorized } from "typescript-on-rails";

const principals = {
  demo: { tenantId: "tenant_local", email: "developer@example.test", permissions: ["project.create", "project.read", "project.invitation.accept"] },
  reader: { tenantId: "tenant_local", email: "reader@example.test", permissions: ["project.read", "project.invitation.accept"] },
  outsider: { tenantId: "tenant_other", email: "reader@example.test", permissions: ["project.create", "project.read", "project.invitation.accept"] },
};
export const identity = localIdentityAdapter(Object.fromEntries(Object.keys(principals).map((subject) => [subject, "local-proof"])));
export const sessions = localSessionAdapter();
export const email = localEmailAdapter();

// Resolve from trusted identity output, not a request's tenant, email, or permissions.
export async function localPrincipal(actorId: string) {
  for (const [subject, principal] of Object.entries(principals)) {
    const identityResult = await identity.authenticate({ subject, proof: "local-proof" });
    if (identityResult?.actorId === actorId) return { ...principal, actorId, permissions: new Set(principal.permissions) };
  }
  throw new Unauthorized();
}

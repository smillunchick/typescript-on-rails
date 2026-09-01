import { localEmailAdapter, localIdentityAdapter, localSessionAdapter } from "@typescript-on-rails/fullstack";

const localIdentity = localIdentityAdapter({ demo: "local-proof" });

export const identity = Object.freeze({
  authenticate(input: { readonly subject: string; readonly proof: string }) {
    if (process.env.NODE_ENV === "production") throw new Error("LOCAL_IDENTITY_DISABLED_IN_PRODUCTION");
    return localIdentity.authenticate(input);
  },
});
export const sessions = localSessionAdapter();
export const email = localEmailAdapter();

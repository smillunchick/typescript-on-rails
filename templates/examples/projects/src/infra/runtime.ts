import { localEmailAdapter, localIdentityAdapter, localSessionAdapter } from "@typescript-on-rails/fullstack";

export const identity = localIdentityAdapter({ demo: "local-proof" });
export const sessions = localSessionAdapter();
export const email = localEmailAdapter();

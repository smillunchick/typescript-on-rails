import { defineAdapterContract } from "./adapter.js";
import {
  boolean,
  bytes,
  date,
  id,
  literal,
  money,
  number,
  object,
  optional,
  string,
  unit,
} from "./schema.js";

export const emailContract = defineAdapterContract({
  name: "email",
  operations: {
    send: {
      input: object({ idempotencyKey: id(), to: string(), subject: string(), text: string() }),
      output: object({ messageId: id(), replayed: boolean() }),
    },
  },
});

export const storageContract = defineAdapterContract({
  name: "storage",
  operations: {
    put: {
      input: object({ key: id(), bytes: bytes(), checksum: string() }),
      output: object({ version: string(), replayed: boolean() }),
    },
    get: {
      input: object({ key: id(), version: optional(string()) }),
      output: optional(bytes()),
    },
  },
});

export const paymentsContract = defineAdapterContract({
  name: "payments",
  operations: {
    charge: {
      input: object({ idempotencyKey: id(), customerId: id(), amountMinor: money(), currency: string() }),
      output: object({ paymentId: id(), status: literal("succeeded") }),
    },
  },
});

export const identityContract = defineAdapterContract({
  name: "identity",
  operations: {
    authenticate: {
      input: object({ subject: string(), proof: string() }),
      output: optional(object({ actorId: id() })),
    },
  },
});

export const sessionContract = defineAdapterContract({
  name: "session",
  operations: {
    create: {
      input: object({ actorId: id(), expiresAt: date() }),
      output: string(),
    },
    read: {
      input: object({ token: string(), now: date() }),
      output: optional(object({ actorId: id(), expiresAt: date() })),
    },
    revoke: {
      input: object({ token: string() }),
      output: unit(),
    },
  },
});

export const cacheContract = defineAdapterContract({
  name: "cache",
  operations: {
    get: {
      input: object({ key: id() }),
      output: optional(string()),
    },
    set: {
      input: object({ key: id(), value: string(), ttlMilliseconds: optional(number()) }),
      output: unit(),
    },
    delete: {
      input: object({ key: id() }),
      output: unit(),
    },
  },
});

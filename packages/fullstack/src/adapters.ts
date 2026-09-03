import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  cacheContract,
  emailContract,
  identityContract,
  implementAdapter,
  paymentsContract,
  sessionContract,
  storageContract,
  withAdapterAccessors,
  type AdapterInstanceOf,
} from "typescript-on-rails";

const LOCAL_ADAPTER = Object.freeze({ provider: "local-memory", suitability: "local-only" as const });

export interface AdapterConformance<TAdapter> {
  readonly name: string;
  create(): Promise<TAdapter> | TAdapter;
  verify(adapter: TAdapter): Promise<void>;
}

export async function verifyAdapter<T>(contract: AdapterConformance<T>): Promise<void> {
  await contract.verify(await contract.create());
}

export interface EmailMessage { readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly text: string }
export type EmailAdapter = AdapterInstanceOf<typeof emailContract> & {
  send(message: EmailMessage): Promise<{ readonly messageId: string; readonly replayed: boolean }>;
};
export type StorageAdapter = AdapterInstanceOf<typeof storageContract> & {
  put(input: { readonly key: string; readonly bytes: Uint8Array; readonly checksum: string }): Promise<{ readonly version: string; readonly replayed: boolean }>;
  get(key: string, version?: string): Promise<Uint8Array | undefined>;
};
export type PaymentsAdapter = AdapterInstanceOf<typeof paymentsContract> & {
  charge(input: { readonly idempotencyKey: string; readonly customerId: string; readonly amountMinor: number; readonly currency: string }): Promise<{ readonly paymentId: string; readonly status: "succeeded" }>;
};
export type IdentityAdapter = AdapterInstanceOf<typeof identityContract> & {
  authenticate(input: { readonly subject: string; readonly proof: string }): Promise<{ readonly actorId: string } | undefined>;
};
export type SessionAdapter = AdapterInstanceOf<typeof sessionContract> & {
  create(actorId: string, expiresAt: Date): Promise<string>;
  read(token: string, now: Date): Promise<{ readonly actorId: string; readonly expiresAt: Date } | undefined>;
  revoke(token: string): Promise<void>;
};
export type CacheAdapter = AdapterInstanceOf<typeof cacheContract> & {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMilliseconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
};

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function localEmailAdapter() {
  const byKey = new Map<string, EmailMessage>();
  const messages: EmailMessage[] = [];
  const instance = implementAdapter(emailContract, {
    async send(message) {
      const prior = byKey.get(message.idempotencyKey);
      if (prior !== undefined) return { messageId: stableId("mail", message.idempotencyKey), replayed: true };
      byKey.set(message.idempotencyKey, Object.freeze({ ...message }));
      messages.push(Object.freeze({ ...message }));
      return { messageId: stableId("mail", message.idempotencyKey), replayed: false };
    },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    get messages() { return Object.freeze([...messages]); },
    send(message: EmailMessage) { return instance.operations.send(message); },
  });
}

export function localStorageAdapter() {
  const objects = new Map<string, { version: string; bytes: Uint8Array }[]>();
  const instance = implementAdapter(storageContract, {
    async put(input) {
      const actual = createHash("sha256").update(input.bytes).digest("hex");
      if (actual !== input.checksum) throw new Error("STORAGE_CHECKSUM_MISMATCH");
      const versions = objects.get(input.key) ?? [];
      const prior = versions.find(({ version }) => version === actual);
      if (prior !== undefined) return { version: prior.version, replayed: true };
      versions.push({ version: actual, bytes: Uint8Array.from(input.bytes) });
      objects.set(input.key, versions);
      return { version: actual, replayed: false };
    },
    async get({ key, version }) {
      const versions = objects.get(key) ?? [];
      const selected = version === undefined ? versions.at(-1) : versions.find((entry) => entry.version === version);
      return selected === undefined ? undefined : Uint8Array.from(selected.bytes);
    },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    put(input: { readonly key: string; readonly bytes: Uint8Array; readonly checksum: string }) { return instance.operations.put(input); },
    get(key: string, version?: string) { return instance.operations.get({ key, version }); },
  });
}

export function localPaymentsAdapter() {
  const payments = new Map<string, string>();
  const instance = implementAdapter(paymentsContract, {
    async charge(input) {
      const paymentId = payments.get(input.idempotencyKey) ?? stableId("payment", input.idempotencyKey);
      payments.set(input.idempotencyKey, paymentId);
      return { paymentId, status: "succeeded" as const };
    },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    charge(input: { readonly idempotencyKey: string; readonly customerId: string; readonly amountMinor: number; readonly currency: string }) {
      return instance.operations.charge(input);
    },
  });
}

export function localIdentityAdapter(credentials: Readonly<Record<string, string>>) {
  const proofs = new Map(Object.entries(credentials).map(([subject, proof]) => [subject, createHash("sha256").update(proof).digest()]));
  const instance = implementAdapter(identityContract, {
    async authenticate({ subject, proof }) {
      const expected = proofs.get(subject);
      const candidate = createHash("sha256").update(proof).digest();
      return expected !== undefined && timingSafeEqual(expected, candidate)
        ? { actorId: stableId("actor", subject) }
        : undefined;
    },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    authenticate(input: { readonly subject: string; readonly proof: string }) { return instance.operations.authenticate(input); },
  });
}

export function localSessionAdapter() {
  const sessions = new Map<string, { actorId: string; expiresAt: Date }>();
  const instance = implementAdapter(sessionContract, {
    async create({ actorId, expiresAt }) {
      const token = `session_${randomUUID()}`;
      sessions.set(token, { actorId, expiresAt: new Date(expiresAt) });
      return token;
    },
    async read({ token, now }) {
      const session = sessions.get(token);
      if (session === undefined || session.expiresAt <= now) return undefined;
      return { actorId: session.actorId, expiresAt: new Date(session.expiresAt) };
    },
    async revoke({ token }) { sessions.delete(token); },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    create(actorId: string, expiresAt: Date) { return instance.operations.create({ actorId, expiresAt }); },
    read(token: string, now: Date) { return instance.operations.read({ token, now }); },
    revoke(token: string) { return instance.operations.revoke({ token }); },
  });
}

export function localCacheAdapter(now: () => number = Date.now) {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  const instance = implementAdapter(cacheContract, {
    async get({ key }) {
      const entry = values.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
        values.delete(key);
        return undefined;
      }
      return entry?.value;
    },
    async set({ key, value, ttlMilliseconds }) {
      values.set(key, { value, ...(ttlMilliseconds === undefined ? {} : { expiresAt: now() + ttlMilliseconds }) });
    },
    async delete({ key }) { values.delete(key); },
  }, LOCAL_ADAPTER);
  return withAdapterAccessors(instance, {
    get(key: string) { return instance.operations.get({ key }); },
    set(key: string, value: string, ttlMilliseconds?: number) { return instance.operations.set({ key, value, ttlMilliseconds }); },
    delete(key: string) { return instance.operations.delete({ key }); },
  });
}

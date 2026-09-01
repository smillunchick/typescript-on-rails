import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export interface AdapterConformance<TAdapter> {
  readonly name: string;
  create(): Promise<TAdapter> | TAdapter;
  verify(adapter: TAdapter): Promise<void>;
}

export async function verifyAdapter<T>(contract: AdapterConformance<T>): Promise<void> {
  await contract.verify(await contract.create());
}

export interface EmailMessage { readonly idempotencyKey: string; readonly to: string; readonly subject: string; readonly text: string }
export interface EmailAdapter { send(message: EmailMessage): Promise<{ readonly messageId: string; readonly replayed: boolean }> }
export interface StorageAdapter {
  put(input: { readonly key: string; readonly bytes: Uint8Array; readonly checksum: string }): Promise<{ readonly version: string; readonly replayed: boolean }>;
  get(key: string, version?: string): Promise<Uint8Array | undefined>;
}
export interface PaymentsAdapter {
  charge(input: { readonly idempotencyKey: string; readonly customerId: string; readonly amountMinor: number; readonly currency: string }): Promise<{ readonly paymentId: string; readonly status: "succeeded" }>;
}
export interface IdentityAdapter {
  authenticate(input: { readonly subject: string; readonly proof: string }): Promise<{ readonly actorId: string } | undefined>;
}
export interface SessionAdapter {
  create(actorId: string, expiresAt: Date): Promise<string>;
  read(token: string, now: Date): Promise<{ readonly actorId: string; readonly expiresAt: Date } | undefined>;
  revoke(token: string): Promise<void>;
}
export interface CacheAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMilliseconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function localEmailAdapter(): EmailAdapter & { readonly messages: readonly EmailMessage[] } {
  const byKey = new Map<string, EmailMessage>();
  const messages: EmailMessage[] = [];
  return Object.freeze({
    get messages() { return Object.freeze([...messages]); },
    async send(message: EmailMessage) {
      const prior = byKey.get(message.idempotencyKey);
      if (prior !== undefined) return { messageId: stableId("mail", message.idempotencyKey), replayed: true };
      byKey.set(message.idempotencyKey, Object.freeze({ ...message }));
      messages.push(Object.freeze({ ...message }));
      return { messageId: stableId("mail", message.idempotencyKey), replayed: false };
    },
  });
}

export function localStorageAdapter(): StorageAdapter {
  const objects = new Map<string, { version: string; bytes: Uint8Array }[]>();
  return Object.freeze({
    async put(input: { readonly key: string; readonly bytes: Uint8Array; readonly checksum: string }) {
      const actual = createHash("sha256").update(input.bytes).digest("hex");
      if (actual !== input.checksum) throw new Error("STORAGE_CHECKSUM_MISMATCH");
      const versions = objects.get(input.key) ?? [];
      const prior = versions.find(({ version }) => version === actual);
      if (prior !== undefined) return { version: prior.version, replayed: true };
      versions.push({ version: actual, bytes: Uint8Array.from(input.bytes) });
      objects.set(input.key, versions);
      return { version: actual, replayed: false };
    },
    async get(key: string, version?: string) {
      const versions = objects.get(key) ?? [];
      const selected = version === undefined ? versions.at(-1) : versions.find((entry) => entry.version === version);
      return selected === undefined ? undefined : Uint8Array.from(selected.bytes);
    },
  });
}

export function localPaymentsAdapter(): PaymentsAdapter {
  const payments = new Map<string, string>();
  return Object.freeze({
    async charge(input: { readonly idempotencyKey: string; readonly customerId: string; readonly amountMinor: number; readonly currency: string }) {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new Error("PAYMENT_AMOUNT_INVALID");
      const paymentId = payments.get(input.idempotencyKey) ?? stableId("payment", input.idempotencyKey);
      payments.set(input.idempotencyKey, paymentId);
      return { paymentId, status: "succeeded" as const };
    },
  });
}

export function localIdentityAdapter(credentials: Readonly<Record<string, string>>): IdentityAdapter {
  const proofs = new Map(
    Object.entries(credentials).map(([subject, proof]) => [
      subject,
      createHash("sha256").update(proof).digest(),
    ]),
  );
  return Object.freeze({
    async authenticate({ subject, proof }: { readonly subject: string; readonly proof: string }) {
      const expected = proofs.get(subject);
      const candidate = createHash("sha256").update(proof).digest();
      return expected !== undefined && timingSafeEqual(expected, candidate)
        ? { actorId: stableId("actor", subject) }
        : undefined;
    },
  });
}

export function localSessionAdapter(): SessionAdapter {
  const sessions = new Map<string, { actorId: string; expiresAt: Date }>();
  return Object.freeze({
    async create(actorId: string, expiresAt: Date) {
      const token = `session_${randomUUID()}`;
      sessions.set(token, { actorId, expiresAt: new Date(expiresAt) });
      return token;
    },
    async read(token: string, now: Date) {
      const session = sessions.get(token);
      if (session === undefined || session.expiresAt <= now) return undefined;
      return { actorId: session.actorId, expiresAt: new Date(session.expiresAt) };
    },
    async revoke(token: string) { sessions.delete(token); },
  });
}

export function localCacheAdapter(now: () => number = Date.now): CacheAdapter {
  const values = new Map<string, { value: string; expiresAt?: number }>();
  return Object.freeze({
    async get(key: string) {
      const entry = values.get(key);
      if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) { values.delete(key); return undefined; }
      return entry?.value;
    },
    async set(key: string, value: string, ttlMilliseconds?: number) { values.set(key, { value, ...(ttlMilliseconds === undefined ? {} : { expiresAt: now() + ttlMilliseconds }) }); },
    async delete(key: string) { values.delete(key); },
  });
}

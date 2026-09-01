import { randomUUID } from "node:crypto";

import {
  idempotencyConflict,
  jobRequestDigest,
  outboxRequestDigest,
  scheduleRequestDigest,
} from "./identity.js";

export interface DurableEvent<TPayload = Readonly<Record<string, unknown>>> {
  readonly name: string;
  readonly version: number;
  parse(value: unknown): TPayload;
}

export function durableEvent<TPayload>(definition: { readonly name: string; readonly version?: number; readonly parse: (value: unknown) => TPayload }): DurableEvent<TPayload> {
  if (!/^[A-Z][A-Za-z0-9]+$/.test(definition.name)) throw new TypeError("Durable event names must be PascalCase");
  return Object.freeze({ name: definition.name, version: definition.version ?? 1, parse: definition.parse });
}

export type JobStatus = "queued" | "running" | "succeeded" | "dead";
export interface JobRecord {
  readonly id: string;
  readonly name: string;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly availableAt: Date;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastErrorCode?: string;
}
export interface EnqueueJob { readonly name: string; readonly payload: unknown; readonly idempotencyKey: string; readonly maximumAttempts?: number; readonly availableAt?: Date }
export interface OutboxRecord {
  readonly id: string;
  readonly event: string;
  readonly version: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly publishedAt?: Date;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: Date;
}
export interface ScheduleOccurrence { readonly schedule: string; readonly occurrence: string; readonly job: EnqueueJob }
export type EffectState = "pending" | "succeeded" | "uncertain";
export interface EffectOwner { readonly jobId: string; readonly leaseToken: string }
export interface EffectReceipt {
  readonly key: string;
  readonly state: EffectState;
  readonly owner?: EffectOwner;
  readonly providerReference?: string;
  readonly result?: unknown;
  readonly updatedAt: Date;
}
export type EffectTransition =
  | { readonly kind: "reserve"; readonly key: string; readonly owner: EffectOwner; readonly updatedAt: Date }
  | { readonly kind: "reclaim"; readonly key: string; readonly expectedOwner: EffectOwner; readonly owner: EffectOwner; readonly updatedAt: Date }
  | { readonly kind: "succeed"; readonly key: string; readonly owner: EffectOwner; readonly result: unknown; readonly providerReference?: string; readonly updatedAt: Date }
  | { readonly kind: "reconcile-succeeded"; readonly key: string; readonly expectedOwner: EffectOwner; readonly owner: EffectOwner; readonly result: unknown; readonly providerReference?: string; readonly updatedAt: Date }
  | { readonly kind: "uncertain"; readonly key: string; readonly owner: EffectOwner; readonly updatedAt: Date };
export interface EffectTransitionResult {
  readonly applied: boolean;
  readonly receipt?: EffectReceipt;
  readonly ownerActive: boolean;
}

export interface JobStore {
  enqueue(input: EnqueueJob): Promise<{ readonly id: string; readonly replayed: boolean }>;
  appendOutbox<T>(event: DurableEvent<T>, payload: T, idempotencyKey: string): Promise<{ readonly id: string; readonly replayed: boolean }>;
  claim(now: Date, leaseMilliseconds: number): Promise<JobRecord | undefined>;
  renew(id: string, leaseToken: string, leaseMilliseconds: number): Promise<boolean>;
  complete(id: string, leaseToken: string): Promise<boolean>;
  fail(id: string, leaseToken: string, input: { readonly errorCode: string; readonly availableAt: Date; readonly dead: boolean }): Promise<boolean>;
  dueOutbox(limit: number, now?: Date, leaseMilliseconds?: number): Promise<readonly OutboxRecord[]>;
  markPublished(id: string, leaseToken: string, publishedAt: Date): Promise<boolean>;
  materialize(input: ScheduleOccurrence): Promise<{ readonly id: string; readonly replayed: boolean }>;
  transitionEffect(input: EffectTransition): Promise<EffectTransitionResult>;
  deadLetters(): Promise<readonly JobRecord[]>;
}

export interface JobHandlerContext { readonly jobId: string; readonly attempt: number; readonly signal: AbortSignal; effect<T>(key: string, run: () => Promise<{ readonly value: T; readonly providerReference?: string }>, reconcile?: () => Promise<{ readonly state: "succeeded" | "missing"; readonly value?: T; readonly providerReference?: string }>): Promise<T> }
export type JobHandler = (payload: unknown, context: JobHandlerContext) => Promise<void> | void;

export interface WorkerOptions {
  readonly store: JobStore;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly leaseMilliseconds?: number;
  readonly baseBackoffMilliseconds?: number;
  readonly now?: () => Date;
}

function waitForRenewal(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

function safeErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code.slice(0, 100) : "UNEXPECTED";
}

function effectError(code: "EFFECT_FENCE_LOST" | "EFFECT_IN_PROGRESS" | "EFFECT_RECEIPT_INVALID" | "EFFECT_RECONCILIATION_REQUIRED" | "EFFECT_RESULT_UNAVAILABLE"): Error {
  return Object.assign(new Error(code), { code });
}

function resultFromReceipt<T>(receipt: EffectReceipt): T {
  if (receipt.state !== "succeeded" || !Object.hasOwn(receipt, "result")) throw effectError("EFFECT_RESULT_UNAVAILABLE");
  return receipt.result as T;
}

function ownerFromReceipt(receipt: EffectReceipt): EffectOwner {
  if (receipt.state === "succeeded" || receipt.owner === undefined) throw effectError("EFFECT_RECEIPT_INVALID");
  return receipt.owner;
}

export function createWorker(options: WorkerOptions) {
  const now = options.now ?? (() => new Date());
  const leaseMilliseconds = options.leaseMilliseconds ?? 30_000;
  const baseBackoff = options.baseBackoffMilliseconds ?? 1_000;
  return Object.freeze({
    async runOnce(signal: AbortSignal): Promise<"idle" | "succeeded" | "retry" | "dead"> {
      const job = await options.store.claim(now(), leaseMilliseconds);
      if (job === undefined) return "idle";
      const leaseToken = job.leaseToken;
      if (leaseToken === undefined) throw new Error("CLAIM_WITHOUT_LEASE");
      const handler = options.handlers[job.name];
      if (handler === undefined) {
        if (!(await options.store.fail(job.id, leaseToken, { errorCode: "HANDLER_NOT_FOUND", availableAt: now(), dead: true }))) {
          throw new Error("JOB_FENCE_LOST");
        }
        return "dead";
      }
      const handlerController = new AbortController();
      const forwardAbort = () => handlerController.abort(signal.reason ?? new Error("WORKER_ABORTED"));
      if (signal.aborted) forwardAbort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
      const renewalController = new AbortController();
      const renewal = (async () => {
        while (await waitForRenewal(Math.max(1, Math.floor(leaseMilliseconds / 2)), renewalController.signal)) {
          try {
            if (!(await options.store.renew(job.id, leaseToken, leaseMilliseconds))) {
              handlerController.abort(new Error("JOB_FENCE_LOST"));
              return;
            }
          } catch (error) {
            handlerController.abort(error);
            return;
          }
        }
      })();
      const context: JobHandlerContext = {
        jobId: job.id,
        attempt: job.attempts,
        signal: handlerController.signal,
        async effect<T>(
          key: string,
          run: () => Promise<{ readonly value: T; readonly providerReference?: string }>,
          reconcile?: () => Promise<{ readonly state: "succeeded" | "missing"; readonly value?: T; readonly providerReference?: string }>,
        ) {
          const owner = { jobId: job.id, leaseToken };
          let transition = await options.store.transitionEffect({ kind: "reserve", key, owner, updatedAt: now() });
          if (transition.receipt?.state === "succeeded") return resultFromReceipt<T>(transition.receipt);

          if (!transition.applied) {
            const prior = transition.receipt;
            if (prior === undefined) throw effectError("EFFECT_FENCE_LOST");
            if (transition.ownerActive) throw effectError("EFFECT_IN_PROGRESS");
            if (reconcile === undefined) throw effectError("EFFECT_RECONCILIATION_REQUIRED");
            const reconciled = await reconcile();
            const expectedOwner = ownerFromReceipt(prior);
            if (reconciled.state === "succeeded") {
              if (!Object.hasOwn(reconciled, "value") || reconciled.value === undefined) throw effectError("EFFECT_RESULT_UNAVAILABLE");
              transition = await options.store.transitionEffect({
                kind: "reconcile-succeeded",
                key,
                expectedOwner,
                owner,
                result: reconciled.value,
                ...(reconciled.providerReference === undefined ? {} : { providerReference: reconciled.providerReference }),
                updatedAt: now(),
              });
              if (transition.applied) return reconciled.value as T;
              if (transition.receipt?.state === "succeeded") return resultFromReceipt<T>(transition.receipt);
              throw effectError(transition.ownerActive ? "EFFECT_IN_PROGRESS" : "EFFECT_FENCE_LOST");
            }
            transition = await options.store.transitionEffect({ kind: "reclaim", key, expectedOwner, owner, updatedAt: now() });
            if (!transition.applied) {
              if (transition.receipt?.state === "succeeded") return resultFromReceipt<T>(transition.receipt);
              throw effectError(transition.ownerActive ? "EFFECT_IN_PROGRESS" : "EFFECT_FENCE_LOST");
            }
          }

          try {
            const result = await run();
            if (result.value === undefined) throw effectError("EFFECT_RESULT_UNAVAILABLE");
            const settled = await options.store.transitionEffect({
              kind: "succeed",
              key,
              owner,
              result: result.value,
              ...(result.providerReference === undefined ? {} : { providerReference: result.providerReference }),
              updatedAt: now(),
            });
            if (settled.applied) return result.value;
            if (settled.receipt?.state === "succeeded") return resultFromReceipt<T>(settled.receipt);
            throw effectError("EFFECT_FENCE_LOST");
          } catch (error) {
            try {
              await options.store.transitionEffect({ kind: "uncertain", key, owner, updatedAt: now() });
            } catch {
              // Preserve the provider failure. A missing uncertainty receipt still requires reconciliation.
            }
            throw error;
          }
        },
      };
      try {
        if (signal.aborted) throw signal.reason ?? Object.assign(new Error("WORKER_ABORTED"), { code: "WORKER_ABORTED" });
        await handler(job.payload, context);
        if (!(await options.store.complete(job.id, leaseToken))) throw new Error("JOB_FENCE_LOST");
        return "succeeded";
      } catch (error) {
        const dead = job.attempts >= job.maximumAttempts;
        const delay = baseBackoff * 2 ** Math.max(0, job.attempts - 1);
        const availableAt = new Date(now().getTime() + delay);
        if (!(await options.store.fail(job.id, leaseToken, { errorCode: safeErrorCode(error), availableAt, dead }))) throw new Error("JOB_FENCE_LOST");
        return dead ? "dead" : "retry";
      } finally {
        renewalController.abort();
        await renewal;
        signal.removeEventListener("abort", forwardAbort);
      }
    },
  });
}

export function memoryJobStore(now: () => Date = () => new Date()): JobStore {
  const jobs = new Map<string, JobRecord>();
  const jobKeys = new Map<string, { readonly id: string; readonly digest: string }>();
  const outbox = new Map<string, OutboxRecord>();
  const outboxKeys = new Map<string, { readonly id: string; readonly digest: string }>();
  const occurrences = new Map<string, { readonly id: string; readonly digest: string }>();
  const effects = new Map<string, EffectReceipt>();
  const store: JobStore = {
    async enqueue(input) {
      const digest = jobRequestDigest(input);
      const prior = jobKeys.get(input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw idempotencyConflict("JOB_IDEMPOTENCY_CONFLICT");
        return { id: prior.id, replayed: true };
      }
      const id = `job_${randomUUID()}`;
      jobs.set(id, Object.freeze({ id, name: input.name, payload: input.payload, idempotencyKey: input.idempotencyKey, status: "queued", attempts: 0, maximumAttempts: input.maximumAttempts ?? 5, availableAt: input.availableAt ?? now() }));
      jobKeys.set(input.idempotencyKey, { id, digest });
      return { id, replayed: false };
    },
    async appendOutbox(event, payload, idempotencyKey) {
      event.parse(payload);
      const digest = outboxRequestDigest(event, payload);
      const prior = outboxKeys.get(idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw idempotencyConflict("OUTBOX_IDEMPOTENCY_CONFLICT");
        return { id: prior.id, replayed: true };
      }
      const id = `outbox_${randomUUID()}`;
      outbox.set(id, Object.freeze({ id, event: event.name, version: event.version, payload, idempotencyKey }));
      outboxKeys.set(idempotencyKey, { id, digest });
      return { id, replayed: false };
    },
    async claim(at, leaseMilliseconds) {
      const candidate = [...jobs.values()].filter((job) => (job.status === "queued" || (job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= at)) && job.availableAt <= at).sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id))[0];
      if (candidate === undefined) return undefined;
      const leaseToken = randomUUID();
      const claimed = Object.freeze({ ...candidate, status: "running" as const, attempts: candidate.attempts + 1, leaseToken, leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds) });
      jobs.set(candidate.id, claimed);
      return claimed;
    },
    async renew(id, leaseToken, leaseMilliseconds) {
      const current = jobs.get(id);
      const at = now();
      if (current?.status !== "running" || current.leaseToken !== leaseToken || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= at) return false;
      jobs.set(
        id,
        Object.freeze({ ...current, leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds) }),
      );
      return true;
    },
    async complete(id, leaseToken) {
      const job = jobs.get(id);
      const at = now();
      if (job?.status !== "running" || job.leaseToken !== leaseToken || job.leaseExpiresAt === undefined || job.leaseExpiresAt <= at) return false;
      const { leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...rest } = job;
      jobs.set(id, Object.freeze({ ...rest, status: "succeeded" as const }));
      return true;
    },
    async fail(id, leaseToken, input) {
      const job = jobs.get(id);
      const at = now();
      if (job?.status !== "running" || job.leaseToken !== leaseToken || job.leaseExpiresAt === undefined || job.leaseExpiresAt <= at) return false;
      const { leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...rest } = job;
      jobs.set(id, Object.freeze({ ...rest, status: input.dead ? "dead" as const : "queued" as const, availableAt: input.availableAt, lastErrorCode: input.errorCode }));
      return true;
    },
    async dueOutbox(limit, at = now(), leaseMilliseconds = 30_000) {
      const due = [...outbox.values()]
        .filter(
          ({ publishedAt, leaseExpiresAt }) =>
            publishedAt === undefined &&
            (leaseExpiresAt === undefined || leaseExpiresAt <= at),
        )
        .slice(0, limit)
        .map((record) => {
          const claimed = Object.freeze({
            ...record,
            leaseToken: randomUUID(),
            leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds),
          });
          outbox.set(record.id, claimed);
          return claimed;
        });
      return Object.freeze(due);
    },
    async markPublished(id, leaseToken, publishedAt) {
      const item = outbox.get(id);
      if (
        item === undefined ||
        item.publishedAt !== undefined ||
        item.leaseToken !== leaseToken ||
        item.leaseExpiresAt === undefined ||
        item.leaseExpiresAt <= now()
      ) return false;
      const { leaseToken: _leaseToken, leaseExpiresAt: _leaseExpiresAt, ...rest } = item;
      outbox.set(id, Object.freeze({ ...rest, publishedAt }));
      return true;
    },
    async materialize(input) {
      const key = `${input.schedule}:${input.occurrence}`;
      const digest = scheduleRequestDigest(input);
      const prior = occurrences.get(key);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw idempotencyConflict("SCHEDULE_IDEMPOTENCY_CONFLICT");
        return { id: prior.id, replayed: true };
      }
      const result = await this.enqueue(input.job);
      occurrences.set(key, { id: result.id, digest });
      return result;
    },
    async transitionEffect(input) {
      const sameOwner = (left: EffectOwner | undefined, right: EffectOwner): boolean =>
        left?.jobId === right.jobId && left.leaseToken === right.leaseToken;
      const ownerActive = (owner: EffectOwner | undefined): boolean => {
        if (owner === undefined) return false;
        const job = jobs.get(owner.jobId);
        const at = now();
        return job?.status === "running" && job.leaseToken === owner.leaseToken && job.leaseExpiresAt !== undefined && job.leaseExpiresAt > at;
      };
      const result = (applied: boolean): EffectTransitionResult => {
        const receipt = effects.get(input.key);
        return Object.freeze({ applied, ...(receipt === undefined ? {} : { receipt }), ownerActive: ownerActive(receipt?.owner) });
      };
      const current = effects.get(input.key);
      if ((input.kind === "succeed" || input.kind === "reconcile-succeeded") && input.result === undefined) {
        throw effectError("EFFECT_RESULT_UNAVAILABLE");
      }
      if (input.kind === "reserve") {
        if (current !== undefined || !ownerActive(input.owner)) return result(false);
        effects.set(input.key, Object.freeze({ key: input.key, state: "pending", owner: Object.freeze({ ...input.owner }), updatedAt: input.updatedAt }));
        return result(true);
      }
      if (input.kind === "succeed") {
        if (current?.state !== "pending" || !sameOwner(current.owner, input.owner) || !ownerActive(input.owner)) return result(false);
        effects.set(input.key, Object.freeze({ key: input.key, state: "succeeded", result: input.result, ...(input.providerReference === undefined ? {} : { providerReference: input.providerReference }), updatedAt: input.updatedAt }));
        return result(true);
      }
      if (input.kind === "uncertain") {
        if (current?.state !== "pending" || !sameOwner(current.owner, input.owner) || !ownerActive(input.owner)) return result(false);
        effects.set(input.key, Object.freeze({ key: input.key, state: "uncertain", owner: Object.freeze({ ...input.owner }), updatedAt: input.updatedAt }));
        return result(true);
      }
      if (
        current === undefined ||
        current.state === "succeeded" ||
        !sameOwner(current.owner, input.expectedOwner) ||
        ownerActive(input.expectedOwner) ||
        !ownerActive(input.owner)
      ) return result(false);
      if (input.kind === "reclaim") {
        effects.set(input.key, Object.freeze({ key: input.key, state: "pending", owner: Object.freeze({ ...input.owner }), updatedAt: input.updatedAt }));
      } else {
        effects.set(input.key, Object.freeze({ key: input.key, state: "succeeded", result: input.result, ...(input.providerReference === undefined ? {} : { providerReference: input.providerReference }), updatedAt: input.updatedAt }));
      }
      return result(true);
    },
    async deadLetters() { return Object.freeze([...jobs.values()].filter(({ status }) => status === "dead")); },
  };
  return Object.freeze(store);
}

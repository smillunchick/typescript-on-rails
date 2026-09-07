import { randomUUID } from "node:crypto";

import {
  copiedDate,
  durableIdentityHash,
  idempotencyConflict,
  immutablePersistedJson,
  jobRequestDigest,
  legacyReconciliationGraph,
  outboxDeliveryIdempotencyKey,
  outboxRequestDigest,
  safeErrorCode,
  scheduleRequestDigest,
  validateAppendOutboxOptions,
  validateReplayOutboxRequest,
} from "./identity.js";

export interface DurableEvent<TPayload = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  parse(value: unknown): TPayload;
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
  readonly outboxId?: string;
  readonly consumerId?: string;
  readonly replayGeneration?: number;
  /** Version of the materialized payload, not the historical envelope. */
  readonly payloadVersion?: number;
  readonly scheduleId?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastErrorCode?: string;
}
export interface EnqueueJob { readonly name: string; readonly payload: unknown; readonly idempotencyKey: string; readonly maximumAttempts?: number; readonly availableAt?: Date; readonly outboxId?: string; readonly consumerId?: string; readonly replayGeneration?: number }

export interface DurableEnvelope {
  readonly occurrenceId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface AppendOutboxOptions {
  readonly idempotencyKey: string;
  readonly occurredAt?: Date;
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly maximumAttempts?: number;
}

export type OutboxState = "ready" | "claimed" | "published" | "partial" | "retry_wait" | "quarantined";
export interface OutboxRecord extends DurableEnvelope {
  /** Legacy dual-write event display name. */
  readonly event: string;
  /** Legacy dual-write schema version. */
  readonly version: number;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly maximumAttempts: number;
  readonly availableAt: Date;
  readonly replayGeneration: number;
  readonly publishedAt?: Date;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastErrorCode?: string;
  readonly quarantineReason?: string;
}

export type OutboxFanoutTarget =
  | {
    readonly kind: "job";
    readonly consumerId: string;
    readonly consumerVersion: number;
    readonly jobName: string;
    readonly payload: unknown;
  }
  | {
    readonly kind: "failed";
    readonly consumerId: string;
    readonly consumerVersion: number;
    readonly errorCode: string;
    readonly permanent: boolean;
  };
export interface OutboxDeliveryReceipt {
  readonly outboxId: string;
  readonly consumerId: string;
  readonly consumerVersion: number;
  readonly replayGeneration: number;
  readonly jobId?: string;
  readonly state: "succeeded" | "failed";
  readonly errorCode?: string;
  readonly permanent: boolean;
  readonly createdAt: Date;
  readonly settledAt?: Date;
}
export interface OutboxReceiptSnapshot { readonly total: number; readonly succeeded: number; readonly failed: number; readonly permanentFailed: number; readonly receipts: readonly OutboxDeliveryReceipt[] }
export interface OutboxHistoryEntry { readonly id: string; readonly outboxId: string; readonly sequence: number; readonly kind: string; readonly actorId?: string; readonly reasonCode?: string; readonly at: Date; readonly details?: unknown }
export interface OutboxHistoryOptions { readonly limit?: number; readonly beforeSequence?: number }
export interface ReplayOutboxRequest { readonly requestId: string; readonly approvedBy: string; readonly reason: string; readonly requestedAt: Date }
export type JobsMigrationState = "Expanded" | "Dual-write" | "Reconciling" | "Cutover";
export interface JobsMigrationStateRecord { readonly state: JobsMigrationState; readonly rollbackRestricted: boolean; readonly reconciliationGraphHash?: string; readonly updatedAt: Date }
export interface LegacyReconciliationCandidate { readonly eventName: string; readonly eventId: string }
export interface LegacyReconciliationResult { readonly resolved: number; readonly unknown: number; readonly ambiguous: number }
export interface MemoryLegacyOutboxRecord {
  readonly id: string;
  readonly eventName: string;
  readonly schemaVersion: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly publishedAt?: Date;
}
export interface MemoryJobStoreOptions { readonly legacyOutbox?: readonly MemoryLegacyOutboxRecord[] }

export interface ScheduleOccurrence { readonly schedule: string; readonly occurrence: string; readonly job: EnqueueJob; readonly identityPayload?: unknown }
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
  appendOutbox<T>(event: DurableEvent<T>, payload: T, options: AppendOutboxOptions): Promise<{ readonly id: string; readonly replayed: boolean }>;
  claim(now: Date, leaseMilliseconds: number): Promise<JobRecord | undefined>;
  renew(id: string, leaseToken: string, leaseMilliseconds: number): Promise<boolean>;
  complete(id: string, leaseToken: string): Promise<boolean>;
  fail(id: string, leaseToken: string, input: { readonly errorCode: string; readonly availableAt: Date; readonly dead: boolean }): Promise<boolean>;
  claimOutbox(now: Date, leaseMilliseconds: number): Promise<OutboxRecord | undefined>;
  materializeFanout(record: OutboxRecord, targets: readonly OutboxFanoutTarget[]): Promise<OutboxReceiptSnapshot>;
  settleOutbox(id: string, leaseToken: string, input:
    | { readonly kind: "published"; readonly at: Date }
    | { readonly kind: "retry"; readonly at: Date; readonly availableAt: Date; readonly errorCode: string }
    | { readonly kind: "quarantine"; readonly at: Date; readonly reason: string }
    | { readonly kind: "partial"; readonly at: Date; readonly availableAt: Date; readonly errorCode: string }): Promise<boolean>;
  requestOutboxReplay(id: string, request: ReplayOutboxRequest): Promise<{ readonly replayed: boolean }>;
  quarantinedOutbox(): Promise<readonly OutboxRecord[]>;
  outboxHistory(id: string, options?: OutboxHistoryOptions): Promise<readonly OutboxHistoryEntry[]>;
  readMigrationState(): Promise<JobsMigrationStateRecord>;
  transitionMigrationState(expected: JobsMigrationState, next: JobsMigrationState, rollbackRestricted?: boolean): Promise<boolean>;
  reconcileLegacyOutbox(candidates: readonly LegacyReconciliationCandidate[], limit?: number): Promise<LegacyReconciliationResult>;
  assertOutboxCapability(capability: "name-only" | "exact"): Promise<void>;
  materialize(input: ScheduleOccurrence): Promise<{ readonly id: string; readonly replayed: boolean }>;
  transitionEffect(input: EffectTransition): Promise<EffectTransitionResult>;
  deadLetters(): Promise<readonly JobRecord[]>;
}

export interface JobHandlerContext { readonly delivery?: Readonly<Pick<JobRecord, "name" | "consumerId" | "outboxId" | "payloadVersion" | "scheduleId">>; readonly jobId: string; readonly attempt: number; readonly signal: AbortSignal; effect<T>(key: string, run: () => Promise<{ readonly value: T; readonly providerReference?: string }>, reconcile?: () => Promise<{ readonly state: "succeeded" | "missing"; readonly value?: T; readonly providerReference?: string }>): Promise<T> }
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
        delivery: Object.freeze({ name: job.name, ...(job.consumerId === undefined ? {} : { consumerId: job.consumerId }), ...(job.outboxId === undefined ? {} : { outboxId: job.outboxId }), ...(job.payloadVersion === undefined ? {} : { payloadVersion: job.payloadVersion }), ...(job.scheduleId === undefined ? {} : { scheduleId: job.scheduleId }) }),
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
        const dead = job.attempts >= job.maximumAttempts || (typeof error === "object" && error !== null && "permanent" in error && error.permanent === true);
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

function jobSnapshot(record: JobRecord): JobRecord {
  const { availableAt, leaseExpiresAt, ...rest } = record;
  return Object.freeze({
    ...rest,
    availableAt: copiedDate(availableAt),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt: copiedDate(leaseExpiresAt) }),
  });
}

function outboxSnapshot(record: OutboxRecord): OutboxRecord {
  const { occurredAt, availableAt, publishedAt, leaseExpiresAt, ...rest } = record;
  return Object.freeze({
    ...rest,
    occurredAt: copiedDate(occurredAt),
    availableAt: copiedDate(availableAt),
    ...(publishedAt === undefined ? {} : { publishedAt: copiedDate(publishedAt) }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt: copiedDate(leaseExpiresAt) }),
  });
}

function receiptSnapshot(value: OutboxDeliveryReceipt): OutboxDeliveryReceipt {
  return Object.freeze({
    ...value,
    createdAt: copiedDate(value.createdAt),
    ...(value.settledAt === undefined ? {} : { settledAt: copiedDate(value.settledAt) }),
  });
}

function historySnapshot(value: OutboxHistoryEntry): OutboxHistoryEntry {
  return Object.freeze({ ...value, at: copiedDate(value.at) });
}

function migrationStateSnapshot(value: JobsMigrationStateRecord): JobsMigrationStateRecord {
  return Object.freeze({ ...value, updatedAt: copiedDate(value.updatedAt) });
}

export function memoryJobStore(
  now: () => Date = () => new Date(),
  options: MemoryJobStoreOptions = {},
): JobStore {
  const jobs = new Map<string, JobRecord>();
  const jobKeys = new Map<string, { readonly id: string; readonly digest: string }>();
  const outbox = new Map<string, OutboxRecord>();
  const outboxKeys = new Map<string, { readonly id: string; readonly digest: string }>();
  const occurrences = new Map<string, { readonly id: string; readonly digest: string; readonly schedule: string }>();
  const effects = new Map<string, EffectReceipt>();
  const receipts = new Map<string, Map<string, Map<number, OutboxDeliveryReceipt>>>();
  const history = new Map<string, OutboxHistoryEntry[]>();
  const replayRequests = new Map<string, { readonly outboxId: string; readonly approvedBy: string; readonly reason: string; readonly requestedAt: number }>();
  const reconciledLegacy = new Set<string>();
  let reconciliationGraphHash: string | undefined;
  let migrationState: JobsMigrationStateRecord = Object.freeze({
    state: "Expanded",
    rollbackRestricted: false,
    updatedAt: copiedDate(now()),
  });

  const appendHistory = (outboxId: string, kind: string, at: Date, input: { actorId?: string; reasonCode?: string; details?: unknown } = {}): void => {
    const entries = history.get(outboxId) ?? [];
    const entry = Object.freeze({
      id: `history_${randomUUID()}`,
      outboxId,
      sequence: entries.length + 1,
      kind,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      at: copiedDate(at),
      ...(input.details === undefined ? {} : { details: immutablePersistedJson(input.details) }),
    });
    entries.push(entry);
    history.set(outboxId, entries);
  };

  const activeOutboxClaim = (record: OutboxRecord): boolean =>
    record.state === "claimed" && record.leaseToken !== undefined && record.leaseExpiresAt !== undefined && record.leaseExpiresAt > now();

  const hasDuplicateEventIdentities = (): boolean => {
    const byName = new Map<string, Set<string>>();
    for (const record of outbox.values()) {
      if (record.eventId === "") continue;
      const identities = byName.get(record.eventName) ?? new Set<string>();
      identities.add(record.eventId);
      if (identities.size > 1) return true;
      byName.set(record.eventName, identities);
    }
    return false;
  };

  const consumerReceipts = (outboxId: string, consumerId: string): Map<number, OutboxDeliveryReceipt> => {
    const byConsumer = receipts.get(outboxId) ?? new Map<string, Map<number, OutboxDeliveryReceipt>>();
    receipts.set(outboxId, byConsumer);
    const generations = byConsumer.get(consumerId) ?? new Map<number, OutboxDeliveryReceipt>();
    byConsumer.set(consumerId, generations);
    return generations;
  };

  for (const legacy of options.legacyOutbox ?? []) {
    if (legacy.id.trim() === "" || legacy.id.length > 80) throw new TypeError("LEGACY_OUTBOX_ID_INVALID");
    if (legacy.eventName.trim() === "" || legacy.eventName.length > 200) throw new TypeError("LEGACY_EVENT_NAME_INVALID");
    if (!Number.isSafeInteger(legacy.schemaVersion) || legacy.schemaVersion < 1) throw new TypeError("LEGACY_EVENT_VERSION_INVALID");
    if (legacy.idempotencyKey.trim() === "" || legacy.idempotencyKey.length > 300) throw new TypeError("LEGACY_OUTBOX_IDEMPOTENCY_KEY_INVALID");
    if (!(legacy.createdAt instanceof Date) || Number.isNaN(legacy.createdAt.getTime()) || (legacy.publishedAt !== undefined && (!(legacy.publishedAt instanceof Date) || Number.isNaN(legacy.publishedAt.getTime())))) {
      throw new TypeError("LEGACY_OUTBOX_TIME_INVALID");
    }
    if (outbox.has(legacy.id) || outboxKeys.has(legacy.idempotencyKey)) throw new TypeError("DUPLICATE_LEGACY_OUTBOX_RECORD");
    const createdAt = copiedDate(legacy.createdAt);
    const record = Object.freeze({
      id: legacy.id,
      occurrenceId: legacy.id,
      eventId: "",
      eventName: legacy.eventName,
      schemaVersion: legacy.schemaVersion,
      event: legacy.eventName,
      version: legacy.schemaVersion,
      payload: immutablePersistedJson(legacy.payload),
      occurredAt: copiedDate(createdAt),
      requestId: `legacy:${legacy.id}`,
      correlationId: `legacy:${legacy.id}`,
      idempotencyKey: legacy.idempotencyKey,
      state: legacy.publishedAt === undefined ? "ready" as const : "published" as const,
      attempts: 0,
      maximumAttempts: 5,
      availableAt: copiedDate(createdAt),
      replayGeneration: 0,
      ...(legacy.publishedAt === undefined ? {} : { publishedAt: copiedDate(legacy.publishedAt) }),
    });
    outbox.set(legacy.id, record);
    outboxKeys.set(legacy.idempotencyKey, { id: legacy.id, digest: `legacy:${legacy.id}` });
  }

  const store: JobStore = {
    async enqueue(input) {
      const digest = jobRequestDigest(input);
      const prior = jobKeys.get(input.idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw idempotencyConflict("JOB_IDEMPOTENCY_CONFLICT");
        return { id: prior.id, replayed: true };
      }
      const id = `job_${randomUUID()}`;
      jobs.set(id, Object.freeze({
        id,
        name: input.name,
        payload: immutablePersistedJson(input.payload),
        idempotencyKey: input.idempotencyKey,
        status: "queued",
        attempts: 0,
        maximumAttempts: input.maximumAttempts ?? 5,
        availableAt: copiedDate(input.availableAt ?? now()),
        ...(input.outboxId === undefined ? {} : { outboxId: input.outboxId }),
        ...(input.consumerId === undefined ? {} : { consumerId: input.consumerId }),
        ...(input.replayGeneration === undefined ? {} : { replayGeneration: input.replayGeneration }),
      }));
      jobKeys.set(input.idempotencyKey, { id, digest });
      return { id, replayed: false };
    },
    async appendOutbox(event, payload, options) {
      validateAppendOutboxOptions(options);
      event.parse(payload);
      const occurredAt = copiedDate(options.occurredAt ?? now());
      const digest = outboxRequestDigest(event, payload, options);
      const persistedPayload = immutablePersistedJson(payload);
      const prior = outboxKeys.get(options.idempotencyKey);
      if (prior !== undefined) {
        if (prior.digest !== digest) throw idempotencyConflict("OUTBOX_IDEMPOTENCY_CONFLICT");
        return { id: prior.id, replayed: true };
      }
      const id = `outbox_${randomUUID()}`;
      outbox.set(id, Object.freeze({
        id,
        occurrenceId: id,
        eventId: event.id,
        eventName: event.name,
        schemaVersion: event.version,
        event: event.name,
        version: event.version,
        payload: persistedPayload,
        occurredAt,
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
        ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
        requestId: options.requestId,
        correlationId: options.correlationId,
        ...(options.causationId === undefined ? {} : { causationId: options.causationId }),
        idempotencyKey: options.idempotencyKey,
        state: "ready",
        attempts: 0,
        maximumAttempts: options.maximumAttempts ?? 5,
        availableAt: copiedDate(occurredAt),
        replayGeneration: 0,
      }));
      outboxKeys.set(options.idempotencyKey, { id, digest });
      appendHistory(id, "appended", occurredAt);
      return { id, replayed: false };
    },
    async claim(at, leaseMilliseconds) {
      const candidate = [...jobs.values()].filter((job) => (job.status === "queued" || (job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= at)) && job.availableAt <= at).sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime() || a.id.localeCompare(b.id))[0];
      if (candidate === undefined) return undefined;
      const leaseToken = randomUUID();
      const claimed = Object.freeze({ ...candidate, status: "running" as const, attempts: candidate.attempts + 1, leaseToken, leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds) });
      jobs.set(candidate.id, claimed);
      const delivery = candidate.outboxId === undefined || candidate.consumerId === undefined ? undefined
        : receipts.get(candidate.outboxId)?.get(candidate.consumerId)?.get(candidate.replayGeneration ?? 0);
      const payloadVersion = delivery?.state === "succeeded" && delivery.jobId === candidate.id ? delivery.consumerVersion : undefined;
      const schedules = [...occurrences.values()].filter(({ id }) => id === candidate.id);
      if (schedules.length > 1) return jobSnapshot(claimed);
      const schedule = schedules[0];
      return jobSnapshot({ ...claimed, ...(payloadVersion === undefined ? {} : { payloadVersion }), ...(schedule === undefined ? {} : { scheduleId: schedule.schedule }) });
    },
    async renew(id, leaseToken, leaseMilliseconds) {
      const current = jobs.get(id);
      const at = now();
      if (current?.status !== "running" || current.leaseToken !== leaseToken || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= at) return false;
      jobs.set(id, Object.freeze({ ...current, leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds) }));
      return true;
    },
    async complete(id, leaseToken) {
      const current = jobs.get(id);
      const at = now();
      if (current?.status !== "running" || current.leaseToken !== leaseToken || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= at) return false;
      const { leaseToken: _token, leaseExpiresAt: _expiry, ...rest } = current;
      jobs.set(id, Object.freeze({ ...rest, status: "succeeded" as const }));
      return true;
    },
    async fail(id, leaseToken, input) {
      const current = jobs.get(id);
      const at = now();
      if (current?.status !== "running" || current.leaseToken !== leaseToken || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= at) return false;
      const { leaseToken: _token, leaseExpiresAt: _expiry, ...rest } = current;
      jobs.set(id, Object.freeze({ ...rest, status: input.dead ? "dead" as const : "queued" as const, availableAt: copiedDate(input.availableAt), lastErrorCode: input.errorCode }));
      return true;
    },
    async claimOutbox(at, leaseMilliseconds) {
      const candidate = [...outbox.values()]
        .filter((record) =>
          record.eventId !== "" && (((record.state === "ready" || record.state === "partial" || record.state === "retry_wait") && record.availableAt <= at) ||
          (record.state === "claimed" && record.leaseExpiresAt !== undefined && record.leaseExpiresAt <= at)),
        )
        .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime() || left.id.localeCompare(right.id))[0];
      if (candidate === undefined) return undefined;
      const claimed = Object.freeze({
        ...candidate,
        state: "claimed" as const,
        attempts: candidate.attempts + 1,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(at.getTime() + leaseMilliseconds),
      });
      outbox.set(candidate.id, claimed);
      appendHistory(candidate.id, candidate.state === "claimed" ? "claim_expired" : "claimed", at);
      return outboxSnapshot(claimed);
    },
    async materializeFanout(record, targets) {
      const current = outbox.get(record.id);
      if (current === undefined || current.leaseToken !== record.leaseToken || !activeOutboxClaim(current)) {
        throw Object.assign(new Error("OUTBOX_FENCE_LOST"), { code: "OUTBOX_FENCE_LOST" });
      }
      const consumerIds = new Set<string>();
      const identitiesByHash = new Map<string, string>();
      for (const target of targets) {
        if (consumerIds.has(target.consumerId)) throw new TypeError(`DUPLICATE_FANOUT_TARGET:${target.consumerId}`);
        consumerIds.add(target.consumerId);
        const identityHash = durableIdentityHash(target.consumerId);
        const collision = identitiesByHash.get(identityHash);
        if (collision !== undefined && collision !== target.consumerId) throw new Error("DURABLE_IDENTITY_HASH_COLLISION");
        identitiesByHash.set(identityHash, target.consumerId);
      }
      const staged: Array<{
        target: OutboxFanoutTarget;
        state: "succeeded" | "failed";
        permanent: boolean;
        errorCode?: string;
        createdAt?: Date;
        jobId?: string;
        job?: { input: EnqueueJob; digest: string };
      }> = [];
      for (const target of targets) {
        const generations = consumerReceipts(record.occurrenceId, target.consumerId);
        const currentReceipt = generations.get(record.replayGeneration);
        if (currentReceipt !== undefined && (currentReceipt.state === "succeeded" || currentReceipt.permanent)) continue;
        const priorSuccess = [...generations.values()]
          .filter((value) => value.replayGeneration < record.replayGeneration && value.state === "succeeded")
          .sort((left, right) => right.replayGeneration - left.replayGeneration)[0];
        if (priorSuccess?.jobId !== undefined) {
          staged.push({ target, state: "succeeded", permanent: false, ...(currentReceipt === undefined ? {} : { createdAt: currentReceipt.createdAt }), jobId: priorSuccess.jobId });
          continue;
        }
        if (target.kind === "failed") {
          staged.push({ target, state: "failed", permanent: target.permanent, errorCode: target.errorCode, ...(currentReceipt === undefined ? {} : { createdAt: currentReceipt.createdAt }) });
          continue;
        }
        const key = outboxDeliveryIdempotencyKey(record.occurrenceId, target.consumerId, record.replayGeneration);
        const payload = immutablePersistedJson(target.payload);
        const input: EnqueueJob = { name: target.jobName, payload, idempotencyKey: key, outboxId: record.occurrenceId, consumerId: target.consumerId, replayGeneration: record.replayGeneration };
        const digest = jobRequestDigest(input);
        const prior = jobKeys.get(key);
        const failed = prior !== undefined && prior.digest !== digest;
        staged.push({ target, state: failed ? "failed" : "succeeded", permanent: failed, ...(failed ? { errorCode: "JOB_IDEMPOTENCY_CONFLICT" } : {}), ...(currentReceipt === undefined ? {} : { createdAt: currentReceipt.createdAt }), jobId: prior?.id ?? `job_${randomUUID()}`, ...(failed ? {} : { job: { input, digest } }) });
      }
      const settledAt = copiedDate(now());
      for (const item of staged) {
        if (item.job !== undefined && item.jobId !== undefined && !jobs.has(item.jobId)) {
          jobs.set(item.jobId, Object.freeze({ id: item.jobId, name: item.job.input.name, payload: item.job.input.payload, idempotencyKey: item.job.input.idempotencyKey, status: "queued", attempts: 0, maximumAttempts: 5, availableAt: copiedDate(settledAt), outboxId: record.occurrenceId, consumerId: item.target.consumerId, replayGeneration: record.replayGeneration }));
          jobKeys.set(item.job.input.idempotencyKey, { id: item.jobId, digest: item.job.digest });
        }
        consumerReceipts(record.occurrenceId, item.target.consumerId).set(record.replayGeneration, Object.freeze({
          outboxId: record.occurrenceId,
          consumerId: item.target.consumerId,
          consumerVersion: item.target.consumerVersion,
          replayGeneration: record.replayGeneration,
          ...(item.jobId === undefined ? {} : { jobId: item.jobId }),
          state: item.state,
          ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }),
          permanent: item.permanent,
          createdAt: copiedDate(item.createdAt ?? settledAt),
          settledAt: copiedDate(settledAt),
        }));
      }
      const snapshot = targets
        .map(({ consumerId }) => consumerReceipts(record.occurrenceId, consumerId).get(record.replayGeneration))
        .filter((value): value is OutboxDeliveryReceipt => value !== undefined)
        .sort((left, right) => left.consumerId.localeCompare(right.consumerId));
      return Object.freeze({ total: targets.length, succeeded: snapshot.filter(({ state }) => state === "succeeded").length, failed: snapshot.filter(({ state }) => state === "failed").length, permanentFailed: snapshot.filter(({ state, permanent }) => state === "failed" && permanent).length, receipts: Object.freeze(snapshot.map(receiptSnapshot)) });
    },
    async settleOutbox(id, leaseToken, input) {
      const current = outbox.get(id);
      if (current === undefined || current.leaseToken !== leaseToken || !activeOutboxClaim(current)) {
        if (current !== undefined) appendHistory(id, "fence_lost", input.at);
        return false;
      }
      const { leaseToken: _token, leaseExpiresAt: _expiry, ...rest } = current;
      if (input.kind === "published") {
        outbox.set(id, Object.freeze({ ...rest, state: "published" as const, publishedAt: copiedDate(input.at) }));
        appendHistory(id, "published", input.at);
      } else if (input.kind === "retry") {
        outbox.set(id, Object.freeze({ ...rest, state: "retry_wait" as const, availableAt: copiedDate(input.availableAt), lastErrorCode: input.errorCode }));
        appendHistory(id, "retry_scheduled", input.at, { reasonCode: input.errorCode });
      } else if (input.kind === "partial") {
        outbox.set(id, Object.freeze({ ...rest, state: "partial" as const, availableAt: copiedDate(input.availableAt), lastErrorCode: input.errorCode }));
        appendHistory(id, "partial", input.at, { reasonCode: input.errorCode });
      } else {
        outbox.set(id, Object.freeze({ ...rest, state: "quarantined" as const, quarantineReason: input.reason, lastErrorCode: input.reason }));
        appendHistory(id, "quarantined", input.at, { reasonCode: input.reason });
      }
      return true;
    },
    async requestOutboxReplay(id, request) {
      validateReplayOutboxRequest(request);
      const current = outbox.get(id);
      if (current === undefined) throw new Error(`OUTBOX_NOT_FOUND:${id}`);
      const existing = replayRequests.get(request.requestId);
      if (existing !== undefined) {
        if (existing.outboxId !== id || existing.approvedBy !== request.approvedBy || existing.reason !== request.reason || existing.requestedAt !== request.requestedAt.getTime()) {
          throw new Error("REPLAY_REQUEST_CONFLICT");
        }
        return { replayed: true };
      }
      if (current.state !== "quarantined") throw new Error("OUTBOX_NOT_QUARANTINED");
      if (current.eventId === "") throw new Error("OUTBOX_IDENTITY_UNRESOLVED");
      replayRequests.set(request.requestId, {
        outboxId: id,
        approvedBy: request.approvedBy,
        reason: request.reason,
        requestedAt: request.requestedAt.getTime(),
      });
      const { leaseToken: _token, leaseExpiresAt: _expiry, quarantineReason: _reason, ...rest } = current;
      outbox.set(id, Object.freeze({ ...rest, state: "ready" as const, availableAt: copiedDate(request.requestedAt), replayGeneration: current.replayGeneration + 1 }));
      appendHistory(id, "replay_requested", request.requestedAt, {
        actorId: request.approvedBy,
        reasonCode: "REPLAY_APPROVED",
        details: { requestId: request.requestId, reason: request.reason },
      });
      return { replayed: false };
    },
    async quarantinedOutbox() {
      return Object.freeze([...outbox.values()].filter(({ state }) => state === "quarantined").map(outboxSnapshot));
    },
    async outboxHistory(id, options = {}) {
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("OUTBOX_HISTORY_LIMIT_INVALID");
      if (options.beforeSequence !== undefined && (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 1)) {
        throw new TypeError("OUTBOX_HISTORY_SEQUENCE_INVALID");
      }
      const entries = (history.get(id) ?? []).filter(({ sequence }) => options.beforeSequence === undefined || sequence < options.beforeSequence);
      return Object.freeze(entries.slice(Math.max(0, entries.length - limit)).map(historySnapshot));
    },
    async readMigrationState() {
      return migrationStateSnapshot({ ...migrationState, rollbackRestricted: migrationState.rollbackRestricted || hasDuplicateEventIdentities() });
    },
    async transitionMigrationState(expected, next, rollbackRestricted = false) {
      const order: readonly JobsMigrationState[] = ["Expanded", "Dual-write", "Reconciling", "Cutover"];
      if (migrationState.state !== expected || order.indexOf(next) !== order.indexOf(expected) + 1) return false;
      if (next === "Cutover" && [...outbox.values()].some((record) => record.eventId === "" && !reconciledLegacy.has(record.id))) return false;
      migrationState = Object.freeze({ state: next, rollbackRestricted: migrationState.rollbackRestricted || rollbackRestricted || next === "Cutover", ...(reconciliationGraphHash === undefined ? {} : { reconciliationGraphHash }), updatedAt: copiedDate(now()) });
      return true;
    },
    async reconcileLegacyOutbox(candidates, limit = 100) {
      if (migrationState.state !== "Reconciling") throw new Error("JOBS_RECONCILIATION_STATE_INVALID");
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("JOBS_RECONCILIATION_LIMIT_INVALID");
      const { byName, hash } = legacyReconciliationGraph(candidates);
      if (reconciliationGraphHash !== undefined && reconciliationGraphHash !== hash) throw new Error("JOBS_RECONCILIATION_GRAPH_CHANGED");
      reconciliationGraphHash = hash;
      migrationState = Object.freeze({ ...migrationState, reconciliationGraphHash: hash, updatedAt: copiedDate(now()) });
      let resolved = 0;
      let unknown = 0;
      let ambiguous = 0;
      const legacyRecords = [...outbox.values()]
        .filter(({ id, eventId }) => eventId === "" && !reconciledLegacy.has(id))
        .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id))
        .slice(0, limit);
      for (const record of legacyRecords) {
        const ids = [...(byName.get(record.eventName) ?? [])];
        reconciledLegacy.add(record.id);
        if (ids.length === 1) {
          outbox.set(record.id, Object.freeze({ ...record, eventId: ids[0] as string }));
          resolved += 1;
        } else {
          const reason = ids.length === 0 ? "LEGACY_EVENT_UNKNOWN" : "LEGACY_EVENT_AMBIGUOUS";
          outbox.set(record.id, Object.freeze({ ...record, state: "quarantined" as const, quarantineReason: reason }));
          appendHistory(record.id, "quarantined", now(), { reasonCode: reason });
          if (ids.length === 0) unknown += 1;
          else ambiguous += 1;
        }
      }
      if (ambiguous > 0 || [...byName.values()].some((ids) => ids.size > 1)) migrationState = Object.freeze({ ...migrationState, rollbackRestricted: true, updatedAt: copiedDate(now()) });
      return Object.freeze({ resolved, unknown, ambiguous });
    },
    async assertOutboxCapability(capability) {
      if (capability === "name-only" && (migrationState.rollbackRestricted || hasDuplicateEventIdentities())) {
        throw new Error("NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN");
      }
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
      occurrences.set(key, { id: result.id, digest, schedule: input.schedule });
      return result;
    },
    async transitionEffect(input) {
      const sameOwner = (left: EffectOwner | undefined, right: EffectOwner): boolean => left?.jobId === right.jobId && left.leaseToken === right.leaseToken;
      const ownerActive = (owner: EffectOwner | undefined): boolean => {
        if (owner === undefined) return false;
        const record = jobs.get(owner.jobId);
        const at = now();
        return record?.status === "running" && record.leaseToken === owner.leaseToken && record.leaseExpiresAt !== undefined && record.leaseExpiresAt > at;
      };
      const result = (applied: boolean): EffectTransitionResult => {
        const receipt = effects.get(input.key);
        return Object.freeze({ applied, ...(receipt === undefined ? {} : { receipt }), ownerActive: ownerActive(receipt?.owner) });
      };
      const current = effects.get(input.key);
      if ((input.kind === "succeed" || input.kind === "reconcile-succeeded") && input.result === undefined) throw effectError("EFFECT_RESULT_UNAVAILABLE");
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
      if (current === undefined || current.state === "succeeded" || !sameOwner(current.owner, input.expectedOwner) || ownerActive(input.expectedOwner) || !ownerActive(input.owner)) return result(false);
      if (input.kind === "reclaim") {
        effects.set(input.key, Object.freeze({ key: input.key, state: "pending", owner: Object.freeze({ ...input.owner }), updatedAt: input.updatedAt }));
      } else {
        effects.set(input.key, Object.freeze({ key: input.key, state: "succeeded", result: input.result, ...(input.providerReference === undefined ? {} : { providerReference: input.providerReference }), updatedAt: input.updatedAt }));
      }
      return result(true);
    },
    async deadLetters() { return Object.freeze([...jobs.values()].filter(({ status }) => status === "dead").map(jobSnapshot)); },
  };
  return Object.freeze(store);
}

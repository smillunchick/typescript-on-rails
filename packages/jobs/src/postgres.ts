import { randomUUID } from "node:crypto";

import { type Kysely, sql, type Transaction } from "kysely";
import type { Migration } from "kysely/migration";

import type {
  AppendOutboxOptions,
  DurableEvent,
  EffectReceipt,
  EffectTransition,
  EffectTransitionResult,
  EnqueueJob,
  JobRecord,
  JobStatus,
  JobStore,
  JobsMigrationState,
  JobsMigrationStateRecord,
  LegacyReconciliationCandidate,
  LegacyReconciliationResult,
  OutboxDeliveryReceipt,
  OutboxFanoutTarget,
  OutboxHistoryEntry,
  OutboxReceiptSnapshot,
  OutboxRecord,
  ReplayOutboxRequest,
  ScheduleOccurrence,
} from "./jobs.js";
import {
  copiedDate,
  durableIdentityHash,
  idempotencyConflict,
  immutablePersistedJson,
  jobRequestDigest,
  legacyReconciliationGraph,
  outboxDeliveryIdempotencyKey,
  outboxRequestDigest,
  scheduleRequestDigest,
  validateAppendOutboxOptions,
  validateReplayOutboxRequest,
} from "./identity.js";

interface JobRow {
  id: string;
  name: string;
  payload: unknown;
  idempotency_key: string;
  request_digest: string;
  status: string;
  attempts: number;
  maximum_attempts: number;
  available_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  outbox_id: string | null;
  consumer_id: string | null;
  consumer_id_hash: string | null;
  replay_generation: number;
}

interface OutboxRow {
  id: string;
  event: string;
  version: number;
  payload: unknown;
  idempotency_key: string;
  request_digest: string;
  event_id: string | null;
  event_id_hash: string | null;
  occurred_at: Date | null;
  tenant_id: string | null;
  actor_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  state: string;
  attempts: number;
  maximum_attempts: number;
  available_at: Date;
  published_at: Date | null;
  created_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  last_error_code: string | null;
  quarantine_reason: string | null;
  replay_generation: number;
}

interface ClaimedOutboxRow extends OutboxRow {
  lease_token: string;
  lease_expires_at: Date;
  claimed_at: Date;
}

interface EffectRow {
  effect_key: string;
  state: string;
  result: unknown | null;
  result_present: boolean;
  provider_reference: string | null;
  claim_job_id: string | null;
  claim_token: string | null;
  updated_at: Date;
}

interface EffectReadRow extends EffectRow {
  owner_active: boolean;
}

export interface JobDatabase {
  tor_jobs: JobRow;
  tor_outbox: OutboxRow;
  tor_schedule_occurrences: { schedule: string; occurrence: string; job_id: string; request_digest: string };
  tor_effect_receipts: EffectRow;
  tor_outbox_delivery_receipts: { outbox_id: string; consumer_id: string; consumer_id_hash: string; consumer_version: number; replay_generation: number; job_id: string | null; state: string; error_code: string | null; permanent: boolean; created_at: Date; settled_at: Date | null };
  tor_outbox_history: { id: string; outbox_id: string; sequence: number; kind: string; actor_id: string | null; reason_code: string | null; at: Date; details: unknown | null };
  tor_outbox_replay_requests: { request_id: string; outbox_id: string; approved_by: string; reason: string; requested_at: Date };
  tor_jobs_migration_state: { singleton: number; state: string; rollback_restricted: boolean; reconciliation_graph_hash: string | null; updated_at: Date };
  tor_outbox_reconciliation: { outbox_id: string; graph_hash: string; classification: string; resolved_event_id: string | null; at: Date };
}

export const jobsMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable("tor_jobs")
      .ifNotExists()
      .addColumn("id", "varchar(80)", (column) => column.primaryKey())
      .addColumn("name", "varchar(200)", (column) => column.notNull())
      .addColumn("payload", "jsonb", (column) => column.notNull())
      .addColumn("idempotency_key", "varchar(300)", (column) => column.notNull().unique())
      .addColumn("request_digest", "varchar(64)", (column) => column.notNull())
      .addColumn("status", "varchar(20)", (column) => column.notNull())
      .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
      .addColumn("maximum_attempts", "integer", (column) => column.notNull())
      .addColumn("available_at", "timestamptz", (column) => column.notNull())
      .addColumn("lease_token", "varchar(80)")
      .addColumn("lease_expires_at", "timestamptz")
      .addColumn("last_error_code", "varchar(100)")
      .execute();
    await db.schema
      .createIndex("tor_jobs_due")
      .ifNotExists()
      .on("tor_jobs")
      .columns(["status", "available_at"])
      .execute();
    await db.schema
      .createTable("tor_outbox")
      .ifNotExists()
      .addColumn("id", "varchar(80)", (column) => column.primaryKey())
      .addColumn("event", "varchar(200)", (column) => column.notNull())
      .addColumn("version", "integer", (column) => column.notNull())
      .addColumn("payload", "jsonb", (column) => column.notNull())
      .addColumn("idempotency_key", "varchar(300)", (column) => column.notNull().unique())
      .addColumn("request_digest", "varchar(64)", (column) => column.notNull())
      .addColumn("published_at", "timestamptz")
      .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
      .addColumn("lease_token", "varchar(80)")
      .addColumn("lease_expires_at", "timestamptz")
      .execute();
    await db.schema
      .createTable("tor_schedule_occurrences")
      .ifNotExists()
      .addColumn("schedule", "varchar(200)", (column) => column.notNull())
      .addColumn("occurrence", "varchar(100)", (column) => column.notNull())
      .addColumn("job_id", "varchar(80)", (column) => column.notNull().references("tor_jobs.id"))
      .addColumn("request_digest", "varchar(64)", (column) => column.notNull())
      .addPrimaryKeyConstraint("tor_schedule_occurrences_pk", ["schedule", "occurrence"])
      .execute();
    await db.schema
      .createTable("tor_effect_receipts")
      .ifNotExists()
      .addColumn("effect_key", "varchar(300)", (column) => column.primaryKey())
      .addColumn("state", "varchar(20)", (column) => column.notNull())
      .addColumn("result", "jsonb")
      .addColumn("result_present", "boolean", (column) => column.notNull().defaultTo(false))
      .addColumn("provider_reference", "varchar(300)")
      .addColumn("claim_job_id", "varchar(80)", (column) => column.references("tor_jobs.id"))
      .addColumn("claim_token", "varchar(80)")
      .addColumn("updated_at", "timestamptz", (column) => column.notNull())
      .execute();
  },
  async down(db) {
    await db.schema.dropTable("tor_effect_receipts").ifExists().execute();
    await db.schema.dropTable("tor_schedule_occurrences").ifExists().execute();
    await db.schema.dropTable("tor_outbox").ifExists().execute();
    await db.schema.dropTable("tor_jobs").ifExists().execute();
  },
};

function jobStatus(value: string): JobStatus {
  if (value === "queued" || value === "running" || value === "succeeded" || value === "dead") {
    return value;
  }
  throw new Error(`INVALID_JOB_STATUS:${value}`);
}

function effectState(value: string): EffectReceipt["state"] {
  if (value === "pending" || value === "succeeded" || value === "uncertain") return value;
  throw new Error(`INVALID_EFFECT_STATE:${value}`);
}

function effectReceipt(row: EffectRow): EffectReceipt {
  const state = effectState(row.state);
  return Object.freeze({
    key: row.effect_key,
    state,
    ...(row.claim_job_id === null || row.claim_token === null
      ? {}
      : { owner: Object.freeze({ jobId: row.claim_job_id, leaseToken: row.claim_token }) }),
    ...(row.result_present ? { result: row.result } : {}),
    ...(row.provider_reference === null ? {} : { providerReference: row.provider_reference }),
    updatedAt: copiedDate(row.updated_at),
  });
}

function job(row: JobRow): JobRecord {
  return Object.freeze({
    id: row.id,
    name: row.name,
    payload: immutablePersistedJson(row.payload),
    idempotencyKey: row.idempotency_key,
    status: jobStatus(row.status),
    attempts: row.attempts,
    maximumAttempts: row.maximum_attempts,
    availableAt: copiedDate(row.available_at),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: copiedDate(row.lease_expires_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.outbox_id === null ? {} : { outboxId: row.outbox_id }),
    ...(row.consumer_id === null ? {} : { consumerId: row.consumer_id }),
    ...(row.outbox_id === null ? {} : { replayGeneration: row.replay_generation }),
  });
}

function outboxState(value: string): OutboxRecord["state"] {
  if (value === "ready" || value === "claimed" || value === "published" || value === "partial" || value === "retry_wait" || value === "quarantined") return value;
  throw new Error(`INVALID_OUTBOX_STATE:${value}`);
}

function outboxRecord(row: OutboxRow): OutboxRecord {
  return Object.freeze({
    id: row.id,
    occurrenceId: row.id,
    eventId: row.event_id ?? "",
    eventName: row.event,
    schemaVersion: row.version,
    event: row.event,
    version: row.version,
    payload: immutablePersistedJson(row.payload),
    occurredAt: copiedDate(row.occurred_at ?? row.created_at),
    ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
    ...(row.actor_id === null ? {} : { actorId: row.actor_id }),
    requestId: row.request_id ?? `legacy:${row.id}`,
    correlationId: row.correlation_id ?? `legacy:${row.id}`,
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    idempotencyKey: row.idempotency_key,
    state: outboxState(row.state),
    attempts: row.attempts,
    maximumAttempts: row.maximum_attempts,
    availableAt: copiedDate(row.available_at),
    replayGeneration: row.replay_generation,
    ...(row.published_at === null ? {} : { publishedAt: copiedDate(row.published_at) }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: copiedDate(row.lease_expires_at) }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
    ...(row.quarantine_reason === null ? {} : { quarantineReason: row.quarantine_reason }),
  });
}

function isTransactionExecutor<DB>(executor: Kysely<DB> | Transaction<DB>): executor is Transaction<DB> {
  return executor.isTransaction;
}

function inTransaction<DB, T>(
  executor: Kysely<DB> | Transaction<DB>,
  operation: (transaction: Transaction<DB>) => Promise<T>,
): Promise<T> {
  return isTransactionExecutor(executor) ? operation(executor) : executor.transaction().execute(operation);
}

async function enqueueWithExecutor<DB>(
  executor: Kysely<DB> | Transaction<DB>,
  input: EnqueueJob,
): Promise<{ readonly id: string; readonly replayed: boolean }> {
  const id = `job_${randomUUID()}`;
  const digest = jobRequestDigest(input);
  const consumerIdHash = input.consumerId === undefined ? null : durableIdentityHash(input.consumerId);
  const availableAt = input.availableAt ?? null;
  const inserted = await sql<{ id: string }>`
    insert into tor_jobs
      (id, name, payload, idempotency_key, request_digest, status, attempts, maximum_attempts,
       available_at, lease_token, lease_expires_at, last_error_code, outbox_id, consumer_id,
       consumer_id_hash, replay_generation)
    values
      (${id}, ${input.name}, ${JSON.stringify(input.payload)}::jsonb, ${input.idempotencyKey},
       ${digest}, 'queued', 0, ${input.maximumAttempts ?? 5}, coalesce(${availableAt}, now()),
       null, null, null, ${input.outboxId ?? null}, ${input.consumerId ?? null},
       ${consumerIdHash}, ${input.replayGeneration ?? 0})
    on conflict (idempotency_key) do nothing
    returning id
  `.execute(executor);
  if (inserted.rows[0] !== undefined) return { id: inserted.rows[0].id, replayed: false };
  const prior = await sql<{ id: string; request_digest: string }>`
    select id, request_digest from tor_jobs where idempotency_key = ${input.idempotencyKey}
  `.execute(executor);
  const existing = prior.rows[0];
  if (existing === undefined) throw new Error("JOB_IDEMPOTENCY_CONFLICT_WITHOUT_ROW");
  if (existing.request_digest !== digest) throw idempotencyConflict("JOB_IDEMPOTENCY_CONFLICT");
  return { id: existing.id, replayed: true };
}

async function appendOutboxWithExecutor<DB, T>(
  executor: Transaction<DB>,
  event: DurableEvent<T>,
  payload: T,
  options: AppendOutboxOptions,
): Promise<{ readonly id: string; readonly replayed: boolean }> {
  validateAppendOutboxOptions(options);
  event.parse(payload);
  const id = `outbox_${randomUUID()}`;
  const occurredAt = options.occurredAt === undefined ? null : copiedDate(options.occurredAt);
  const digest = outboxRequestDigest(event, payload, options);
  const eventIdHash = durableIdentityHash(event.id);
  const inserted = await sql<{ id: string; occurred_at: Date }>`
    insert into tor_outbox
      (id, event, version, payload, idempotency_key, request_digest, published_at, created_at,
       lease_token, lease_expires_at, event_id, event_id_hash, occurred_at, tenant_id, actor_id, request_id,
       correlation_id, causation_id, state, attempts, maximum_attempts, available_at,
       last_error_code, quarantine_reason, replay_generation, migration_classification)
    values
      (${id}, ${event.name}, ${event.version}, ${JSON.stringify(payload)}::jsonb,
       ${options.idempotencyKey}, ${digest}, null, coalesce(${occurredAt}, now()), null, null, ${event.id},
       ${eventIdHash}, coalesce(${occurredAt}, now()), ${options.tenantId ?? null}, ${options.actorId ?? null}, ${options.requestId},
       ${options.correlationId}, ${options.causationId ?? null}, 'ready', 0,
       ${options.maximumAttempts ?? 5}, coalesce(${occurredAt}, now()), null, null, 0, 'exact')
    on conflict (idempotency_key) do nothing
    returning id, occurred_at
  `.execute(executor);
  if (inserted.rows[0] !== undefined) {
    await sql`
      insert into tor_outbox_history (id, outbox_id, sequence, kind, actor_id, reason_code, at, details)
      values (${`history_${randomUUID()}`}, ${inserted.rows[0].id}, 1, 'appended', null, null, ${inserted.rows[0].occurred_at}, null)
    `.execute(executor);
    return { id: inserted.rows[0].id, replayed: false };
  }
  const prior = await sql<{ id: string; request_digest: string }>`
    select id, request_digest from tor_outbox where idempotency_key = ${options.idempotencyKey}
  `.execute(executor);
  const existing = prior.rows[0];
  if (existing === undefined) throw new Error("OUTBOX_IDEMPOTENCY_CONFLICT_WITHOUT_ROW");
  if (existing.request_digest !== digest) throw idempotencyConflict("OUTBOX_IDEMPOTENCY_CONFLICT");
  return { id: existing.id, replayed: true };
}

export function postgresJobWriter<DB>(executor: Kysely<DB> | Transaction<DB>) {
  return Object.freeze({
    enqueue(input: EnqueueJob) {
      return enqueueWithExecutor(executor, input);
    },
    appendOutbox<T>(event: DurableEvent<T>, payload: T, options: AppendOutboxOptions) {
      return inTransaction(executor, (transaction) => appendOutboxWithExecutor(transaction, event, payload, options));
    },
  });
}

export function postgresOutboxWriter<DB>(
  executor: Kysely<DB> | Transaction<DB>,
  context: { readonly tenantId: string; readonly actorId: string; readonly requestId: string; readonly correlationId?: string },
) {
  return Object.freeze({
    appendOutbox<T>(event: DurableEvent<T>, payload: T, idempotencyKey: string, lineage: { readonly causationId?: string; readonly correlationId?: string } = {}) {
      const options: AppendOutboxOptions = {
        idempotencyKey,
        tenantId: context.tenantId,
        actorId: context.actorId,
        requestId: context.requestId,
        correlationId: lineage.correlationId ?? context.correlationId ?? context.requestId,
        ...(lineage.causationId === undefined ? {} : { causationId: lineage.causationId }),
      };
      return inTransaction(executor, (transaction) => appendOutboxWithExecutor(transaction, event, payload, options));
    },
  });
}

async function effectTransitionResult<DB>(
  db: Kysely<DB>,
  key: string,
  applied: boolean,
): Promise<EffectTransitionResult> {
  const selected = await sql<EffectReadRow>`
    select receipt.*,
      exists (
        select 1 from tor_jobs as job
        where job.id = receipt.claim_job_id
          and job.status = 'running'
          and job.lease_token = receipt.claim_token
          and job.lease_expires_at > now()
      ) as owner_active
    from tor_effect_receipts as receipt
    where receipt.effect_key = ${key}
  `.execute(db);
  const row = selected.rows[0];
  return Object.freeze({
    applied,
    ...(row === undefined ? {} : { receipt: effectReceipt(row) }),
    ownerActive: row?.owner_active ?? false,
  });
}

async function appendOutboxHistory<DB>(
  executor: Kysely<DB> | Transaction<DB>,
  outboxId: string,
  kind: string,
  at: Date,
  input: { readonly actorId?: string; readonly reasonCode?: string; readonly details?: unknown } = {},
): Promise<void> {
  const details = input.details === undefined ? null : JSON.stringify(input.details);
  await sql`select pg_advisory_xact_lock(hashtextextended(${outboxId}, 1))`.execute(executor);
  await sql`
    insert into tor_outbox_history (id, outbox_id, sequence, kind, actor_id, reason_code, at, details)
    select ${`history_${randomUUID()}`}, item.id, coalesce(max(history.sequence), 0) + 1,
           ${kind}, ${input.actorId ?? null}, ${input.reasonCode ?? null}, ${at}, ${details}::jsonb
    from tor_outbox as item
    left join tor_outbox_history as history on history.outbox_id = item.id
    where item.id = ${outboxId}
    group by item.id
  `.execute(executor);
}

function receipt(row: { outbox_id: string; consumer_id: string; consumer_version: number; replay_generation: number; job_id: string | null; state: string; error_code: string | null; permanent: boolean; created_at: Date; settled_at: Date | null }): OutboxDeliveryReceipt {
  if (row.state !== "succeeded" && row.state !== "failed") throw new Error(`INVALID_OUTBOX_RECEIPT_STATE:${row.state}`);
  return Object.freeze({
    outboxId: row.outbox_id,
    consumerId: row.consumer_id,
    consumerVersion: row.consumer_version,
    replayGeneration: row.replay_generation,
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    state: row.state,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    permanent: row.permanent,
    createdAt: copiedDate(row.created_at),
    ...(row.settled_at === null ? {} : { settledAt: copiedDate(row.settled_at) }),
  });
}

async function upsertDeliveryReceipt<DB>(
  transaction: Transaction<DB>,
  input: {
    readonly outboxId: string;
    readonly consumerId: string;
    readonly consumerIdHash: string;
    readonly consumerVersion: number;
    readonly replayGeneration: number;
    readonly jobId: string | null;
    readonly state: "succeeded" | "failed";
    readonly errorCode: string | null;
    readonly permanent: boolean;
  },
): Promise<void> {
  await sql`
    insert into tor_outbox_delivery_receipts
      (outbox_id, consumer_id, consumer_id_hash, consumer_version, replay_generation, job_id, state, error_code, permanent, created_at, settled_at)
    values (${input.outboxId}, ${input.consumerId}, ${input.consumerIdHash}, ${input.consumerVersion}, ${input.replayGeneration},
            ${input.jobId}, ${input.state}, ${input.errorCode}, ${input.permanent}, now(), now())
    on conflict (outbox_id, consumer_id_hash, replay_generation) do update
    set consumer_id = excluded.consumer_id, consumer_version = excluded.consumer_version,
        job_id = excluded.job_id, state = excluded.state, error_code = excluded.error_code,
        permanent = excluded.permanent, settled_at = excluded.settled_at
  `.execute(transaction);
}

function migrationState(value: string): JobsMigrationState {
  if (value === "Expanded" || value === "Dual-write" || value === "Reconciling" || value === "Cutover") return value;
  throw new Error(`INVALID_JOBS_MIGRATION_STATE:${value}`);
}

function effectResultJson(input: Extract<EffectTransition, { readonly kind: "succeed" | "reconcile-succeeded" }>): string {
  const serialized = JSON.stringify(input.result);
  if (serialized === undefined) throw Object.assign(new Error("EFFECT_RESULT_UNAVAILABLE"), { code: "EFFECT_RESULT_UNAVAILABLE" });
  return serialized;
}

/**
 * Bind durable work to any Kysely database without narrowing its invariant DB generic.
 * The adapter uses fixed, framework-owned table names and typed SQL result rows.
 */
export function postgresJobStore<DB>(db: Kysely<DB>): JobStore {
  const store: JobStore = {
    enqueue: (input) => enqueueWithExecutor(db, input),

    appendOutbox: (event, payload, options) =>
      inTransaction(db, (transaction) => appendOutboxWithExecutor(transaction, event, payload, options)),

    async claim(_now, leaseMilliseconds) {
      return db.transaction().execute(async (transaction) => {
        const selected = await sql<JobRow>`
          select * from tor_jobs
          where (status = 'queued' and available_at <= now())
             or (status = 'running' and lease_expires_at <= now())
          order by available_at, id
          for update skip locked
          limit 1
        `.execute(transaction);
        const row = selected.rows[0];
        if (row === undefined) return undefined;
        const leaseToken = randomUUID();
        const updated = await sql<JobRow>`
          update tor_jobs
          set status = 'running', attempts = ${row.attempts + 1}, lease_token = ${leaseToken},
              lease_expires_at = now() + (${leaseMilliseconds} * interval '1 millisecond')
          where id = ${row.id}
          returning *
        `.execute(transaction);
        const claimed = updated.rows[0];
        if (claimed === undefined) throw new Error("JOB_CLAIM_LOST");
        return job(claimed);
      });
    },

    async renew(id, leaseToken, leaseMilliseconds) {
      const result = await sql<{ id: string }>`
        update tor_jobs
        set lease_expires_at = now() + (${leaseMilliseconds} * interval '1 millisecond')
        where id = ${id} and status = 'running' and lease_token = ${leaseToken}
          and lease_expires_at > now()
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },

    async complete(id, leaseToken) {
      const result = await sql<{ id: string }>`
        update tor_jobs
        set status = 'succeeded', lease_token = null, lease_expires_at = null
        where id = ${id} and status = 'running' and lease_token = ${leaseToken}
          and lease_expires_at > now()
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },

    async fail(id, leaseToken, input) {
      const result = await sql<{ id: string }>`
        update tor_jobs
        set status = ${input.dead ? "dead" : "queued"}, available_at = ${input.availableAt},
            last_error_code = ${input.errorCode}, lease_token = null, lease_expires_at = null
        where id = ${id} and status = 'running' and lease_token = ${leaseToken}
          and lease_expires_at > now()
        returning id
      `.execute(db);
      return result.rows.length === 1;
    },

    async claimOutbox(_at, leaseMilliseconds) {
      return db.transaction().execute(async (transaction) => {
        const selected = await sql<OutboxRow>`
          select * from tor_outbox
          where event_id is not null and (((state in ('ready', 'partial', 'retry_wait') and available_at <= now())
             or (state = 'claimed' and lease_expires_at <= now())))
          order by available_at, id
          for update skip locked
          limit 1
        `.execute(transaction);
        const row = selected.rows[0];
        if (row === undefined) return undefined;
        const leaseToken = randomUUID();
        const updated = await sql<ClaimedOutboxRow>`
          update tor_outbox
          set state = 'claimed', attempts = attempts + 1, lease_token = ${leaseToken},
              lease_expires_at = now() + (${leaseMilliseconds} * interval '1 millisecond')
          where id = ${row.id}
          returning *, now() as claimed_at
        `.execute(transaction);
        const claimed = updated.rows[0];
        if (claimed === undefined) throw new Error("OUTBOX_CLAIM_LOST");
        await appendOutboxHistory(transaction, row.id, row.state === "claimed" ? "claim_expired" : "claimed", claimed.claimed_at);
        return outboxRecord(claimed);
      });
    },

    async materializeFanout(record, targets) {
      return db.transaction().execute(async (transaction) => {
        const owner = await sql<{ id: string }>`
          select id from tor_outbox
          where id = ${record.id} and state = 'claimed' and lease_token = ${record.leaseToken ?? null}
            and lease_expires_at > now()
          for update
        `.execute(transaction);
        if (owner.rows.length !== 1) throw Object.assign(new Error("OUTBOX_FENCE_LOST"), { code: "OUTBOX_FENCE_LOST" });
        const consumerIds = new Set<string>();
        const consumerHashes = new Map<string, string>();
        const identitiesByHash = new Map<string, string>();
        for (const target of targets) {
          if (consumerIds.has(target.consumerId)) throw new TypeError(`DUPLICATE_FANOUT_TARGET:${target.consumerId}`);
          consumerIds.add(target.consumerId);
          const identityHash = durableIdentityHash(target.consumerId);
          const collision = identitiesByHash.get(identityHash);
          if (collision !== undefined && collision !== target.consumerId) throw new Error("DURABLE_IDENTITY_HASH_COLLISION");
          identitiesByHash.set(identityHash, target.consumerId);
          consumerHashes.set(target.consumerId, identityHash);
        }
        const priorReceipts = await sql<{ consumer_id: string; consumer_id_hash: string; replay_generation: number; job_id: string | null; state: string; permanent: boolean }>`
          select consumer_id, consumer_id_hash, replay_generation, job_id, state, permanent
          from tor_outbox_delivery_receipts
          where outbox_id = ${record.occurrenceId}
            and (replay_generation = ${record.replayGeneration}
              or (replay_generation < ${record.replayGeneration} and state = 'succeeded'))
          order by consumer_id, replay_generation desc
        `.execute(transaction);
        const terminalCurrentConsumers = new Set<string>();
        const priorSuccessJobs = new Map<string, string>();
        for (const value of priorReceipts.rows) {
          const targetWithHash = identitiesByHash.get(value.consumer_id_hash);
          if (targetWithHash !== undefined && targetWithHash !== value.consumer_id) throw new Error("DURABLE_IDENTITY_HASH_COLLISION");
          if (value.replay_generation === record.replayGeneration && (value.state === "succeeded" || value.permanent)) terminalCurrentConsumers.add(value.consumer_id);
          else if (value.replay_generation < record.replayGeneration && value.state === "succeeded" && value.job_id !== null && !priorSuccessJobs.has(value.consumer_id)) {
            priorSuccessJobs.set(value.consumer_id, value.job_id);
          }
        }
        for (const target of targets) {
          const consumerIdHash = consumerHashes.get(target.consumerId);
          if (consumerIdHash === undefined) throw new Error("DURABLE_IDENTITY_HASH_MISSING");
          if (terminalCurrentConsumers.has(target.consumerId)) continue;
          const priorSuccessJob = priorSuccessJobs.get(target.consumerId);
          if (priorSuccessJob !== undefined) {
            await upsertDeliveryReceipt(transaction, {
              outboxId: record.occurrenceId,
              consumerId: target.consumerId,
              consumerIdHash,
              consumerVersion: target.consumerVersion,
              replayGeneration: record.replayGeneration,
              jobId: priorSuccessJob,
              state: "succeeded",
              errorCode: null,
              permanent: false,
            });
            continue;
          }
          if (target.kind === "failed") {
            await upsertDeliveryReceipt(transaction, {
              outboxId: record.occurrenceId,
              consumerId: target.consumerId,
              consumerIdHash,
              consumerVersion: target.consumerVersion,
              replayGeneration: record.replayGeneration,
              jobId: null,
              state: "failed",
              errorCode: target.errorCode,
              permanent: target.permanent,
            });
            continue;
          }
          const idempotencyKey = outboxDeliveryIdempotencyKey(record.occurrenceId, target.consumerId, record.replayGeneration);
          let jobId: string;
          let state: "succeeded" | "failed" = "succeeded";
          try {
            jobId = (await enqueueWithExecutor(transaction, {
              name: target.jobName,
              payload: target.payload,
              idempotencyKey,
              outboxId: record.occurrenceId,
              consumerId: target.consumerId,
              replayGeneration: record.replayGeneration,
            })).id;
          } catch (error) {
            if (!(typeof error === "object" && error !== null && "code" in error && error.code === "JOB_IDEMPOTENCY_CONFLICT")) throw error;
            const conflict = await sql<{ id: string }>`select id from tor_jobs where idempotency_key = ${idempotencyKey}`.execute(transaction);
            if (conflict.rows[0] === undefined) throw error;
            jobId = conflict.rows[0].id;
            state = "failed";
          }
          await upsertDeliveryReceipt(transaction, {
            outboxId: record.occurrenceId,
            consumerId: target.consumerId,
            consumerIdHash,
            consumerVersion: target.consumerVersion,
            replayGeneration: record.replayGeneration,
            jobId,
            state,
            errorCode: state === "failed" ? "JOB_IDEMPOTENCY_CONFLICT" : null,
            permanent: state === "failed",
          });
        }
        const selected = await sql<{ outbox_id: string; consumer_id: string; consumer_version: number; replay_generation: number; job_id: string | null; state: string; error_code: string | null; permanent: boolean; created_at: Date; settled_at: Date | null }>`
          select * from tor_outbox_delivery_receipts
          where outbox_id = ${record.occurrenceId} and replay_generation = ${record.replayGeneration}
          order by consumer_id
        `.execute(transaction);
        const values = selected.rows.map(receipt).filter(({ consumerId }) => consumerIds.has(consumerId));
        return Object.freeze({ total: targets.length, succeeded: values.filter(({ state }) => state === "succeeded").length, failed: values.filter(({ state }) => state === "failed").length, permanentFailed: values.filter(({ state, permanent }) => state === "failed" && permanent).length, receipts: Object.freeze(values) });
      });
    },

    async settleOutbox(id, leaseToken, input) {
      return db.transaction().execute(async (transaction) => {
        const values = input.kind === "published"
          ? { state: "published", availableAt: input.at, publishedAt: input.at, errorCode: null, quarantineReason: null }
          : input.kind === "retry"
            ? { state: "retry_wait", availableAt: input.availableAt, publishedAt: null, errorCode: input.errorCode, quarantineReason: null }
            : input.kind === "partial"
              ? { state: "partial", availableAt: input.availableAt, publishedAt: null, errorCode: input.errorCode, quarantineReason: null }
              : { state: "quarantined", availableAt: input.at, publishedAt: null, errorCode: input.reason, quarantineReason: input.reason };
        const updated = await sql<{ id: string }>`
          update tor_outbox
          set state = ${values.state}, available_at = ${values.availableAt},
              published_at = ${values.publishedAt}, last_error_code = ${values.errorCode},
              quarantine_reason = ${values.quarantineReason}, lease_token = null, lease_expires_at = null
          where id = ${id} and state = 'claimed' and lease_token = ${leaseToken}
            and lease_expires_at > now()
          returning id
        `.execute(transaction);
        if (updated.rows.length !== 1) {
          await appendOutboxHistory(transaction, id, "fence_lost", input.at);
          return false;
        }
        const kind = input.kind === "retry" ? "retry_scheduled" : input.kind === "quarantine" ? "quarantined" : input.kind;
        const reasonCode = input.kind === "retry" || input.kind === "partial" ? input.errorCode : input.kind === "quarantine" ? input.reason : undefined;
        await appendOutboxHistory(transaction, id, kind, input.at, reasonCode === undefined ? {} : { reasonCode });
        return true;
      });
    },

    async requestOutboxReplay(id, request: ReplayOutboxRequest) {
      validateReplayOutboxRequest(request);
      return db.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${request.requestId}, 0))`.execute(transaction);
        const prior = await sql<{ outbox_id: string; approved_by: string; reason: string; requested_at: Date }>`
          select outbox_id, approved_by, reason, requested_at
          from tor_outbox_replay_requests where request_id = ${request.requestId}
        `.execute(transaction);
        if (prior.rows[0] !== undefined) {
          const existing = prior.rows[0];
          if (existing.outbox_id !== id || existing.approved_by !== request.approvedBy || existing.reason !== request.reason || existing.requested_at.getTime() !== request.requestedAt.getTime()) {
            throw new Error("REPLAY_REQUEST_CONFLICT");
          }
          return { replayed: true };
        }
        const current = await sql<{ state: string; event_id: string | null }>`
          select state, event_id from tor_outbox where id = ${id} for update
        `.execute(transaction);
        if (current.rows[0] === undefined) throw new Error(`OUTBOX_NOT_FOUND:${id}`);
        if (current.rows[0].state !== "quarantined") throw new Error("OUTBOX_NOT_QUARANTINED");
        if (current.rows[0].event_id === null) throw new Error("OUTBOX_IDENTITY_UNRESOLVED");
        const updated = await sql<{ id: string }>`
          update tor_outbox set state = 'ready', available_at = ${request.requestedAt},
            replay_generation = replay_generation + 1, quarantine_reason = null,
            lease_token = null, lease_expires_at = null
          where id = ${id} and state = 'quarantined'
          returning id
        `.execute(transaction);
        if (updated.rows.length !== 1) throw new Error("OUTBOX_NOT_QUARANTINED");
        await sql`
          insert into tor_outbox_replay_requests (request_id, outbox_id, approved_by, reason, requested_at)
          values (${request.requestId}, ${id}, ${request.approvedBy}, ${request.reason}, ${request.requestedAt})
        `.execute(transaction);
        await appendOutboxHistory(transaction, id, "replay_requested", request.requestedAt, {
          actorId: request.approvedBy,
          reasonCode: "REPLAY_APPROVED",
          details: { requestId: request.requestId, reason: request.reason },
        });
        return { replayed: false };
      });
    },

    async quarantinedOutbox() {
      const selected = await sql<OutboxRow>`select * from tor_outbox where state = 'quarantined' order by available_at, id`.execute(db);
      return Object.freeze(selected.rows.map(outboxRecord));
    },

    async outboxHistory(id, options = {}) {
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("OUTBOX_HISTORY_LIMIT_INVALID");
      if (options.beforeSequence !== undefined && (!Number.isSafeInteger(options.beforeSequence) || options.beforeSequence < 1)) {
        throw new TypeError("OUTBOX_HISTORY_SEQUENCE_INVALID");
      }
      const beforeSequence = options.beforeSequence ?? 2_147_483_647;
      const selected = await sql<{ id: string; outbox_id: string; sequence: number; kind: string; actor_id: string | null; reason_code: string | null; at: Date; details: unknown | null }>`
        select * from tor_outbox_history
        where outbox_id = ${id} and sequence < ${beforeSequence}
        order by sequence desc
        limit ${limit}
      `.execute(db);
      return Object.freeze([...selected.rows].reverse().map((row): OutboxHistoryEntry => Object.freeze({ id: row.id, outboxId: row.outbox_id, sequence: row.sequence, kind: row.kind, ...(row.actor_id === null ? {} : { actorId: row.actor_id }), ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }), at: copiedDate(row.at), ...(row.details === null ? {} : { details: immutablePersistedJson(row.details) }) })));
    },

    async readMigrationState() {
      const selected = await sql<{ state: string; rollback_restricted: boolean; duplicate_identities: boolean; reconciliation_graph_hash: string | null; updated_at: Date }>`
        select state, rollback_restricted, reconciliation_graph_hash, updated_at,
          exists (
            select 1 from tor_outbox
            where event_id is not null
            group by event having count(distinct event_id) > 1
          ) as duplicate_identities
        from tor_jobs_migration_state where singleton = 1
      `.execute(db);
      const row = selected.rows[0];
      if (row === undefined) throw new Error("JOBS_MIGRATION_STATE_MISSING");
      return Object.freeze({ state: migrationState(row.state), rollbackRestricted: row.rollback_restricted || row.duplicate_identities, ...(row.reconciliation_graph_hash === null ? {} : { reconciliationGraphHash: row.reconciliation_graph_hash }), updatedAt: copiedDate(row.updated_at) });
    },

    async transitionMigrationState(expected, next, rollbackRestricted = false) {
      const order: readonly JobsMigrationState[] = ["Expanded", "Dual-write", "Reconciling", "Cutover"];
      if (order.indexOf(next) !== order.indexOf(expected) + 1) return false;
      const updated = await sql<{ singleton: number }>`
        update tor_jobs_migration_state
        set state = ${next}, rollback_restricted = rollback_restricted or ${rollbackRestricted || next === "Cutover"}, updated_at = now()
        where singleton = 1 and state = ${expected}
          and (${next} <> 'Cutover' or not exists (
            select 1 from tor_outbox as item
            where item.event_id is null and not exists (
              select 1 from tor_outbox_reconciliation as reconciliation
              where reconciliation.outbox_id = item.id
            )
          ))
        returning singleton
      `.execute(db);
      return updated.rows.length === 1;
    },

    async reconcileLegacyOutbox(candidates: readonly LegacyReconciliationCandidate[], limit = 100): Promise<LegacyReconciliationResult> {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("JOBS_RECONCILIATION_LIMIT_INVALID");
      const { byName, hash: graphHash } = legacyReconciliationGraph(candidates);
      return db.transaction().execute(async (transaction) => {
        const locked = await sql<{ reconciliation_graph_hash: string }>`
          update tor_jobs_migration_state
          set reconciliation_graph_hash = coalesce(reconciliation_graph_hash, ${graphHash}), updated_at = now()
          where singleton = 1 and state = 'Reconciling'
            and (reconciliation_graph_hash is null or reconciliation_graph_hash = ${graphHash})
          returning reconciliation_graph_hash
        `.execute(transaction);
        if (locked.rows.length !== 1) {
          const current = await sql<{ state: string; reconciliation_graph_hash: string | null }>`
            select state, reconciliation_graph_hash from tor_jobs_migration_state where singleton = 1
          `.execute(transaction);
          if (current.rows[0]?.state !== "Reconciling") throw new Error("JOBS_RECONCILIATION_STATE_INVALID");
          throw new Error("JOBS_RECONCILIATION_GRAPH_CHANGED");
        }
        const selected = await sql<{ id: string; event: string }>`
          select item.id, item.event from tor_outbox as item
          where item.event_id is null
            and not exists (select 1 from tor_outbox_reconciliation as reconciliation where reconciliation.outbox_id = item.id)
          order by item.created_at, item.id
          for update skip locked
          limit ${limit}
        `.execute(transaction);
        let resolved = 0;
        let unknown = 0;
        let ambiguous = 0;
        for (const row of selected.rows) {
          const ids = [...(byName.get(row.event) ?? [])];
          const classification = ids.length === 1 ? "resolved" : ids.length === 0 ? "unknown" : "ambiguous";
          const resolvedEventId = ids.length === 1 ? ids[0] as string : null;
          await sql`
            insert into tor_outbox_reconciliation (outbox_id, graph_hash, classification, resolved_event_id, at)
            values (${row.id}, ${graphHash}, ${classification}, ${resolvedEventId}, now())
          `.execute(transaction);
          if (resolvedEventId !== null) {
            await sql`update tor_outbox set event_id = ${resolvedEventId}, event_id_hash = ${durableIdentityHash(resolvedEventId)}, migration_classification = 'resolved' where id = ${row.id}`.execute(transaction);
            resolved += 1;
          } else {
            const reason = classification === "unknown" ? "LEGACY_EVENT_UNKNOWN" : "LEGACY_EVENT_AMBIGUOUS";
            await sql`update tor_outbox set state = 'quarantined', quarantine_reason = ${reason}, migration_classification = ${classification} where id = ${row.id}`.execute(transaction);
            await appendOutboxHistory(transaction, row.id, "quarantined", new Date(), { reasonCode: reason });
            if (classification === "unknown") unknown += 1;
            else ambiguous += 1;
          }
        }
        if (ambiguous > 0 || [...byName.values()].some((ids) => ids.size > 1)) await sql`update tor_jobs_migration_state set rollback_restricted = true, updated_at = now() where singleton = 1`.execute(transaction);
        return Object.freeze({ resolved, unknown, ambiguous });
      });
    },

    async assertOutboxCapability(capability) {
      const selected = await sql<{ state: string; rollback_restricted: boolean }>`
        select state, rollback_restricted from tor_jobs_migration_state where singleton = 1
      `.execute(db);
      const state = selected.rows[0];
      if (state === undefined) throw new Error("JOBS_MIGRATION_STATE_MISSING");
      migrationState(state.state);
      if (capability === "exact") return;
      if (state.rollback_restricted) throw new Error("NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN");
      const duplicates = await sql<{ found: boolean }>`
        select exists (
          select 1 from tor_outbox
          where event_id is not null
          group by event having count(distinct event_id) > 1
        ) as found
      `.execute(db);
      if (duplicates.rows[0]?.found) throw new Error("NAME_ONLY_OUTBOX_CAPABILITY_FORBIDDEN");
    },

    async materialize(input: ScheduleOccurrence) {
      return db.transaction().execute(async (transaction) => {
        const occurrenceKey = `${input.schedule}:${input.occurrence}`;
        const digest = scheduleRequestDigest(input);
        await sql`
          select pg_advisory_xact_lock(hashtextextended(${occurrenceKey}, 0))
        `.execute(transaction);
        const prior = await sql<{ job_id: string; request_digest: string }>`
          select job_id, request_digest from tor_schedule_occurrences
          where schedule = ${input.schedule} and occurrence = ${input.occurrence}
        `.execute(transaction);
        if (prior.rows[0] !== undefined) {
          if (prior.rows[0].request_digest !== digest) throw idempotencyConflict("SCHEDULE_IDEMPOTENCY_CONFLICT");
          return { id: prior.rows[0].job_id, replayed: true };
        }

        const job = await enqueueWithExecutor(transaction, input.job);
        await sql`
          insert into tor_schedule_occurrences (schedule, occurrence, job_id, request_digest)
          values (${input.schedule}, ${input.occurrence}, ${job.id}, ${digest})
        `.execute(transaction);
        return job;
      });
    },

    async transitionEffect(input) {
      let applied = false;
      if (input.kind === "reserve") {
        const inserted = await sql<{ effect_key: string }>`
          insert into tor_effect_receipts
            (effect_key, state, result, result_present, provider_reference,
             claim_job_id, claim_token, updated_at)
          select ${input.key}, 'pending', null, false, null,
                 ${input.owner.jobId}, ${input.owner.leaseToken}, ${input.updatedAt}
          where exists (
            select 1 from tor_jobs
            where id = ${input.owner.jobId} and status = 'running'
              and lease_token = ${input.owner.leaseToken} and lease_expires_at > now()
          )
          on conflict (effect_key) do nothing
          returning effect_key
        `.execute(db);
        applied = inserted.rows.length === 1;
      } else if (input.kind === "succeed") {
        const updated = await sql<{ effect_key: string }>`
          update tor_effect_receipts as receipt
          set state = 'succeeded', result = ${effectResultJson(input)}::jsonb,
              result_present = true, provider_reference = ${input.providerReference ?? null},
              claim_job_id = null, claim_token = null, updated_at = ${input.updatedAt}
          where receipt.effect_key = ${input.key} and receipt.state = 'pending'
            and receipt.claim_job_id = ${input.owner.jobId}
            and receipt.claim_token = ${input.owner.leaseToken}
            and exists (
              select 1 from tor_jobs as job
              where job.id = ${input.owner.jobId} and job.status = 'running'
                and job.lease_token = ${input.owner.leaseToken} and job.lease_expires_at > now()
            )
          returning receipt.effect_key
        `.execute(db);
        applied = updated.rows.length === 1;
      } else if (input.kind === "uncertain") {
        const updated = await sql<{ effect_key: string }>`
          update tor_effect_receipts as receipt
          set state = 'uncertain', result = null, result_present = false,
              provider_reference = null, updated_at = ${input.updatedAt}
          where receipt.effect_key = ${input.key} and receipt.state = 'pending'
            and receipt.claim_job_id = ${input.owner.jobId}
            and receipt.claim_token = ${input.owner.leaseToken}
            and exists (
              select 1 from tor_jobs as job
              where job.id = ${input.owner.jobId} and job.status = 'running'
                and job.lease_token = ${input.owner.leaseToken} and job.lease_expires_at > now()
            )
          returning receipt.effect_key
        `.execute(db);
        applied = updated.rows.length === 1;
      } else if (input.kind === "reclaim") {
        const updated = await sql<{ effect_key: string }>`
          update tor_effect_receipts as receipt
          set state = 'pending', result = null, result_present = false, provider_reference = null,
              claim_job_id = ${input.owner.jobId}, claim_token = ${input.owner.leaseToken},
              updated_at = ${input.updatedAt}
          where receipt.effect_key = ${input.key} and receipt.state in ('pending', 'uncertain')
            and receipt.claim_job_id = ${input.expectedOwner.jobId}
            and receipt.claim_token = ${input.expectedOwner.leaseToken}
            and not exists (
              select 1 from tor_jobs as old_job
              where old_job.id = ${input.expectedOwner.jobId} and old_job.status = 'running'
                and old_job.lease_token = ${input.expectedOwner.leaseToken}
                and old_job.lease_expires_at > now()
            )
            and exists (
              select 1 from tor_jobs as new_job
              where new_job.id = ${input.owner.jobId} and new_job.status = 'running'
                and new_job.lease_token = ${input.owner.leaseToken}
                and new_job.lease_expires_at > now()
            )
          returning receipt.effect_key
        `.execute(db);
        applied = updated.rows.length === 1;
      } else {
        const updated = await sql<{ effect_key: string }>`
          update tor_effect_receipts as receipt
          set state = 'succeeded', result = ${effectResultJson(input)}::jsonb,
              result_present = true, provider_reference = ${input.providerReference ?? null},
              claim_job_id = null, claim_token = null, updated_at = ${input.updatedAt}
          where receipt.effect_key = ${input.key} and receipt.state in ('pending', 'uncertain')
            and receipt.claim_job_id = ${input.expectedOwner.jobId}
            and receipt.claim_token = ${input.expectedOwner.leaseToken}
            and not exists (
              select 1 from tor_jobs as old_job
              where old_job.id = ${input.expectedOwner.jobId} and old_job.status = 'running'
                and old_job.lease_token = ${input.expectedOwner.leaseToken}
                and old_job.lease_expires_at > now()
            )
            and exists (
              select 1 from tor_jobs as resolver
              where resolver.id = ${input.owner.jobId} and resolver.status = 'running'
                and resolver.lease_token = ${input.owner.leaseToken}
                and resolver.lease_expires_at > now()
            )
          returning receipt.effect_key
        `.execute(db);
        applied = updated.rows.length === 1;
      }
      return effectTransitionResult(db, input.key, applied);
    },

    async deadLetters() {
      const result = await sql<JobRow>`
        select * from tor_jobs where status = 'dead' order by available_at
      `.execute(db);
      return Object.freeze(result.rows.map(job));
    },
  };
  return Object.freeze(store);
}

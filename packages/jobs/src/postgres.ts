import { randomUUID } from "node:crypto";

import { type Kysely, sql, type Transaction } from "kysely";
import type { Migration } from "kysely/migration";

import type {
  DurableEvent,
  EffectReceipt,
  EffectTransition,
  EffectTransitionResult,
  EnqueueJob,
  JobRecord,
  JobStatus,
  JobStore,
  OutboxRecord,
  ScheduleOccurrence,
} from "./jobs.js";
import {
  idempotencyConflict,
  jobRequestDigest,
  outboxRequestDigest,
  scheduleRequestDigest,
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
}

interface OutboxRow {
  id: string;
  event: string;
  version: number;
  payload: unknown;
  idempotency_key: string;
  request_digest: string;
}

interface ClaimedOutboxRow extends OutboxRow {
  lease_token: string;
  lease_expires_at: Date;
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
  tor_outbox: OutboxRow & {
    published_at: Date | null;
    created_at: Date;
    lease_token: string | null;
    lease_expires_at: Date | null;
  };
  tor_schedule_occurrences: { schedule: string; occurrence: string; job_id: string; request_digest: string };
  tor_effect_receipts: EffectRow;
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
    updatedAt: row.updated_at,
  });
}

function job(row: JobRow): JobRecord {
  return Object.freeze({
    id: row.id,
    name: row.name,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: jobStatus(row.status),
    attempts: row.attempts,
    maximumAttempts: row.maximum_attempts,
    availableAt: row.available_at,
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
  });
}

async function enqueueWithExecutor<DB>(
  executor: Kysely<DB> | Transaction<DB>,
  input: EnqueueJob,
): Promise<{ readonly id: string; readonly replayed: boolean }> {
  const id = `job_${randomUUID()}`;
  const digest = jobRequestDigest(input);
  const inserted = await sql<{ id: string }>`
    insert into tor_jobs
      (id, name, payload, idempotency_key, request_digest, status, attempts, maximum_attempts,
       available_at, lease_token, lease_expires_at, last_error_code)
    values
      (${id}, ${input.name}, ${JSON.stringify(input.payload)}::jsonb, ${input.idempotencyKey},
       ${digest}, 'queued', 0, ${input.maximumAttempts ?? 5}, ${input.availableAt ?? new Date()},
       null, null, null)
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
  executor: Kysely<DB> | Transaction<DB>,
  event: DurableEvent<T>,
  payload: T,
  idempotencyKey: string,
): Promise<{ readonly id: string; readonly replayed: boolean }> {
  event.parse(payload);
  const id = `outbox_${randomUUID()}`;
  const digest = outboxRequestDigest(event, payload);
  const inserted = await sql<{ id: string }>`
    insert into tor_outbox
      (id, event, version, payload, idempotency_key, request_digest, published_at, created_at,
       lease_token, lease_expires_at)
    values
      (${id}, ${event.name}, ${event.version}, ${JSON.stringify(payload)}::jsonb,
       ${idempotencyKey}, ${digest}, null, ${new Date()}, null, null)
    on conflict (idempotency_key) do nothing
    returning id
  `.execute(executor);
  if (inserted.rows[0] !== undefined) return { id: inserted.rows[0].id, replayed: false };
  const prior = await sql<{ id: string; request_digest: string }>`
    select id, request_digest from tor_outbox where idempotency_key = ${idempotencyKey}
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
    appendOutbox<T>(event: DurableEvent<T>, payload: T, idempotencyKey: string) {
      return appendOutboxWithExecutor(executor, event, payload, idempotencyKey);
    },
  });
}

export function postgresOutboxWriter<DB>(executor: Kysely<DB> | Transaction<DB>) {
  const writer = postgresJobWriter(executor);
  return Object.freeze({ appendOutbox: writer.appendOutbox });
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

    appendOutbox: (event, payload, idempotencyKey) =>
      appendOutboxWithExecutor(db, event, payload, idempotencyKey),

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

    async dueOutbox(limit, _now, leaseMilliseconds = 30_000) {
      const leaseToken = randomUUID();
      const result = await sql<ClaimedOutboxRow>`
        with due as (
          select id from tor_outbox
          where published_at is null
            and (lease_expires_at is null or lease_expires_at <= now())
          order by created_at
          for update skip locked
          limit ${limit}
        )
        update tor_outbox as item
        set lease_token = ${leaseToken},
            lease_expires_at = now() + (${leaseMilliseconds} * interval '1 millisecond')
        from due
        where item.id = due.id
        returning item.id, item.event, item.version, item.payload, item.idempotency_key,
                  item.request_digest, item.lease_token, item.lease_expires_at
      `.execute(db);
      return Object.freeze(
        result.rows.map((row): OutboxRecord =>
          Object.freeze({
            id: row.id,
            event: row.event,
            version: row.version,
            payload: row.payload,
            idempotencyKey: row.idempotency_key,
            leaseToken: row.lease_token,
            leaseExpiresAt: row.lease_expires_at,
          }),
        ),
      );
    },

    async markPublished(id, leaseToken, publishedAt) {
      const result = await sql<{ id: string }>`
        update tor_outbox
        set published_at = ${publishedAt}, lease_token = null, lease_expires_at = null
        where id = ${id} and published_at is null and lease_token = ${leaseToken}
          and lease_expires_at > now()
        returning id
      `.execute(db);
      return result.rows.length === 1;
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

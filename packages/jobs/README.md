# @typescript-on-rails/jobs

Experimental PostgreSQL-backed durable work for TypeScript on Rails. Its API and additive schema may change before an explicit stability decision; local PostgreSQL proof does not make it production-ready.

The package stores owner-qualified event IDs, schema versions, immutable occurrence envelopes, bounded request and authority IDs, and legacy event names during migration. Durable core events must declare their feature owner, and `defineFeature` rejects a different owner. Feature-owned schedules target the exact registered durable consumer and bind to the scheduler entrypoint through `scheduleRuntimeBinding`; generic string-job schedules remain experimental and unlinked. `runScheduler` contains each schedule failure and returns created, replayed, failed, and cancelled state with safe error codes. It accepts cancellation, rejects more than 10,000 occurrences from one schedule by default, and returns at most 1,000 failure details with an overflow count. Registered occurrence identity excludes changing wall-clock fields; the first materialized `dueAt` wins for a stable occurrence key. Outbox dispatch claims one record at a time. It uses lease fences, bounded retry, quarantine, accountable replay, append-only history, and per-consumer delivery receipts.

`createConsumerRuntime` selects consumers by exact event ID. Historical payloads need explicit, adjacent-version upcasters, both at dispatch and when an older queued job runs after a deployment. The worker checks the event and consumer identities and validates the upgraded payload before calling `authorize`, `context`, or the handler. Missing, competing, failed, or future-version upgrades stop only the affected delivery: dispatch quarantines it; execution sends the job straight to dead letters. Non-adjacent upcaster definitions still fail at runtime construction.

The original envelope never changes. For outbox jobs, the receipt from the job's original replay generation records the materialized payload version; later replay receipts cannot replace it. New registered schedules store `payloadVersion` beside the payload and a consumer ID on the job. Older schedules remain supported only when their stored schedule link and exact claimed job name identify the target, and their historical and materialized payload copies agree. Missing or ambiguous version evidence fails closed. This needs no new database migration.

A handler receives `{ application, job }`. The worker supplies claimed identity and version evidence in `job.delivery`; callers must not build this from event payload fields. Each execution attempt upgrades a fresh copy, so retries cannot transform an already upgraded copy again. Both `authorize` and the application context reload for each attempt; they receive the original authority IDs without event payload fields. Persist IDs only. Do not persist credentials, permission results, or application context.

Fanout jobs and receipts commit in one store transaction. A permanent target failure does not discard valid target jobs. Replay keeps successful target receipts and gives failed targets a new generation, while the original record and history remain. `outboxHistory` returns at most 100 recent entries by default and supports `limit` plus `beforeSequence` for older pages; storage stays append-only. Job effects still use at-least-once delivery. Use provider idempotency and the fenced `job.effect` receipt flow for external work.

For migration tests, `memoryJobStore(now, { legacyOutbox })` can seed immutable pre-expand records; ordinary application code must not use that test seam.

Apply migrations in order:

1. `jobsMigration`
2. `jobsExpandMigration`

The expand migration has no destructive rollback. The pre-migration database is the conceptual `Legacy` stage; applying `jobsExpandMigration` creates the stored `Expanded` state. Move it only through `Expanded → Dual-write → Reconciling → Cutover`. Reconciliation pins one canonical graph hash and cutover refuses unclassified legacy rows. Once rollback is restricted, a name-only worker must not start.

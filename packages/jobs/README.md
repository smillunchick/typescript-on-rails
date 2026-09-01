# @typescript-on-rails/jobs

PostgreSQL-backed durable events, transactional outbox records, jobs, idempotency, exponential retry, lease fences, dead letters, schedules, and external-effect reconciliation. `withPostgresRequestUnitOfWork` keeps business writes, jobs, and outbox records on one transaction. `createConsumerRuntime` derives handlers and outbox publication from the exact consumers registered in the application graph. The core event object is also a valid durable event.

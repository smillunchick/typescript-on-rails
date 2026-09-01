import type { Transaction } from "kysely";

import { postgresJobWriter, postgresOutboxWriter } from "./postgres.js";

export interface RequestTransactionContext {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
}

export interface RequestTransactionScope<DB> {
  transaction<T>(
    context: RequestTransactionContext,
    operation: (transaction: Transaction<DB>) => Promise<T>,
  ): Promise<T>;
}

export interface PostgresRequestUnitOfWork<DB> {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly transaction: Transaction<DB>;
  readonly outbox: ReturnType<typeof postgresOutboxWriter<DB>>;
  readonly jobs: ReturnType<typeof postgresJobWriter<DB>>;
}

export function withPostgresRequestUnitOfWork<DB, T>(
  scope: RequestTransactionScope<DB>,
  context: RequestTransactionContext,
  operation: (unit: PostgresRequestUnitOfWork<DB>) => Promise<T>,
): Promise<T> {
  return scope.transaction(context, async (transaction) => {
    const jobs = postgresJobWriter(transaction);
    return operation(Object.freeze({
      ...context,
      transaction,
      outbox: postgresOutboxWriter(transaction),
      jobs,
    }));
  });
}

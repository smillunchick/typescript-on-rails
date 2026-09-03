import {
  projectedTests,
  resolveArchitectureSelector,
  type ArchitectureProjectionView,
  type Executable,
  type ExecutionContext,
} from "typescript-on-rails";

export type ArchitectureManifestV3Like = ArchitectureProjectionView;
import { memoryJobStore, createWorker, type JobHandler } from "@typescript-on-rails/jobs";
import { createTestDatabase, type TestDatabase } from "@typescript-on-rails/postgres";

export function operationHarness<TInput, TOutput, TContext extends ExecutionContext>(operation: Executable<TInput, TOutput, TContext>, context: TContext) {
  return Object.freeze({ execute: (input: unknown) => operation.execute(input, context) });
}

export function httpHarness(handler: { handle(request: Request, params?: Readonly<Record<string, string>>): Promise<Response> }) {
  return Object.freeze({
    request(path: string, init: RequestInit = {}, params: Readonly<Record<string, string>> = {}) {
      return handler.handle(new Request(new URL(path, "https://framework.test"), init), params);
    },
  });
}

export async function postgresHarness<DB, T>(connectionString: string, run: (database: TestDatabase<DB>) => Promise<T>): Promise<T> {
  const database = await createTestDatabase<DB>(connectionString);
  try { return await run(database); }
  finally { await database.close(); }
}

export function jobHarness(handlers: Readonly<Record<string, JobHandler>>, now: () => Date = () => new Date()) {
  const store = memoryJobStore(now);
  const worker = createWorker({ store, handlers, now });
  return Object.freeze({ store, worker, async enqueue(name: string, payload: unknown, idempotencyKey: string) { return store.enqueue({ name, payload, idempotencyKey }); } });
}

export interface BrowserDriver {
  goto(url: string): Promise<void>;
  text(selector: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export async function browserHarness<T>(create: () => Promise<BrowserDriver>, scenario: (browser: BrowserDriver) => Promise<T>): Promise<T> {
  const browser = await create();
  try { return await scenario(browser); }
  finally { await browser.close(); }
}

export function relevantTests(manifest: ArchitectureManifestV3Like, selector: string): readonly string[] {
  const selected = resolveArchitectureSelector(manifest, selector);
  if (selected.status === "not-found") return Object.freeze([]);
  if (selected.status === "ambiguous") throw new TypeError(`ARCHITECTURE_SELECTOR_AMBIGUOUS:${selector}`);
  return Object.freeze(projectedTests(manifest, selected).map(({ file }) => file));
}

export function deterministicClock(start = 0) {
  let value = start;
  return Object.freeze({ now: () => new Date(value), advance: (milliseconds: number) => { if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError("CLOCK_ADVANCE_INVALID"); value += milliseconds; } });
}

export function deterministicIds(prefix = "id") {
  let sequence = 0;
  return () => `${prefix}_${String(++sequence).padStart(6, "0")}`;
}

export type SafeAttribute = string | number | boolean;
export type SafeAttributes = Readonly<Record<string, SafeAttribute>>;

export interface Logger {
  debug(message: string, attributes?: SafeAttributes): void;
  info(message: string, attributes?: SafeAttributes): void;
  warn(message: string, attributes?: SafeAttributes): void;
  error(message: string, attributes?: SafeAttributes): void;
}

export interface Metrics {
  increment(name: string, value?: number, attributes?: SafeAttributes): void;
  observe(name: string, value: number, attributes?: SafeAttributes): void;
}

export interface Span {
  set(attributes: SafeAttributes): void;
  end(error?: unknown): void;
}

export interface Tracer {
  start(name: string, attributes?: SafeAttributes): Span;
}

export interface Observability {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
}

export function memoryObservability(): Observability & {
  readonly records: readonly Readonly<Record<string, unknown>>[];
} {
  const records: Readonly<Record<string, unknown>>[] = [];
  const add = (record: Readonly<Record<string, unknown>>) => { records.push(Object.freeze(record)); };
  const logger: Logger = {
    debug: (message, attributes = {}) => add({ type: "log", level: "debug", message, attributes }),
    info: (message, attributes = {}) => add({ type: "log", level: "info", message, attributes }),
    warn: (message, attributes = {}) => add({ type: "log", level: "warn", message, attributes }),
    error: (message, attributes = {}) => add({ type: "log", level: "error", message, attributes }),
  };
  const metrics: Metrics = {
    increment: (name, value = 1, attributes = {}) => add({ type: "counter", name, value, attributes }),
    observe: (name, value, attributes = {}) => add({ type: "observation", name, value, attributes }),
  };
  const tracer: Tracer = {
    start(name, attributes = {}) {
      add({ type: "span-start", name, attributes });
      return Object.freeze({
        set: (next: SafeAttributes) => add({ type: "span-attributes", name, attributes: next }),
        end: (error?: unknown) => add({ type: "span-end", name, failed: error !== undefined }),
      });
    },
  };
  return Object.freeze({
    logger,
    metrics,
    tracer,
    get records() { return Object.freeze([...records]); },
  });
}

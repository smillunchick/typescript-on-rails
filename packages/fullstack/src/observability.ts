export type SafeAttribute = string | number | boolean;
export type SafeAttributes = Readonly<Record<string, SafeAttribute>>;

export interface AttributePolicy {
  readonly maximumStringLength?: number;
  readonly redactedKeys?: readonly RegExp[];
  readonly redactedValues?: readonly RegExp[];
}

const DEFAULT_REDACTED_KEYS = [/(?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key)/i];
const DEFAULT_REDACTED_VALUES = [
  /^Bearer\s+/i,
  /^-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
];

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

export function sanitizeAttributes(
  attributes: SafeAttributes,
  policy: AttributePolicy = {},
): SafeAttributes {
  const maximum = policy.maximumStringLength ?? 256;
  if (!Number.isSafeInteger(maximum) || maximum < 16) throw new TypeError("OBSERVABILITY_ATTRIBUTE_LIMIT_INVALID");
  const redactedKeys = policy.redactedKeys ?? DEFAULT_REDACTED_KEYS;
  const redactedValues = policy.redactedValues ?? DEFAULT_REDACTED_VALUES;
  const output: Record<string, SafeAttribute> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string") {
      output[key] = value;
      continue;
    }
    if (redactedKeys.some((pattern) => matches(pattern, key)) || redactedValues.some((pattern) => matches(pattern, value))) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
  }
  return Object.freeze(output);
}

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

export function memoryObservability(options: { readonly attributes?: AttributePolicy } = {}): Observability & {
  readonly records: readonly Readonly<Record<string, unknown>>[];
} {
  const records: Readonly<Record<string, unknown>>[] = [];
  const safe = (attributes: SafeAttributes) => sanitizeAttributes(attributes, options.attributes);
  const add = (record: Readonly<Record<string, unknown>>) => { records.push(Object.freeze(record)); };
  const logger: Logger = {
    debug: (message, attributes = {}) => add({ type: "log", level: "debug", message, attributes: safe(attributes) }),
    info: (message, attributes = {}) => add({ type: "log", level: "info", message, attributes: safe(attributes) }),
    warn: (message, attributes = {}) => add({ type: "log", level: "warn", message, attributes: safe(attributes) }),
    error: (message, attributes = {}) => add({ type: "log", level: "error", message, attributes: safe(attributes) }),
  };
  const metrics: Metrics = {
    increment: (name, value = 1, attributes = {}) => add({ type: "counter", name, value, attributes: safe(attributes) }),
    observe: (name, value, attributes = {}) => add({ type: "observation", name, value, attributes: safe(attributes) }),
  };
  const tracer: Tracer = {
    start(name, attributes = {}) {
      add({ type: "span-start", name, attributes: safe(attributes) });
      return Object.freeze({
        set: (next: SafeAttributes) => add({ type: "span-attributes", name, attributes: safe(next) }),
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

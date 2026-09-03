export const RUNTIME_RECORD_KINDS = [
  "operation",
  "model",
  "route",
  "event",
  "consumer",
  "adapter",
  "entrypoint",
  "test",
  "feature",
  "repository",
  "relation",
  "schedule",
] as const;
export type RuntimeRecordKind = typeof RUNTIME_RECORD_KINDS[number];

export function isRuntimeRecordKind(value: string): value is RuntimeRecordKind {
  return RUNTIME_RECORD_KINDS.some((candidate) => candidate === value);
}

export const RUNTIME_RECORD_ID_VERSION = 1 as const;

function runtimeRecordSegment(value: string, label: string): string {
  if (value.trim() === "") throw new TypeError(`INVALID_RUNTIME_RECORD_${label.toUpperCase()}`);
  return encodeURIComponent(value);
}

export function runtimeRecordId(kind: RuntimeRecordKind, owner: string, name: string): string {
  return `rid${String(RUNTIME_RECORD_ID_VERSION)}/${kind}/${runtimeRecordSegment(owner, "owner")}/${runtimeRecordSegment(name, "name")}`;
}

export interface RuntimeRecordIdentity {
  readonly version: typeof RUNTIME_RECORD_ID_VERSION;
  readonly kind: RuntimeRecordKind;
  readonly owner: string;
  readonly name: string;
}

export function parseRuntimeRecordId(value: string): RuntimeRecordIdentity {
  const [prefix, kind, ownerSegment, nameSegment, ...extra] = value.split("/");
  if (prefix !== `rid${String(RUNTIME_RECORD_ID_VERSION)}` || extra.length > 0 || ownerSegment === undefined || nameSegment === undefined) {
    throw new TypeError(`INVALID_RUNTIME_RECORD_ID:${value}`);
  }
  if (typeof kind !== "string" || !isRuntimeRecordKind(kind)) {
    throw new TypeError(`INVALID_RUNTIME_RECORD_ID:${value}`);
  }
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(ownerSegment);
    name = decodeURIComponent(nameSegment);
  } catch {
    throw new TypeError(`INVALID_RUNTIME_RECORD_ID:${value}`);
  }
  if (runtimeRecordId(kind, owner, name) !== value) throw new TypeError(`INVALID_RUNTIME_RECORD_ID:${value}`);
  return Object.freeze({ version: RUNTIME_RECORD_ID_VERSION, kind, owner, name });
}

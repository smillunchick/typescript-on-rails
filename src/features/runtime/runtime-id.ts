export type RuntimeRecordKind = "operation" | "route" | "event" | "consumer" | "entrypoint";

export function runtimeRecordId(kind: RuntimeRecordKind, owner: string, name: string): string {
  return `${kind}/${owner}/${name}`;
}

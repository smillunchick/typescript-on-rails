import { createHash } from "node:crypto";

export interface ComposedSemanticRecord {
  readonly kind: string;
  readonly owner: string;
  readonly name: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}
export interface ArchitectureManifestV3Like {
  readonly composition: readonly ComposedSemanticRecord[];
  readonly base: { readonly dependencies: readonly { readonly from: string; readonly to: string; readonly file: string; readonly line: number; readonly symbols: readonly string[] }[] };
  readonly completeness: {
    readonly observations: readonly { readonly category: "declared" | "discovered-undeclared" | "outside-root" | "unknown"; readonly kind: string; readonly name: string; readonly root: string; readonly file?: string; readonly reason: string }[];
    readonly counts: Readonly<Record<"declared" | "discovered-undeclared" | "outside-root" | "unknown", number>>;
    readonly complete: boolean;
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

export interface SemanticBrief {
  readonly version: 1;
  readonly selectors: readonly string[];
  readonly records: readonly ComposedSemanticRecord[];
  readonly dependencies: ArchitectureManifestV3Like["base"]["dependencies"];
  readonly completeness: ArchitectureManifestV3Like["completeness"];
  readonly sourceBodiesIncluded: false;
  readonly contextBenefitClaim: false;
  readonly sha256: string;
}

export function semanticBrief(manifest: ArchitectureManifestV3Like, selectors: readonly string[]): SemanticBrief {
  const selected = [...new Set(selectors)].sort();
  const records = manifest.composition.filter((record) => selected.includes(record.owner) || selected.includes(record.name));
  const dependencies = manifest.base.dependencies.filter((edge) => selected.includes(edge.from) || selected.includes(edge.to));
  const body = {
    version: 1 as const,
    selectors: selected,
    records,
    dependencies,
    completeness: manifest.completeness,
    sourceBodiesIncluded: false as const,
    contextBenefitClaim: false as const,
  };
  return Object.freeze({ ...body, sha256: createHash("sha256").update(canonical(body)).digest("hex") });
}

export interface TraceRecord {
  readonly kind: "request" | "operation";
  readonly name: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: "success" | "failure";
  readonly correlationId?: string;
}

export class ExecutionTrace {
  readonly #records: TraceRecord[] = [];
  records(): readonly TraceRecord[] { return Object.freeze([...this.#records]); }
  async capture<T>(kind: TraceRecord["kind"], name: string, run: () => Promise<T> | T, options: { readonly correlationId?: string; readonly now?: () => number } = {}): Promise<T> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    try {
      const result = await run();
      this.#records.push(Object.freeze({ kind, name, startedAt, endedAt: now(), outcome: "success", ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) }));
      return result;
    } catch (error) {
      this.#records.push(Object.freeze({ kind, name, startedAt, endedAt: now(), outcome: "failure", ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }) }));
      throw error;
    }
  }
}

export function testsFor(manifest: ArchitectureManifestV3Like, selector: string): readonly string[] {
  const owners = new Set(manifest.composition.filter((record) => record.name === selector || record.owner === selector).map(({ owner }) => owner));
  return Object.freeze(manifest.composition.filter((record) => record.kind === "test" && owners.has(record.owner)).map(({ name }) => name).sort());
}

export function unknowns(manifest: ArchitectureManifestV3Like): readonly ArchitectureManifestV3Like["completeness"]["observations"][number][] {
  return Object.freeze(manifest.completeness.observations.filter(({ category }) => category !== "declared"));
}

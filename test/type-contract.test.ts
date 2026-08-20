import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import {
  analyzeTypeContractsWithTypescript,
  canonicalTypeContract,
  type AnalyzedCallbackTypeContract,
  type TypeContract,
  type TypeContractNode,
} from "../src/infra/typescript/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function analyzeCallbacks(files: Readonly<Record<string, string>>) {
  const fixture = await createAppFixture(files);
  fixtures.push(fixture);
  return analyzeTypeContractsWithTypescript(fixture.root).callbacks;
}

function callback(callbacks: readonly AnalyzedCallbackTypeContract[], name: string): AnalyzedCallbackTypeContract {
  const found = callbacks.find((entry) => entry.name === name);
  assert.ok(found, `missing callback ${name}`);
  return found;
}

function resolvedOutput(entry: AnalyzedCallbackTypeContract): TypeContract {
  assert.equal(entry.output.status, "resolved", entry.output.status === "unresolved" ? entry.output.diagnostic.message : undefined);
  if (entry.output.status !== "resolved") throw new Error("unresolved output");
  return entry.output.contract;
}

function rootNode(contract: TypeContract): TypeContractNode {
  const node = contract.nodes.find((entry) => entry.id === contract.root);
  assert.ok(node);
  return node;
}

describe("TypeScript type contracts", () => {
  it("runs under the pinned compiler and extracts InvoiceApproval from callback semantics", async () => {
    assert.equal(ts.version, "5.9.3");
    const callbacks = await analyzeCallbacks({
      "src/features/billing/index.ts": `
import { action, object, string } from "typescript-on-rails";
throw new Error("application source must not execute during analysis");
interface InvoiceApproval { invoiceId: string; approvedBy: string }
const approve = (input: InvoiceApproval): Promise<InvoiceApproval> => Promise.resolve(input);
export const approveInvoice = action({ input: object({ invoiceId: string(), approvedBy: string() }), public: true, run: approve });
`,
    });

    assert.equal(callbacks.length, 1);
    const callback = callbacks[0];
    assert.equal(callback?.name, "approveInvoice");
    assert.equal(callback?.input.status, "resolved");
    assert.equal(callback?.output.status, "resolved");
    if (callback?.input.status !== "resolved" || callback.output.status !== "resolved") return;
    assert.deepEqual(callback.input.labels, ["InvoiceApproval"]);
    assert.equal(canonicalTypeContract(callback.input.contract), canonicalTypeContract(callback.output.contract));
    assert.match(canonicalTypeContract(callback.input.contract), /approvedBy/);
    assert.match(canonicalTypeContract(callback.input.contract), /invoiceId/);
    assert.doesNotMatch(canonicalTypeContract(callback.input.contract), /InvoiceApproval/);
  });

  it("characterizes generated and reference callback shapes", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/generated/index.ts": `
import { action, id, object, route } from "typescript-on-rails";
interface InvoiceApproval { invoiceId: string; approvedBy: string }
interface Context { readonly permissions: ReadonlySet<string>; readonly userId: string }
export const generated = action({ input: object({}), public: true, run: () => undefined });
export const approveInvoice = action({
  input: object({ invoiceId: id("Invoice") }),
  public: true,
  run: ({ invoiceId }, context: Context): InvoiceApproval => ({ invoiceId, approvedBy: context.userId }),
});
export const invoiceRoute = route({
  method: "GET",
  path: "/invoices/:invoiceId",
  input: object({ invoiceId: id("Invoice") }),
  public: true,
  handler: (input, context: Context) => Promise.resolve({ invoiceId: input.invoiceId, approvedBy: context.userId }),
});
`,
    });
    assert.equal(callback(callbacks, "generated").input.status, "resolved");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "generated"))).kind, "undefined");
    assert.deepEqual(callback(callbacks, "approveInvoice").output.labels, ["InvoiceApproval"]);
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "invoiceRoute"))).kind, "object");
  });

  it("lowers supported sync, awaited, collection, object, union, Date, and nullish outputs", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/contracts/index.ts": `
import { action, object, route, string } from "typescript-on-rails";
type Input = { id: string };
type OptionalReadonly = { readonly required: string; optional?: number };
type Shared = { value: string };
declare const syncHandler: (input: Input) => string;
declare const asyncHandler: (input: Input) => Promise<number>;
declare const nestedHandler: (input: Input) => PromiseLike<PromiseLike<boolean>>;
declare const voidHandler: (input: Input) => void;
declare const undefinedHandler: (input: Input) => undefined;
declare const nullHandler: (input: Input) => null;
declare const literalHandler: (input: Input) => "ok";
declare const unknownHandler: (input: Input) => unknown;
declare const arrayHandler: (input: Input) => readonly string[];
declare const tupleHandler: (input: Input) => readonly [string, number?];
declare const objectHandler: (input: Input) => OptionalReadonly;
declare const unionHandler: (input: Input) => string | number | null;
declare const dateHandler: (input: Input) => Date;
declare const sharedHandler: (input: Input) => { left: Shared; right: Shared };
export const sync = action({ input: object({ id: string() }), public: true, run: syncHandler });
export const asyncValue = action({ input: object({ id: string() }), public: true, run: asyncHandler });
export const nested = action({ input: object({ id: string() }), public: true, run: nestedHandler });
export const voidValue = action({ input: object({ id: string() }), public: true, run: voidHandler });
export const undefinedValue = action({ input: object({ id: string() }), public: true, run: undefinedHandler });
export const nullValue = action({ input: object({ id: string() }), public: true, run: nullHandler });
export const literalValue = action({ input: object({ id: string() }), public: true, run: literalHandler });
export const unknownValue = action({ input: object({ id: string() }), public: true, run: unknownHandler });
export const arrayValue = action({ input: object({ id: string() }), public: true, run: arrayHandler });
export const tupleValue = action({ input: object({ id: string() }), public: true, run: tupleHandler });
export const objectValue = action({ input: object({ id: string() }), public: true, run: objectHandler });
export const unionValue = action({ input: object({ id: string() }), public: true, run: unionHandler });
export const dateValue = action({ input: object({ id: string() }), public: true, run: dateHandler });
export const sharedValue = action({ input: object({ id: string() }), public: true, run: sharedHandler });
export const delegatedRoute = route({ method: "GET", path: "/contracts/:id", input: object({ id: string() }), public: true, handler: asyncHandler });
`,
    });

    assert.equal((rootNode(resolvedOutput(callback(callbacks, "sync"))) as { kind: string }).kind, "primitive");
    assert.equal((rootNode(resolvedOutput(callback(callbacks, "asyncValue"))) as { kind: string }).kind, "primitive");
    assert.equal((rootNode(resolvedOutput(callback(callbacks, "nested"))) as { kind: string }).kind, "primitive");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "voidValue"))).kind, "void");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "undefinedValue"))).kind, "undefined");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "nullValue"))).kind, "literal");
    assert.deepEqual(rootNode(resolvedOutput(callback(callbacks, "literalValue"))), { id: "n0", kind: "literal", valueType: "string", value: "ok" });
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "unknownValue"))).kind, "unknown");
    const array = rootNode(resolvedOutput(callback(callbacks, "arrayValue")));
    assert.equal(array.kind, "array");
    if (array.kind === "array") assert.equal(array.readonly, true);
    const tuple = rootNode(resolvedOutput(callback(callbacks, "tupleValue")));
    assert.equal(tuple.kind, "tuple");
    if (tuple.kind === "tuple") assert.deepEqual(tuple.elements.map(({ optional, rest }) => ({ optional, rest })), [
      { optional: false, rest: false },
      { optional: true, rest: false },
    ]);
    const object = rootNode(resolvedOutput(callback(callbacks, "objectValue")));
    assert.equal(object.kind, "object");
    if (object.kind === "object") assert.deepEqual(object.properties.map(({ name, optional, readonly }) => ({ name, optional, readonly })), [
      { name: "optional", optional: true, readonly: false },
      { name: "required", optional: false, readonly: true },
    ]);
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "unionValue"))).kind, "union");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "dateValue"))).kind, "date");
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "delegatedRoute"))).kind, "primitive");
    const shared = rootNode(resolvedOutput(callback(callbacks, "sharedValue")));
    assert.equal(shared.kind, "object");
    if (shared.kind === "object") assert.equal(shared.properties[0]?.type, shared.properties[1]?.type);
  });

  it("makes aliases, declaration order, union order, imports, and callback spelling non-semantic", async () => {
    const first = await analyzeCallbacks({
      "src/features/equivalent/types.ts": `export type ImportedName = { z: number; a: string };`,
      "src/features/equivalent/index.ts": `
import { action, object, string } from "typescript-on-rails";
import type { ImportedName as LocalName } from "./types.js";
type FirstAlias = LocalName | null;
declare const named: (input: { id: string }) => FirstAlias;
export const value = action({ input: object({ id: string() }), public: true, run: named });
`,
    });
    const second = await analyzeCallbacks({
      "src/features/equivalent/index.ts": `
import { action, object, string } from "typescript-on-rails";
type RenamedAlias = null | { a: string; z: number };
export const value = action({ public: true, input: object({ id: string() }), run: (input: { id: string }): RenamedAlias => input.id === "" ? null : { z: 1, a: input.id } });
`,
    });
    const firstOutput = callback(first, "value").output;
    const secondOutput = callback(second, "value").output;
    assert.equal(firstOutput.status, "resolved");
    assert.equal(secondOutput.status, "resolved");
    if (firstOutput.status !== "resolved" || secondOutput.status !== "resolved") return;
    assert.equal(canonicalTypeContract(firstOutput.contract), canonicalTypeContract(secondOutput.contract));
    assert.notDeepEqual(firstOutput.labels, secondOutput.labels);
  });

  it("produces the same semantic contract in separate checkout roots", async () => {
    const files = {
      "src/features/stable/index.ts": `
import { action, object, string } from "typescript-on-rails";
interface Stable { readonly values: [string, number] }
declare const run: (input: { id: string }) => Promise<Stable>;
export const stable = action({ input: object({ id: string() }), public: true, run });
`,
    };
    const first = resolvedOutput(callback(await analyzeCallbacks(files), "stable"));
    const second = resolvedOutput(callback(await analyzeCallbacks(files), "stable"));
    assert.equal(canonicalTypeContract(first), canonicalTypeContract(second));
  });

  it("rejects recursive generic declarations without rejecting finite generic nesting", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/recursive/index.ts": "export {};",
      "src/features/recursive/cases.ts": `
import { action, object } from "typescript-on-rails";
type Growing<T> = { next: Growing<[T]> };
interface Terminating<T> { next: T extends string ? Terminating<number> : null }
type Box<T> = { value: T };
declare const growing: (input: {}) => Growing<string>;
declare const terminating: (input: {}) => Terminating<string>;
declare const finite: (input: {}) => Box<Box<string>>;
export const growingValue = action({ input: object({}), public: true, run: growing });
export const terminatingValue = action({ input: object({}), public: true, run: terminating });
export const finiteValue = action({ input: object({}), public: true, run: finite });
`,
    });
    for (const name of ["growingValue", "terminatingValue"]) {
      const output = callback(callbacks, name).output;
      assert.equal(output.status, "unresolved");
      if (output.status === "unresolved") assert.equal(output.diagnostic.code, "TC002");
    }
    assert.equal(callback(callbacks, "finiteValue").output.status, "resolved");
  });

  it("deduplicates structurally equal union members by their canonical node", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/union/index.ts": `
import { action, object } from "typescript-on-rails";
type Left = { value: string };
type Right = { value: string };
declare const run: (input: {}) => Left | Right;
export const unionValue = action({ input: object({}), public: true, run });
`,
    });
    const union = rootNode(resolvedOutput(callback(callbacks, "unionValue")));
    assert.equal(union.kind, "union");
    if (union.kind === "union") assert.equal(union.members.length, 1);
  });

  it("rejects computed and unique-symbol semantics without serializing compiler IDs", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/symbols/index.ts": `
import { action, object } from "typescript-on-rails";
declare const key: unique symbol;
type Computed = { [key]: string };
declare const computed: (input: {}) => Computed;
declare const uniqueValue: (input: {}) => typeof key;
export const computedOutput = action({ input: object({}), public: true, run: computed });
export const uniqueOutput = action({ input: object({}), public: true, run: uniqueValue });
`,
    });
    for (const name of ["computedOutput", "uniqueOutput"]) {
      const output = callback(callbacks, name).output;
      assert.equal(output.status, "unresolved");
      if (output.status === "unresolved") assert.equal(output.diagnostic.code, "TC011");
    }
    assert.doesNotMatch(JSON.stringify(callbacks.map(({ input, output }) => ({ input, output }))), /__@[^\"]*@\d+/);
  });

  it("uses effective checker readonly semantics for mapped object properties", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/readonly/index.ts": `
import { action, object } from "typescript-on-rails";
declare const mapped: (input: {}) => Readonly<{ value: string }>;
declare const explicit: (input: {}) => { readonly value: string };
declare const mutable: (input: {}) => { value: string };
export const mappedValue = action({ input: object({}), public: true, run: mapped });
export const explicitValue = action({ input: object({}), public: true, run: explicit });
export const mutableValue = action({ input: object({}), public: true, run: mutable });
`,
    });
    const mapped = canonicalTypeContract(resolvedOutput(callback(callbacks, "mappedValue")));
    const explicit = canonicalTypeContract(resolvedOutput(callback(callbacks, "explicitValue")));
    const mutable = canonicalTypeContract(resolvedOutput(callback(callbacks, "mutableValue")));
    assert.equal(mapped, explicit);
    assert.notEqual(mapped, mutable);
  });

  it("does not classify a module-local ReadonlyArray interface as an array", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/shadow/index.ts": `
import { action, object } from "typescript-on-rails";
interface ReadonlyArray<T> { value: T }
declare const shadowed: (input: {}) => ReadonlyArray<string>;
export const shadowedValue = action({ input: object({}), public: true, run: shadowed });
`,
    });
    assert.equal(rootNode(resolvedOutput(callback(callbacks, "shadowedValue"))).kind, "object");
  });

  it("rejects unsupported facets as a whole with stable diagnostics", async () => {
    const callbacks = await analyzeCallbacks({
      "src/features/unsupported/index.ts": `
import { action, object, string } from "typescript-on-rails";
type Input = { id: string };
interface NamedRecursive { next?: NamedRecursive }
type AnonymousRecursive = { child: { parent: AnonymousRecursive } };
type Callable = { callback: () => string };
type Constructable = { make: new () => object };
class UnsupportedClass { value = "x" }
type Indexed = { [key: string]: string };
interface InvalidAwaitable { then(onfulfilled: string): void }
declare const anyRun: (input: Input) => any;
declare const namedRecursive: (input: Input) => NamedRecursive;
declare const anonymousRecursive: (input: Input) => AnonymousRecursive;
declare const callable: (input: Input) => Callable;
declare const constructable: (input: Input) => Constructable;
declare const classValue: (input: Input) => UnsupportedClass;
declare const indexed: (input: Input) => Indexed;
declare const invalidAwaitable: (input: Input) => InvalidAwaitable;
declare function generic<T>(input: Input): T;
declare function conditional<T>(input: Input): T extends string ? string : number;
export const anyValue = action({ input: object({ id: string() }), public: true, run: anyRun });
export const namedCycle = action({ input: object({ id: string() }), public: true, run: namedRecursive });
export const anonymousCycle = action({ input: object({ id: string() }), public: true, run: anonymousRecursive });
export const callableValue = action({ input: object({ id: string() }), public: true, run: callable });
export const constructableValue = action({ input: object({ id: string() }), public: true, run: constructable });
export const classOutput = action({ input: object({ id: string() }), public: true, run: classValue });
export const indexedOutput = action({ input: object({ id: string() }), public: true, run: indexed });
export const invalidOutput = action({ input: object({ id: string() }), public: true, run: invalidAwaitable });
export const genericOutput = action({ input: object({ id: string() }), public: true, run: generic });
export const conditionalOutput = action({ input: object({ id: string() }), public: true, run: conditional });
`,
    });
    const expected = new Map([
      ["anyValue", "TC001"],
      ["namedCycle", "TC002"],
      ["anonymousCycle", "TC002"],
      ["callableValue", "TC004"],
      ["constructableValue", "TC004"],
      ["classOutput", "TC005"],
      ["indexedOutput", "TC006"],
      ["invalidOutput", "TC008"],
      ["genericOutput", "TC003"],
      ["conditionalOutput", "TC003"],
    ]);
    for (const [name, code] of expected) {
      const output = callback(callbacks, name).output;
      assert.equal(output.status, "unresolved", name);
      if (output.status !== "unresolved") continue;
      assert.equal(output.diagnostic.code, code, name);
      assert.equal(output.diagnostic.path.startsWith("output"), true, name);
      assert.ok(output.diagnostic.message.length > 0, name);
      assert.equal("contract" in output, false, name);
    }
  });
});

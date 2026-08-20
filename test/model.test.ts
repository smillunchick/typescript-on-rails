import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidInput,
  Unexpected,
  adaptSchema,
  defineModel,
  enumOf,
  id,
  invariant,
  money,
  type ObjectOutput,
} from "../src/index.js";

describe("models and invariants", () => {
  const invoiceFields = {
    id: id("Invoice"),
    status: enumOf("draft", "paid"),
    total: money(),
  };
  type InvoiceData = ObjectOutput<typeof invoiceFields>;

  const Invoice = defineModel({
    name: "Invoice",
    fields: invoiceFields,
    invariants: [
      invariant<InvoiceData>("paid invoices must have a positive total", (invoice) => {
        return invoice.status !== "paid" || invoice.total > 0;
      }),
    ],
  });

  it("parses valid model data", () => {
    assert.deepEqual(Invoice.parse({ id: "inv_1", status: "paid", total: 100 }), {
      id: "inv_1",
      status: "paid",
      total: 100,
    });
  });

  it("rejects a broken domain invariant by name", () => {
    assert.throws(
      () => Invoice.validate({ id: "inv_1", status: "paid", total: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput);
        assert.match(error.message, /paid invoices must have a positive total/);
        return true;
      },
    );
  });

  it("publishes serializable model metadata without predicate code", () => {
    assert.deepEqual(Invoice.metadata, {
      kind: "model",
      name: "Invoice",
      fields: {
        id: { kind: "id", entity: "Invoice" },
        status: { kind: "enum", values: ["draft", "paid"] },
        total: { kind: "money", currency: "minor-unit" },
      },
      invariants: ["paid invoices must have a positive total"],
    });
  });

  it("normalizes adapted fields before model validation", () => {
    const externalId = adaptSchema({
      metadata: { kind: "id", entity: "External" } as const,
      parse: (value: unknown) => typeof value === "string"
        ? { success: true as const, value }
        : { success: false as const, error: value },
      mapError: () => [{ code: "invalid_type", expected: "string", received: "number" }],
    });
    const External = defineModel({ name: "External", fields: { id: externalId } });

    assert.deepEqual(External.parse({ id: "external_1" }), { id: "external_1" });
    assert.deepEqual(External.metadata.fields.id, { kind: "id", entity: "External" });
    assert.throws(() => External.parse({ id: 1 }), InvalidInput);
  });

  it("rejects a parser thenable before invariants receive model data", () => {
    let invariantCalls = 0;
    const asynchronous = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => Promise.resolve({ success: true as const, value: "late" })) as unknown as () => { readonly success: true; readonly value: string },
      mapError: () => [{ code: "invalid_value" }],
    });
    const Async = defineModel({
      name: "Async",
      fields: { value: asynchronous },
      invariants: [invariant<{ readonly value: string }>("must not run", () => {
        invariantCalls += 1;
        return true;
      })],
    });

    assert.throws(() => Async.parse({ value: "input" }), Unexpected);
    assert.equal(invariantCalls, 0);
  });
});

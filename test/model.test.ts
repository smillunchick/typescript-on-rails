import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidInput,
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
});

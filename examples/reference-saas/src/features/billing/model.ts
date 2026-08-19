import {
  defineModel,
  enumOf,
  id,
  invariant,
  money,
  type ObjectOutput,
} from "typescript-on-rails";

const invoiceFields = {
  id: id("Invoice"),
  customerId: id("Customer"),
  status: enumOf("draft", "issued", "paid"),
  total: money(),
};

export type InvoiceRecord = ObjectOutput<typeof invoiceFields>;

export const Invoice = defineModel({
  name: "Invoice",
  fields: invoiceFields,
  invariants: [
    invariant<InvoiceRecord>(
      "issued and paid invoices must have a positive total",
      (invoice) => invoice.status === "draft" || invoice.total > 0,
    ),
  ],
});

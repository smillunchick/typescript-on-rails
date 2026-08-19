import { id, object, query } from "typescript-on-rails";

import { Invoice, type InvoiceRecord } from "./model.js";

const invoices: readonly InvoiceRecord[] = [
  Invoice.parse({
    id: "invoice_1",
    customerId: "customer_1",
    status: "issued",
    total: 12500,
  }),
];

export const getInvoice = query({
  input: object({ invoiceId: id("Invoice") }),
  permission: "invoice.read",
  run: ({ invoiceId }) => invoices.find((invoice) => invoice.id === invoiceId) ?? null,
});

export const listInvoices = query({
  input: object({}),
  permission: "invoice.read",
  run: () => invoices,
});

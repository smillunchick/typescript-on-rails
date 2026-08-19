import { Invoice, type InvoiceRecord } from "./model.js";

const invoices: readonly InvoiceRecord[] = [
  Invoice.parse({
    id: "invoice_1",
    customerId: "customer_1",
    status: "issued",
    total: 12500,
  }),
];

export function findInvoiceForCustomer(invoiceId: string, customerId: string): InvoiceRecord | null {
  return invoices.find((invoice) => (
    invoice.id === invoiceId && invoice.customerId === customerId
  )) ?? null;
}

export function listInvoicesForCustomer(customerId: string): readonly InvoiceRecord[] {
  return invoices.filter((invoice) => invoice.customerId === customerId);
}

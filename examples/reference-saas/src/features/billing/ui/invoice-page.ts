import type { InvoiceRecord } from "../model.js";

export interface InvoicePageView {
  readonly title: string;
  readonly status: InvoiceRecord["status"];
  readonly total: string;
}

export function invoicePage(invoice: InvoiceRecord): InvoicePageView {
  return {
    title: `Invoice ${invoice.id}`,
    status: invoice.status,
    total: (invoice.total / 100).toFixed(2),
  };
}

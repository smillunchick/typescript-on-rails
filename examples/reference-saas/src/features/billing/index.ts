import { defineFeature } from "typescript-on-rails";

import { Payments } from "./payments.js";

export const billingFeature = defineFeature({ name: "billing", adapters: [Payments] });

export { approveInvoice, payInvoice, type InvoiceApproval } from "./actions.js";
export type { BillingContext } from "./context.js";
export { InvoicePaid } from "./events.js";
export { Invoice, type InvoiceRecord } from "./model.js";
export { Payments };
export { getInvoice, listInvoices } from "./queries.js";
export { invoiceRoute } from "./routes.js";
export { invoicePage, type InvoicePageView } from "./ui/invoice-page.js";

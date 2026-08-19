import { id, object, query } from "typescript-on-rails";

import type { AuthenticatedContext } from "@/features/identity";

import { findInvoiceForCustomer, listInvoicesForCustomer } from "./data.js";

export const getInvoice = query({
  input: object({ invoiceId: id("Invoice") }),
  authorize: ({ invoiceId }, context: AuthenticatedContext) => (
    context.permissions.has("invoice.read")
    && findInvoiceForCustomer(invoiceId, context.customerId) !== null
  ),
  run: ({ invoiceId }, context) => findInvoiceForCustomer(invoiceId, context.customerId),
});

export const listInvoices = query({
  input: object({}),
  authorize: (_input, context: AuthenticatedContext) => context.permissions.has("invoice.read"),
  run: (_input, context) => listInvoicesForCustomer(context.customerId),
});

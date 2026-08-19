import { id, object, route } from "typescript-on-rails";

import type { AuthenticatedContext } from "@/features/identity";

import { getInvoice } from "./queries.js";

export const invoiceRoute = route({
  method: "GET",
  path: "/invoices/:invoiceId",
  input: object({ invoiceId: id("Invoice") }),
  permission: "invoice.read",
  handler: (input, context: AuthenticatedContext) => getInvoice.execute(input, context),
});

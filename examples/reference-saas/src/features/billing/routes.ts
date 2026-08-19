import { id, object, route } from "typescript-on-rails";

import { getInvoice } from "./queries.js";

export const invoiceRoute = route({
  method: "GET",
  path: "/invoices/:invoiceId",
  input: object({ invoiceId: id("Invoice") }),
  permission: "invoice.read",
  handler: (input, context) => getInvoice.execute(input, context),
});

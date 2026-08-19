import { event, id, money, object } from "typescript-on-rails";

export const InvoicePaid = event({
  name: "InvoicePaid",
  payload: object({
    invoiceId: id("Invoice"),
    customerId: id("Customer"),
    amount: money(),
  }),
});

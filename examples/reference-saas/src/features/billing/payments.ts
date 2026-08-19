import {
  boolean,
  defineAdapterContract,
  id,
  money,
  object,
  string,
} from "typescript-on-rails";

export const Payments = defineAdapterContract({
  name: "Payments",
  operations: {
    charge: {
      input: object({
        invoiceId: id("Invoice"),
        amount: money(),
      }),
      output: object({
        accepted: boolean(),
        reference: string(),
      }),
    },
  },
});

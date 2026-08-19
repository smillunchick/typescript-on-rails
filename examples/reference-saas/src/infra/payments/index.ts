import { implementAdapter } from "typescript-on-rails";

import { Payments } from "@/features/billing";

export const payments = implementAdapter(Payments, {
  charge: ({ invoiceId }) => ({
    accepted: true,
    reference: `payment:${invoiceId}`,
  }),
});

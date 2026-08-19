import { action, id, object } from "typescript-on-rails";

import type { UserId } from "@/features/identity";

export interface InvoiceApproval {
  readonly invoiceId: string;
  readonly approvedBy: UserId;
}

export const approveInvoice = action({
  input: object({
    invoiceId: id("Invoice"),
    approvedBy: id("User"),
  }),
  permission: "invoice.approve",
  run: ({ invoiceId, approvedBy }): InvoiceApproval => ({ invoiceId, approvedBy }),
});

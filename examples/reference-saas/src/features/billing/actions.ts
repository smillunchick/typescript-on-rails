import {
  Conflict,
  Forbidden,
  action,
  boolean,
  enumOf,
  id,
  object,
  string,
} from "typescript-on-rails";

import type { AuthenticatedContext, UserId } from "@/features/identity";

import type { BillingContext } from "./context.js";
import { findInvoiceForCustomer } from "./data.js";
import { InvoicePaid } from "./events.js";

const PaymentResult = object({
  accepted: boolean(),
  reference: string(),
  eventDelivery: enumOf("delivered", "failed"),
});

export interface InvoiceApproval {
  readonly invoiceId: string;
  readonly approvedBy: UserId;
}

export const approveInvoice = action({
  input: object({
    invoiceId: id("Invoice"),
  }),
  permission: "invoice.approve",
  run: ({ invoiceId }, context: AuthenticatedContext): InvoiceApproval => {
    if (findInvoiceForCustomer(invoiceId, context.customerId) === null) {
      throw new Forbidden();
    }
    return {
      invoiceId,
      approvedBy: context.userId,
    };
  },
});

export const payInvoice = action({
  input: object({
    invoiceId: id("Invoice"),
  }),
  output: PaymentResult,
  permission: "invoice.pay",
  run: async ({ invoiceId }, context: BillingContext) => {
    const invoice = findInvoiceForCustomer(invoiceId, context.customerId);
    if (invoice === null) throw new Forbidden();

    const payment = await context.payments.charge({
      invoiceId,
      amount: invoice.total,
    });
    if (!payment.accepted) throw new Conflict("Payment was not accepted");

    let eventDelivery: "delivered" | "failed" = "delivered";
    try {
      await context.events.emit(InvoicePaid, {
        invoiceId,
        customerId: invoice.customerId,
        amount: invoice.total,
      });
    } catch {
      eventDelivery = "failed";
    }
    return { ...payment, eventDelivery };
  },
});

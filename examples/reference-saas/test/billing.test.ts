import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Conflict, Forbidden, createEventBus } from "typescript-on-rails";

import app from "../src/app.js";
import {
  InvoicePaid,
  approveInvoice,
  getInvoice,
  invoicePage,
  invoiceRoute,
  listInvoices,
  payInvoice,
} from "../src/features/billing/index.js";
import type { AuthenticatedContext } from "../src/features/identity/index.js";
import { getRevenueReport } from "../src/features/reports/index.js";

const context: AuthenticatedContext = {
  userId: "user_1",
  customerId: "customer_1",
  permissions: new Set(["invoice.approve", "invoice.pay", "invoice.read", "report.read", "user.read"]),
};
const anonymousContext: AuthenticatedContext = {
  userId: "user_1",
  customerId: "customer_1",
  permissions: new Set(),
};
const otherCustomerContext: AuthenticatedContext = {
  userId: "user_2",
  customerId: "customer_2",
  permissions: new Set(["invoice.approve", "invoice.pay", "invoice.read", "report.read", "user.read"]),
};

describe("reference SaaS billing promises", () => {
  it("requires permission and records who approved an invoice", async () => {
    await assert.rejects(
      () => approveInvoice.execute(
        { invoiceId: "invoice_1" },
        anonymousContext,
      ),
      Forbidden,
    );
    assert.deepEqual(
      await approveInvoice.execute(
        { invoiceId: "invoice_1", approvedBy: "spoofed_user" },
        context,
      ),
      { invoiceId: "invoice_1", approvedBy: "user_1" },
    );
    await assert.rejects(
      () => approveInvoice.execute({ invoiceId: "invoice_1" }, otherCustomerContext),
      Forbidden,
    );
    await assert.rejects(
      () => approveInvoice.execute({ invoiceId: "missing_invoice" }, context),
      Forbidden,
    );
  });

  it("enforces invoice route permissions and customer ownership", async () => {
    await assert.rejects(
      () => invoiceRoute.execute({ invoiceId: "invoice_1" }, anonymousContext),
      Forbidden,
    );
    assert.equal(
      (await invoiceRoute.execute({ invoiceId: "invoice_1" }, context))?.customerId,
      "customer_1",
    );
    await assert.rejects(
      () => invoiceRoute.execute({ invoiceId: "invoice_1" }, otherCustomerContext),
      Forbidden,
    );
    await assert.rejects(
      () => getInvoice.execute({ invoiceId: "invoice_1" }, otherCustomerContext),
      Forbidden,
    );
    await assert.rejects(
      () => payInvoice.execute({ invoiceId: "invoice_1" }, {
        ...otherCustomerContext,
        payments: app.adapters.payments.operations,
        events: createEventBus(),
      }),
      Forbidden,
    );
    assert.deepEqual(await listInvoices.execute({}, otherCustomerContext), []);
    assert.deepEqual(await getRevenueReport.execute({}, otherCustomerContext), {
      invoiceCount: 0,
      total: 0,
    });
  });

  it("uses real query, report, UI, event, and payment boundaries", async () => {
    const invoices = await listInvoices.execute({}, context);
    assert.deepEqual(await getRevenueReport.execute({}, context), {
      invoiceCount: 1,
      total: 12500,
    });
    const firstInvoice = invoices[0];
    assert.ok(firstInvoice);
    assert.equal(invoicePage(firstInvoice).total, "125.00");
    const bus = createEventBus();
    const paid: string[] = [];
    bus.on(InvoicePaid, ({ invoiceId }) => {
      paid.push(invoiceId);
    });
    assert.deepEqual(await payInvoice.execute({ invoiceId: "invoice_1" }, {
      ...context,
      payments: app.adapters.payments.operations,
      events: bus,
    }), {
      accepted: true,
      reference: "payment:invoice_1",
      eventDelivery: "delivered",
    });
    assert.deepEqual(paid, ["invoice_1"]);

    const failingBus = createEventBus();
    const attemptedAfterFailure: string[] = [];
    failingBus.on(InvoicePaid, () => {
      throw new Error("subscriber failed");
    });
    failingBus.on(InvoicePaid, ({ invoiceId }) => {
      attemptedAfterFailure.push(invoiceId);
    });
    assert.deepEqual(await payInvoice.execute({ invoiceId: "invoice_1" }, {
      ...context,
      payments: app.adapters.payments.operations,
      events: failingBus,
    }), {
      accepted: true,
      reference: "payment:invoice_1",
      eventDelivery: "failed",
    });
    assert.deepEqual(attemptedAfterFailure, ["invoice_1"]);

    const declinedBus = createEventBus();
    let declinedEvents = 0;
    declinedBus.on(InvoicePaid, () => {
      declinedEvents += 1;
    });
    await assert.rejects(
      () => payInvoice.execute({ invoiceId: "invoice_1" }, {
        ...context,
        payments: { charge: () => ({ accepted: false, reference: "declined" }) },
        events: declinedBus,
      }),
      Conflict,
    );
    assert.equal(declinedEvents, 0);
  });
});

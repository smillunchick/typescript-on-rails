import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Forbidden, createEventBus } from "typescript-on-rails";

import {
  InvoicePaid,
  approveInvoice,
  invoicePage,
  listInvoices,
} from "../src/features/billing/index.js";
import { getRevenueReport } from "../src/features/reports/index.js";
import { payments } from "../src/infra/payments/index.js";

const permissions = new Set(["invoice.approve", "invoice.read", "report.read"]);
const context = { permissions };

describe("reference SaaS billing promises", () => {
  it("requires permission and records who approved an invoice", async () => {
    await assert.rejects(
      () => approveInvoice.execute(
        { invoiceId: "invoice_1", approvedBy: "user_1" },
        { permissions: new Set() },
      ),
      Forbidden,
    );
    assert.deepEqual(
      await approveInvoice.execute(
        { invoiceId: "invoice_1", approvedBy: "user_1" },
        context,
      ),
      { invoiceId: "invoice_1", approvedBy: "user_1" },
    );
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
    assert.deepEqual(await payments.operations.charge({ invoiceId: "invoice_1", amount: 12500 }), {
      accepted: true,
      reference: "payment:invoice_1",
    });

    const bus = createEventBus();
    const paid: string[] = [];
    bus.on(InvoicePaid, ({ invoiceId }) => {
      paid.push(invoiceId);
    });
    await bus.emit(InvoicePaid, {
      invoiceId: "invoice_1",
      customerId: "customer_1",
      amount: 12500,
    });
    assert.deepEqual(paid, ["invoice_1"]);
  });
});

import { object, query } from "typescript-on-rails";

import { listInvoices } from "@/features/billing";
import type { AuthenticatedContext } from "@/features/identity";

export const getRevenueReport = query({
  input: object({}),
  permission: "report.read",
  run: async (_input, context: AuthenticatedContext) => {
    const invoices = await listInvoices.execute({}, context);
    return {
      invoiceCount: invoices.length,
      total: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
    };
  },
});

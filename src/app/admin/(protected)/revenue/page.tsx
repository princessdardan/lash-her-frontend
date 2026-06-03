import Link from "next/link";

import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { getAuditLogService } from "@/lib/admin/audit-log";
import { getAdminAuth } from "@/lib/admin/auth";
import { getAdminQueryService } from "@/lib/admin/queries";

export default async function AdminRevenuePage() {
  const actor = await getAdminAuth().requireAdmin();

  await getAuditLogService().record({
    action: "admin_access",
    actor,
    domain: "revenue",
  });

  const rows = await getAdminQueryService().listRevenueRows();

  return (
    <div className="space-y-6">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Revenue
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Unified Purchases
        </h1>
      </div>
      <AdminTable caption="Unified purchases across product, service, and training">
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className="px-4 py-3">Order</th>
            <th className="px-4 py-3">Domain</th>
            <th className="px-4 py-3">Customer</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.orderId}>
              <td className="px-4 py-3">
                <Link className="font-semibold text-lh-primary" href={row.href}>
                  {row.orderId}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusPill>{row.domain}</StatusPill>
              </td>
              <td className="px-4 py-3">{row.customerName}</td>
              <td className="px-4 py-3">{row.status}</td>
              <td className="px-4 py-3 text-right font-semibold">{row.amount}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}

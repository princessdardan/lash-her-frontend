import { redirect } from "next/navigation";

import { AdminTable } from "@/components/admin/admin-table";
import { getAdminAuth } from "@/lib/admin/auth";
import { AdminAuthError, type AdminActor } from "@/lib/admin/types";
import { getAuditLogService, listRecentAuditLogEntries } from "@/lib/admin/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  let actor: AdminActor;

  try {
    actor = await getAdminAuth().requireOwner();
  } catch (error) {
    if (error instanceof AdminAuthError) {
      redirect("/admin/not-authorized");
    }

    throw error;
  }

  await getAuditLogService().record({
    action: "audit_log_view",
    actor,
    domain: "audit",
  });

  const rows = await listRecentAuditLogEntries(100);

  return (
    <div className="space-y-6">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Owner only
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Audit Log
        </h1>
      </div>
      <AdminTable caption="Recent admin audit log entries">
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Domain</th>
            <th className="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">{row.createdAt.toISOString()}</td>
              <td className="px-4 py-3">{row.actorEmail}</td>
              <td className="px-4 py-3">{row.action}</td>
              <td className="px-4 py-3">{row.domain}</td>
              <td className="px-4 py-3">
                {row.targetType ? `${row.targetType}:${row.targetId ?? ""}` : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}

import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { listRecentAdminAuditEntries, recordAdminAudit } from "@/lib/admin/audit-log";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminAuditPage() {
  const actor = await requireAdminPagePermission("audit:view");
  const rows = await listRecentAdminAuditEntries(100);

  await recordAdminAudit({
    action: "audit_log_view",
    actor,
    domain: "admin",
    outcome: "success",
  });

  return (
    <div className="space-y-6">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Owner only
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Audit log
        </h1>
      </div>
      <AdminTable caption="Recent administrative audit events">
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className="px-4 py-3">When</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Domain</th>
            <th className="px-4 py-3">Outcome</th>
            <th className="px-4 py-3">Target</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3">
                <time dateTime={row.createdAt.toISOString()}>
                  {row.createdAt.toLocaleString("en-CA")}
                </time>
              </td>
              <td className="px-4 py-3">{row.actorEmail ?? "Removed user"}</td>
              <td className="px-4 py-3">{row.action}</td>
              <td className="px-4 py-3">{row.domain}</td>
              <td className="px-4 py-3">
                <StatusPill tone={row.outcome === "success" ? "success" : "attention"}>
                  {row.outcome}
                </StatusPill>
              </td>
              <td className="px-4 py-3">
                {row.targetType ? `${row.targetType}:${row.targetId ?? ""}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
    </div>
  );
}

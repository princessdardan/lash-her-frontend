import { AdminCard } from "@/components/admin/admin-card";
import { OperationsInbox } from "@/components/admin/operations-inbox";
import { getAuditLogService } from "@/lib/admin/audit-log";
import { getAdminAuth } from "@/lib/admin/auth";
import { getAdminQueryService } from "@/lib/admin/queries";
import { moneyFromCents } from "@/lib/admin/read-models";

export default async function AdminCommandCenterPage() {
  const actor = await getAdminAuth().requireAdmin();

  await getAuditLogService().record({
    action: "admin_access",
    actor,
    domain: "command_center",
  });

  const data = await getAdminQueryService().getCommandCenterData();

  return (
    <div className="space-y-8">
      <div>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Command Center
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em] text-lh-shadow">
          Today&apos;s Operations
        </h1>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminCard label="Recent revenue" value={moneyFromCents(data.cards.recentRevenueCents, "CAD")}>
          Last 30 paid or reviewed orders.
        </AdminCard>
        <AdminCard label="Recent orders" value={data.cards.recentOrders}>
          Product, service, and training purchases.
        </AdminCard>
        <AdminCard label="Marketing sources" value={data.cards.marketingSources}>
          Lead source summary groups.
        </AdminCard>
        <AdminCard label="Privacy cases" value={data.cards.openPrivacyRequests}>
          Open or in-review requests.
        </AdminCard>
      </div>
      <OperationsInbox items={data.inboxItems} />
    </div>
  );
}

import { AdminCard } from "@/components/admin/admin-card";
import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { getEmployeeAttributionAnalytics } from "@/lib/admin/employee-attribution-analytics";
import { getAdminAnalytics } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  await requireAdminPagePermission("analytics:view");
  const query = await searchParams;
  const from = firstString(query.from);
  const to = firstString(query.to);
  const [analytics, attributionResult] = await Promise.all([
    getAdminAnalytics(),
    getAttributionOrDefault(from, to),
  ]);
  const attribution = attributionResult.report;
  const appointmentRows = Object.entries(analytics.appointmentCounts);

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Last 30 days</p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">Business snapshot</h1>
        <p className="mt-3 max-w-3xl text-lh-muted">Operational totals from PostgreSQL. Revenue includes paid product, service, and training checkout orders.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminCard label="Paid revenue" value={money(analytics.revenueCents)}>{analytics.paidOrders} paid orders</AdminCard>
        <AdminCard label="Active contacts" value={analytics.contacts.active}>{analytics.contacts.unsubscribed} unsubscribed</AdminCard>
        <AdminCard label="Active offerings" value={analytics.offerings.active}>{analytics.offerings.total} total operational offerings</AdminCard>
        <AdminCard label="Appointments" value={appointmentRows.reduce((total, [, count]) => total + count, 0)}>Appointments scheduled in the reporting window</AdminCard>
      </div>
      <AdminTable caption="Appointments by status">
        <thead className={theadClass}><tr><th className={cellClass}>Appointment status</th><th className={`${cellClass} text-right`}>Count</th></tr></thead>
        <tbody className="divide-y divide-lh-line">{appointmentRows.map(([status, count]) => <tr key={status}><td className={cellClass}>{status}</td><td className={`${cellClass} text-right font-semibold`}>{count}</td></tr>)}</tbody>
      </AdminTable>

      <section className="space-y-4">
        <div>
          <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
            Employee attribution
          </p>
          <h2 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em]">
            Attributed net sales
          </h2>
          <p className="mt-2 max-w-4xl text-sm text-lh-muted">
            Historical provider and Square team-member snapshots only. Invoice
            no-show charges and legacy Payment Links are labeled as local
            attribution. This report does not calculate commissions, wages,
            taxes, or final employee payouts.
          </p>
        </div>
        {attributionResult.error ? (
          <AdminActionFeedback error={attributionResult.error} />
        ) : null}
        <form className="flex flex-wrap items-end gap-3" method="get">
          <Field label="From">
            <input className={inputClass} defaultValue={attribution.from} name="from" type="date" />
          </Field>
          <Field label="To">
            <input className={inputClass} defaultValue={attribution.to} name="to" type="date" />
          </Field>
          <button className={buttonClass} type="submit">Apply dates</button>
          <p className="text-xs text-lh-muted">Business timezone: {attribution.timezone}</p>
        </form>
        <AdminTable caption="Employee-attributed Square sales">
          <thead className={theadClass}>
            <tr>
              <th className={cellClass}>Employee snapshot</th>
              <th className={`${cellClass} text-right`}>Captured</th>
              <th className={`${cellClass} text-right`}>Known tips</th>
              <th className={`${cellClass} text-right`}>Refunded</th>
              <th className={`${cellClass} text-right`}>No-show</th>
              <th className={`${cellClass} text-right`}>Legacy</th>
              <th className={`${cellClass} text-right`}>Net sales</th>
              <th className={`${cellClass} text-right`}>Unattributed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lh-line">
            {attribution.rows.map((row) => (
              <tr key={row.attributionKey}>
                <td className={cellClass}>
                  <p className="font-semibold">{row.employeeLabel}</p>
                  <p className="mt-1 text-xs text-lh-muted">
                    {row.sourceLabels.join(" · ") || "No source label"}
                  </p>
                </td>
                <td className={`${cellClass} text-right`}>{money(row.capturedSalesCents)}</td>
                <td className={`${cellClass} text-right`}>{money(row.knownTipsCents)}</td>
                <td className={`${cellClass} text-right`}>{money(row.fullyRefundedCents)}</td>
                <td className={`${cellClass} text-right`}>{money(row.noShowChargesCents)}</td>
                <td className={`${cellClass} text-right`}>{money(row.legacyChargesCents)}</td>
                <td className={`${cellClass} text-right font-semibold`}>{money(row.netAttributedSalesCents)}</td>
                <td className={`${cellClass} text-right`}>{row.unattributedRecords}</td>
              </tr>
            ))}
            <tr className="bg-lh-neutral-2 font-semibold">
              <td className={cellClass}>Totals</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.capturedSalesCents)}</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.knownTipsCents)}</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.fullyRefundedCents)}</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.noShowChargesCents)}</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.legacyChargesCents)}</td>
              <td className={`${cellClass} text-right`}>{money(attribution.totals.netAttributedSalesCents)}</td>
              <td className={`${cellClass} text-right`}>{attribution.totals.unattributedRecords}</td>
            </tr>
          </tbody>
        </AdminTable>
      </section>
    </div>
  );
}

function money(cents: number) { return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(cents / 100); }
function firstString(value: string | string[] | undefined) {
  return typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
}
async function getAttributionOrDefault(from?: string, to?: string) {
  try {
    return {
      error: null,
      report: await getEmployeeAttributionAnalytics({ from, to }),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "The date range is invalid",
      report: await getEmployeeAttributionAnalytics(),
    };
  }
}
function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return <label className="block text-sm font-semibold"><span className="mb-2 block">{label}</span>{children}</label>;
}
const inputClass = "rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const buttonClass = "rounded-full border border-lh-line px-4 py-2 text-sm font-semibold";
const theadClass = "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3";

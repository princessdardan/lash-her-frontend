import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminCard } from "@/components/admin/admin-card";
import { AdminTabLink } from "@/components/admin/admin-tab-link";
import { AdminTable } from "@/components/admin/admin-table";
import { getEmployeeAttributionAnalytics } from "@/lib/admin/employee-attribution-analytics";
import { getAdminAnalytics } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getAppointmentStatusPresentation } from "@/lib/admin/presentation";
import type { AppointmentStatus } from "@/lib/private-db/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ReportTab = "appointments" | "methodology" | "overview" | "team-sales";

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string | string[];
    tab?: string | string[];
    to?: string | string[];
  }>;
}) {
  await requireAdminPagePermission("analytics:view");
  const query = await searchParams;
  const from = firstString(query.from);
  const to = firstString(query.to);
  const tab = normalizeTab(firstString(query.tab));
  const result = await getReportOrDefault(from, to);
  const analytics = result.analytics;
  const appointmentRows = Object.entries(
    analytics.period.scheduledAppointmentsByStatus,
  );
  const attribution =
    tab === "team-sales"
      ? await getAttributionOrDefault(analytics.range.from, analytics.range.to)
      : null;

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Insights
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Reports
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Review appointments, checkout payments, marketing growth, and
          attributed team payments for one date range.
        </p>
      </header>

      {result.error ? <AdminActionFeedback error={result.error} /> : null}

      <form
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-lh-line bg-white p-4"
        method="get"
      >
        <input name="tab" type="hidden" value={tab} />
        <Field label="From">
          <input
            className={inputClass}
            defaultValue={analytics.range.from}
            name="from"
            required
            type="date"
          />
        </Field>
        <Field label="To">
          <input
            className={inputClass}
            defaultValue={analytics.range.to}
            name="to"
            required
            type="date"
          />
        </Field>
        <button className={buttonClass} type="submit">
          Apply dates
        </button>
        <p className="basis-full text-xs text-lh-muted sm:basis-auto">
          Times use {timezoneLabel(analytics.timezone)}.
        </p>
      </form>

      <nav aria-label="Report sections" className="flex flex-wrap gap-2">
        {(
          [
            ["overview", "Overview"],
            ["appointments", "Appointments"],
            ["team-sales", "Team payments"],
            ["methodology", "Methodology"],
          ] as const
        ).map(([value, label]) => (
          <AdminTabLink
            active={tab === value}
            href={reportHref(value, analytics.range)}
            key={value}
          >
            {label}
          </AdminTabLink>
        ))}
      </nav>

      {tab === "overview" ? (
        <>
          <section aria-labelledby="period-overview-heading">
            <div>
              <p className="text-sm text-lh-muted">
                {formatRange(analytics.range.from, analytics.range.to)}
              </p>
              <h2
                className="mt-1 font-heading text-3xl uppercase tracking-[0.08em]"
                id="period-overview-heading"
              >
                Period overview
              </h2>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <AdminCard
                href={`/admin/appointments?view=all&status=completed&basis=completed&from=${analytics.range.from}&to=${analytics.range.to}`}
                label="Completed appointments"
                value={analytics.period.completedAppointments}
              />
              <AdminCard
                href={`/admin/payments?from=${analytics.range.from}&to=${analytics.range.to}`}
                label="Checkout payments received"
                value={money(analytics.period.paymentsReceivedCents)}
              >
                {analytics.period.paidCheckoutOrders} paid checkout records,
                before refunds
              </AdminCard>
              <AdminCard
                href={`/admin/marketing?tab=contacts&from=${analytics.range.from}&to=${analytics.range.to}`}
                label="New marketing opt-ins"
                value={analytics.period.newMarketingOptIns}
              />
              <AdminCard
                href={`/admin/payments?view=refunds&from=${analytics.range.from}&to=${analytics.range.to}`}
                label="Square refunds issued"
                value={money(analytics.period.refundsIssuedCents)}
              >
                Completed Square refund events only
              </AdminCard>
            </div>
          </section>

          <section className="rounded-2xl border border-lh-line bg-white p-6">
            <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
              Current business snapshot
            </h2>
            <p className="mt-2 text-sm text-lh-muted">
              These are current configuration and audience totals, not period
              performance.
            </p>
            <dl className="mt-5 grid gap-4 sm:grid-cols-3">
              <SnapshotValue
                label="Active marketing audience"
                value={analytics.currentAudience.currentAudience}
              />
              <SnapshotValue
                label="Unsubscribed contacts"
                value={analytics.currentAudience.unsubscribed}
              />
              <SnapshotValue
                label="Active bookable services"
                value={analytics.currentConfiguration.offerings.active}
              />
            </dl>
          </section>
        </>
      ) : null}

      {tab === "appointments" ? (
        <section className="space-y-4">
          <div>
            <p className="text-sm text-lh-muted">
              Scheduled start falls within{" "}
              {formatRange(analytics.range.from, analytics.range.to)}
            </p>
            <h2 className="mt-1 font-heading text-3xl uppercase tracking-[0.08em]">
              Appointments by status
            </h2>
          </div>
          <AdminTable caption="Appointments by status">
            <thead className={theadClass}>
              <tr>
                <th className={cellClass} scope="col">
                  Appointment status
                </th>
                <th className={`${cellClass} text-right`} scope="col">
                  Count
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-lh-line">
              {appointmentRows.map(([status, count]) => (
                <tr key={status}>
                  <td className={cellClass}>
                    {
                      getAppointmentStatusPresentation(
                        status as AppointmentStatus,
                      ).label
                    }
                  </td>
                  <td className={`${cellClass} text-right font-semibold`}>
                    {count}
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          {appointmentRows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
              No appointments start in this date range.
            </p>
          ) : null}
        </section>
      ) : null}

      {tab === "team-sales" && attribution ? (
        <TeamPaymentsSection result={attribution} />
      ) : null}

      {tab === "methodology" ? <Methodology /> : null}
    </div>
  );
}

function TeamPaymentsSection({
  result,
}: {
  result: Awaited<ReturnType<typeof getAttributionOrDefault>>;
}) {
  const attribution = result.report;
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Net attributed payments
        </h2>
        <p className="mt-2 max-w-4xl text-sm text-lh-muted">
          Captured payments and recorded no-show or legacy charges, less
          recorded refunds. This is operational attribution, not commissions,
          payroll, tax, or an accounting net-sales statement.
        </p>
      </div>
      {result.error ? <AdminActionFeedback error={result.error} /> : null}
      <AdminTable
        caption="Team-attributed Square payments"
        minimumWidth="financial"
        stickyFirstColumn
      >
        <thead className={theadClass}>
          <tr>
            {[
              "Team member",
              "Captured",
              "Known tips",
              "Refunds",
              "Fully refunded",
              "No-show",
              "Legacy",
              "Net attributed",
              "Unattributed",
            ].map((label, index) => (
              <th
                className={`${cellClass} ${index > 0 ? "text-right" : ""}`}
                key={label}
                scope="col"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {attribution.rows.map((row) => (
            <tr key={row.attributionKey}>
              <td className={`${cellClass} sticky left-0 bg-white`}>
                <p className="font-semibold">{row.employeeLabel}</p>
              </td>
              <MoneyCell value={row.capturedSalesCents} />
              <MoneyCell value={row.knownTipsCents} />
              <MoneyCell value={row.refundedCents} />
              <MoneyCell value={row.fullyRefundedCents} />
              <MoneyCell value={row.noShowChargesCents} />
              <MoneyCell value={row.legacyChargesCents} />
              <MoneyCell emphasized value={row.netAttributedSalesCents} />
              <td className={`${cellClass} text-right`}>
                {row.unattributedRecords}
              </td>
            </tr>
          ))}
          <tr className="bg-lh-neutral-2 font-semibold">
            <td className={`${cellClass} sticky left-0 bg-lh-neutral-2`}>
              Totals
            </td>
            <MoneyCell value={attribution.totals.capturedSalesCents} />
            <MoneyCell value={attribution.totals.knownTipsCents} />
            <MoneyCell value={attribution.totals.refundedCents} />
            <MoneyCell value={attribution.totals.fullyRefundedCents} />
            <MoneyCell value={attribution.totals.noShowChargesCents} />
            <MoneyCell value={attribution.totals.legacyChargesCents} />
            <MoneyCell value={attribution.totals.netAttributedSalesCents} />
            <td className={`${cellClass} text-right`}>
              {attribution.totals.unattributedRecords}
            </td>
          </tr>
        </tbody>
      </AdminTable>
      {attribution.rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
          No attributed Square payment records were found in this date range.
        </p>
      ) : null}
    </section>
  );
}

function Methodology() {
  return (
    <section className="space-y-4 rounded-2xl border border-lh-line bg-white p-6">
      <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
        Methodology
      </h2>
      <dl className="space-y-4 text-sm">
        <Method
          label="Completed appointments"
          value="Appointments whose completion was recorded during the selected business-date range."
        />
        <Method
          label="Checkout payments received"
          value="Paid or later-refunded checkout records whose paid time is in the range. The amount includes recorded Square tips and is shown before refunds."
        />
        <Method
          label="New marketing opt-ins"
          value="Contacts whose first recorded consent falls in the range."
        />
        <Method
          label="Square refunds issued"
          value="Distinct completed Square refund events whose provider event time falls in the range. Helcim refunds are not included in this figure."
        />
      </dl>
      <details className="rounded-xl border border-lh-line p-4">
        <summary className="cursor-pointer font-semibold">
          Technical attribution notes
        </summary>
        <p className="mt-3 text-sm text-lh-muted">
          Team attribution uses historical provider and Square matching
          evidence. Legacy payment links and older local refund evidence remain
          labeled in the underlying attribution model. Unattributed records
          require reconciliation before they are used for compensation
          decisions.
        </p>
      </details>
    </section>
  );
}

function SnapshotValue({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function Method({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold">{label}</dt>
      <dd className="mt-1 text-lh-muted">{value}</dd>
    </div>
  );
}

function MoneyCell({
  emphasized = false,
  value,
}: {
  emphasized?: boolean;
  value: number;
}) {
  return (
    <td
      className={`${cellClass} text-right ${emphasized ? "font-semibold" : ""}`}
    >
      {money(value)}
    </td>
  );
}

function money(cents: number) {
  return new Intl.NumberFormat("en-CA", {
    currency: "CAD",
    style: "currency",
  }).format(cents / 100);
}

function formatRange(from: string, to: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" });
  return `${formatter.format(new Date(`${from}T12:00:00Z`))} to ${formatter.format(new Date(`${to}T12:00:00Z`))}`;
}

function timezoneLabel(value: string) {
  return value === "America/Toronto"
    ? "Toronto time"
    : "the business time zone";
}

function firstString(value: string | string[] | undefined) {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;
}

function normalizeTab(value: string | undefined): ReportTab {
  return value === "appointments" ||
    value === "team-sales" ||
    value === "methodology"
    ? value
    : "overview";
}

function reportHref(
  tab: ReportTab,
  range: { from: string; to: string },
): string {
  const params = new URLSearchParams({
    from: range.from,
    tab,
    to: range.to,
  });
  return `/admin/analytics?${params.toString()}`;
}

async function getReportOrDefault(from?: string, to?: string) {
  try {
    return {
      analytics: await getAdminAnalytics({ from, to }),
      error: null,
    };
  } catch (error) {
    console.error("[admin-reports] Report range could not be loaded", {
      error: error instanceof Error ? error.name : "Unknown error",
    });
    return {
      analytics: await getAdminAnalytics(),
      error: "Use a valid date range of no more than 366 days.",
    };
  }
}

async function getAttributionOrDefault(from: string, to: string) {
  try {
    return {
      error: null,
      report: await getEmployeeAttributionAnalytics({ from, to }),
    };
  } catch (error) {
    console.error("[admin-reports] Team payment report could not be loaded", {
      error: error instanceof Error ? error.name : "Unknown error",
    });
    return {
      error:
        "Team payment evidence could not be loaded for this range. The default period is shown.",
      report: await getEmployeeAttributionAnalytics(),
    };
  }
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <label className="block text-sm font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "min-h-11 rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const buttonClass =
  "inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold hover:bg-lh-neutral-2";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3";

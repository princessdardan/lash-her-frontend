import Link from "next/link";

import { AdminCard } from "@/components/admin/admin-card";
import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { getAdminOverview } from "@/lib/admin/admin-overview";
import { requirePermission } from "@/lib/admin/auth";
import { canAdmin, type AdminPermissionAction } from "@/lib/admin/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminOverviewPage() {
  const [actor, overview] = await Promise.all([
    requirePermission("admin:view"),
    getAdminOverview(),
  ]);
  const quickLinks = [
    {
      action: "bookings:view" as const,
      href: "/admin/appointments",
      label: "View appointments",
    },
    {
      action: "schedules:manage" as const,
      href: "/admin/schedules?tab=exceptions#time-off",
      label: "Add time off",
    },
    {
      action: "offerings:manage" as const,
      href: "/admin/offerings",
      label: "Edit services",
    },
    {
      action:
        overview.scope === "business"
          ? ("calendar-connections:manage" as const)
          : ("calendar-connections:self-manage" as const),
      href:
        overview.scope === "business"
          ? "/admin/calendar-connections"
          : "/admin/my-calendar",
      label: "Connect a calendar",
    },
  ].filter((item) => hasPermission(actor, item.action));

  return (
    <div className="space-y-10">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Daily work
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] text-lh-shadow sm:text-5xl lg:text-6xl">
          Today
        </h1>
        <p className="mt-3 max-w-2xl text-lh-muted">
          Appointments, follow-up, and booking health in one place.{" "}
          {overview.timezoneLabel}.
        </p>
      </header>

      <AttentionSection overview={overview} />

      {overview.atAGlance ? (
        <section aria-labelledby="at-a-glance">
          <h2
            className="font-heading text-3xl uppercase tracking-[0.08em]"
            id="at-a-glance"
          >
            At a glance
          </h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <AdminCard
              href="/admin/appointments?view=today"
              label="Appointments today"
              value={overview.atAGlance.appointmentsToday}
            />
            <AdminCard
              href={`/admin/appointments?view=upcoming&from=${overview.atAGlance.nextSevenDaysPeriod.from}&to=${overview.atAGlance.nextSevenDaysPeriod.to}`}
              label="Next seven days"
              value={overview.atAGlance.appointmentsNextSevenDays}
            />
            <AdminCard
              href="/admin/appointments?view=needs-attention"
              label="Needs follow-up"
              value={overview.atAGlance.needsFollowUp}
            />
          </div>
        </section>
      ) : null}

      <TodaySchedule
        businessScope={overview.scope === "business"}
        schedule={overview.todaySchedule}
      />

      {overview.businessSnapshot ? (
        <BusinessSnapshot snapshot={overview.businessSnapshot} />
      ) : null}

      {overview.bookingHealth ? (
        <BookingHealth health={overview.bookingHealth} />
      ) : null}

      {quickLinks.length > 0 ? (
        <section aria-labelledby="quick-links">
          <h2
            className="font-heading text-3xl uppercase tracking-[0.08em]"
            id="quick-links"
          >
            Quick links
          </h2>
          <div className="mt-4 flex flex-wrap gap-3">
            {quickLinks.map((link) => (
              <Link
                className="inline-flex min-h-11 items-center rounded-full border border-lh-line bg-white px-5 py-2 text-sm font-semibold text-lh-shadow transition hover:border-lh-primary hover:bg-lh-neutral-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2"
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AttentionSection({
  overview,
}: {
  overview: Awaited<ReturnType<typeof getAdminOverview>>;
}) {
  const { complete, items } = overview.needsAttention;

  return (
    <section aria-labelledby="needs-attention">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className="font-heading text-3xl uppercase tracking-[0.08em]"
          id="needs-attention"
        >
          Needs attention
        </h2>
        {items.length > 0 ? (
          <StatusPill tone="attention">
            {items.length} {items.length === 1 ? "area" : "areas"}
          </StatusPill>
        ) : null}
      </div>

      {items.length > 0 ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <Link
              className="group flex min-h-24 items-start justify-between gap-4 rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-5 transition hover:border-lh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2"
              href={item.href}
              key={item.kind}
            >
              <span>
                <span className="block font-semibold text-lh-shadow">
                  {item.title}
                </span>
                <span className="mt-1 block text-sm text-lh-muted">
                  {item.description}
                </span>
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-lh-accent">
                {item.count}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-lh-primary-soft bg-lh-primary-soft p-4 text-sm text-lh-primary">
          Nothing needs attention.
        </div>
      )}

      {!complete ? (
        <p className="mt-3 rounded-2xl border border-lh-line bg-white p-4 text-sm text-lh-muted">
          Some checks could not be loaded:{" "}
          {overview.unavailableSections
            .map((section) => section.label)
            .join(", ")}
          . The available results are shown above.
        </p>
      ) : null}
    </section>
  );
}

function TodaySchedule({
  businessScope,
  schedule,
}: {
  businessScope: boolean;
  schedule: Awaited<ReturnType<typeof getAdminOverview>>["todaySchedule"];
}) {
  return (
    <section aria-labelledby="today-schedule">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          className="font-heading text-3xl uppercase tracking-[0.08em]"
          id="today-schedule"
        >
          Today&apos;s schedule
        </h2>
        <Link
          className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-lh-primary underline-offset-4 hover:underline"
          href="/admin/appointments?view=today"
        >
          View all appointments
        </Link>
      </div>

      {schedule === null ? (
        <p className="mt-4 rounded-2xl border border-lh-line bg-white p-5 text-lh-muted">
          Today&apos;s schedule is temporarily unavailable.
        </p>
      ) : schedule.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-lh-line bg-white p-5 text-lh-muted">
          No remaining appointments today.
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-3 md:hidden">
            {schedule.map((appointment) => (
              <Link
                className="block min-h-24 rounded-2xl border border-lh-line bg-white p-5 shadow-sm transition hover:border-lh-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2"
                href={appointment.href}
                key={appointment.id}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-semibold text-lh-shadow">
                      {appointment.timeLabel} · {appointment.customerName}
                    </p>
                    <p className="mt-1 text-sm text-lh-muted">
                      {appointment.serviceName}
                      {businessScope && appointment.providerName
                        ? ` · ${appointment.providerName}`
                        : ""}
                    </p>
                  </div>
                  <StatusPill tone={appointment.status.tone}>
                    {appointment.status.label}
                  </StatusPill>
                </div>
              </Link>
            ))}
          </div>
          <AdminTable
            caption="Remaining appointments today"
            className="mt-4 hidden md:block"
          >
            <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
              <tr>
                <th className="px-4 py-3" scope="col">
                  Time
                </th>
                <th className="px-4 py-3" scope="col">
                  Customer
                </th>
                <th className="px-4 py-3" scope="col">
                  Service
                </th>
                {businessScope ? (
                  <th className="px-4 py-3" scope="col">
                    Provider
                  </th>
                ) : null}
                <th className="px-4 py-3" scope="col">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-lh-line">
              {schedule.map((appointment) => (
                <tr key={appointment.id}>
                  <td className="px-4 py-4 font-semibold">
                    {appointment.timeLabel}
                  </td>
                  <th className="px-4 py-4 text-left font-semibold" scope="row">
                    <Link
                      className="text-lh-primary underline-offset-4 hover:underline"
                      href={appointment.href}
                    >
                      {appointment.customerName}
                    </Link>
                  </th>
                  <td className="px-4 py-4">{appointment.serviceName}</td>
                  {businessScope ? (
                    <td className="px-4 py-4">{appointment.providerName}</td>
                  ) : null}
                  <td className="px-4 py-4">
                    <StatusPill tone={appointment.status.tone}>
                      {appointment.status.label}
                    </StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        </>
      )}
    </section>
  );
}

function BusinessSnapshot({
  snapshot,
}: {
  snapshot: NonNullable<
    Awaited<ReturnType<typeof getAdminOverview>>["businessSnapshot"]
  >;
}) {
  const periodQuery = new URLSearchParams({
    from: snapshot.period.from,
    to: snapshot.period.to,
  }).toString();

  return (
    <section aria-labelledby="business-snapshot">
      <h2
        className="font-heading text-3xl uppercase tracking-[0.08em]"
        id="business-snapshot"
      >
        Business snapshot
      </h2>
      <p className="mt-2 text-sm text-lh-muted">
        Last 30 days,{" "}
        {formatDateRange(snapshot.period.from, snapshot.period.to)}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AdminCard
          href={`/admin/appointments?view=all&status=completed&basis=completed&${periodQuery}`}
          label="Completed appointments"
          value={formatMetric(snapshot.completedAppointments)}
        />
        <AdminCard
          href={`/admin/payments?${periodQuery}`}
          label="Payments received"
          value={formatMoney(snapshot.paymentsReceivedCents)}
        >
          Gross checkout payments recorded by paid date.
        </AdminCard>
        <AdminCard
          href={`/admin/marketing?tab=contacts&${periodQuery}`}
          label="New marketing opt-ins"
          value={formatMetric(snapshot.newMarketingOptIns)}
        />
        <AdminCard
          href={`/admin/payments?view=refunds&${periodQuery}`}
          label="Square refunds issued"
          value={formatMoney(snapshot.refundsIssuedCents)}
        >
          Reported separately from payments received.
        </AdminCard>
      </div>
    </section>
  );
}

function BookingHealth({
  health,
}: {
  health: NonNullable<
    Awaited<ReturnType<typeof getAdminOverview>>["bookingHealth"]
  >;
}) {
  const hasIssues =
    (health.calendarConnectionsNeedingAttention ?? 0) > 0 ||
    (health.setupBlockers ?? 0) > 0;

  if (!hasIssues) {
    return null;
  }

  return (
    <section
      aria-labelledby="booking-health"
      className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6"
    >
      <h2
        className="font-heading text-3xl uppercase tracking-[0.08em]"
        id="booking-health"
      >
        Booking health
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {(health.setupBlockers ?? 0) > 0 ? (
          <HealthIssue
            count={health.setupBlockers}
            href="/admin/setup"
            label="Services blocked from online booking"
          />
        ) : null}
        {(health.calendarConnectionsNeedingAttention ?? 0) > 0 ? (
          <HealthIssue
            count={health.calendarConnectionsNeedingAttention}
            href="/admin/calendar-connections"
            label="Calendar connections needing attention"
          />
        ) : null}
      </div>
      {health.providersReadyForOnlineBooking !== null &&
      health.activeBookableServices !== null ? (
        <p className="mt-4 text-sm text-lh-muted">
          {health.providersReadyForOnlineBooking} providers and{" "}
          {health.activeBookableServices} services are ready for online booking.
        </p>
      ) : null}
    </section>
  );
}

function HealthIssue({
  count,
  href,
  label,
}: {
  count: number | null;
  href: string;
  label: string;
}) {
  return (
    <Link
      className="flex min-h-20 items-center justify-between gap-4 rounded-xl border border-lh-accent-soft bg-lh-light-soft p-4 transition hover:border-lh-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
      href={href}
    >
      <span className="font-semibold text-lh-shadow">{label}</span>
      <span className="rounded-full bg-white px-3 py-1 font-semibold text-lh-accent">
        {count}
      </span>
    </Link>
  );
}

function hasPermission(
  actor: Awaited<ReturnType<typeof requirePermission>>,
  action: AdminPermissionAction,
): boolean {
  return canAdmin({
    action,
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
}

function formatMetric(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString("en-CA");
}

function formatMoney(value: number | null): string {
  if (value === null) return "Unavailable";
  return new Intl.NumberFormat("en-CA", {
    currency: "CAD",
    style: "currency",
  }).format(value / 100);
}

function formatDateRange(from: string, to: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  });
  return `${formatter.format(new Date(`${from}T00:00:00Z`))}–${formatter.format(
    new Date(`${to}T00:00:00Z`),
  )}`;
}

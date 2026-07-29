import Link from "next/link";

import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import { listAdminAppointments } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminAppointmentsPage() {
  await requireAdminPagePermission("bookings:view");
  const rows = await listAdminAppointments();

  return (
    <div className="space-y-6">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Operations
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
          Appointments
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Confirmed appointments and their payment and calendar synchronization
          state. Contractor accounts see assigned resources only.
        </p>
      </header>
      <AdminTable caption="Appointments">
        <thead className={theadClass}>
          <tr>
            <th className={cellClass}>Reference</th>
            <th className={cellClass}>Customer</th>
            <th className={cellClass}>Provider</th>
            <th className={cellClass}>When</th>
            <th className={cellClass}>Status</th>
            <th className={cellClass}>Payment</th>
            <th className={cellClass}>Calendar</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={cellClass}>
                <Link
                  className="font-semibold text-lh-primary underline-offset-4 hover:underline"
                  href={`/admin/appointments/${row.id}`}
                >
                  {row.publicReference}
                </Link>
              </td>
              <td className={cellClass}>{row.customerName}</td>
              <td className={cellClass}>{row.providerDisplayName}</td>
              <td className={cellClass}>
                {formatDate(row.selectedStart, row.timezone)}
                <p className="text-xs text-lh-muted">
                  to {formatTime(row.selectedEnd, row.timezone)}
                </p>
              </td>
              <td className={cellClass}>
                <StatusPill
                  tone={
                    row.status === "confirmed"
                      ? "success"
                      : row.status === "manual_followup"
                        ? "attention"
                        : "neutral"
                  }
                >
                  {row.status}
                </StatusPill>
              </td>
              <td className={cellClass}>{row.paymentStatus}</td>
              <td className={cellClass}>{row.calendarSyncStatus}</td>
            </tr>
          ))}
        </tbody>
      </AdminTable>
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
          No durable appointments have been created yet. Legacy holds remain
          visible only through existing operational recovery paths.
        </p>
      ) : null}
    </div>
  );
}

function formatDate(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}
function formatTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeStyle: "short",
    timeZone,
  }).format(value);
}
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";

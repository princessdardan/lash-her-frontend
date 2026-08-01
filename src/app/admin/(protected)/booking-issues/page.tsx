import Link from "next/link";

import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminBookingIssues,
  type AdminBookingIssueRow,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AdminBookingIssuesPageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
  }>;
}

export default async function AdminBookingIssuesPage({
  searchParams,
}: AdminBookingIssuesPageProps) {
  await requireAdminPagePermission("payments:view");
  const params = await searchParams;
  const result = await listAdminBookingIssues({
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
  });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <>
            <p>
              Booking, payment, or refund records whose appointment, calendar,
              or local review state still needs verification.
            </p>
            <p className="mt-2 text-sm">
              This is a read-only evidence queue. Refund, rebooking, and
              calendar-repair actions are not available here.
            </p>
          </>
        }
        eyebrow="Daily work"
        title="Booking issues"
      />

      <AdminWorkspaceSearch
        action="/admin/booking-issues"
        label="Search booking issues"
        placeholder="Search reference, customer, service, or provider"
        search={result.search}
      />

      <p className="text-sm text-lh-muted">
        Requested times are shown in {result.timezoneLabel}.
      </p>

      <AdminWorkspaceResults
        emptyMessage={
          result.search
            ? "No unresolved booking records match this search."
            : "No booking or payment records currently meet the review criteria."
        }
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        path="/admin/booking-issues"
        rows={
          <>
            <div className="space-y-3 md:hidden">
              {result.rows.map((issue) => (
                <BookingIssueCard
                  issue={issue}
                  key={issue.id}
                  timezone={result.timezone}
                />
              ))}
            </div>
            <BookingIssueTable
              issues={result.rows}
              timezone={result.timezone}
            />
          </>
        }
        search={result.search}
        total={result.total}
      />
    </div>
  );
}

function BookingIssueCard({
  issue,
  timezone,
}: {
  issue: AdminBookingIssueRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{issue.publicReference}</p>
          <p className="mt-1 text-sm text-lh-muted">{issue.serviceTitle}</p>
        </div>
        <StatusPill tone={issue.issue.tone}>{issue.issue.label}</StatusPill>
      </div>

      {issue.issue.description ? (
        <p className="mt-3 text-sm text-lh-muted">{issue.issue.description}</p>
      ) : null}

      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className={termClass}>Customer</dt>
          <dd className="mt-1 font-semibold">{issue.customerName}</dd>
          {issue.customerEmail ? (
            <dd className="break-all text-lh-muted">{issue.customerEmail}</dd>
          ) : null}
          {issue.customerPhone ? (
            <dd className="text-lh-muted">{issue.customerPhone}</dd>
          ) : null}
        </div>
        <div>
          <dt className={termClass}>Requested appointment</dt>
          <dd className="mt-1">
            {formatDateTime(issue.selectedStart, timezone)} to{" "}
            {formatTime(issue.selectedEnd, timezone)}
          </dd>
          <dd className="text-lh-muted">{issue.providerName}</dd>
        </div>
        <div>
          <dt className={termClass}>{issue.amountLabel}</dt>
          <dd className="mt-1">
            {issue.amountCents === null
              ? "Amount unavailable"
              : formatMoney(issue.amountCents, issue.currency)}
          </dd>
          <dd className="text-lh-muted">
            {issue.paymentRecordedAt
              ? `Recorded ${formatDateTime(issue.paymentRecordedAt, timezone)}`
              : "Payment date unavailable"}
          </dd>
          <dd className="mt-1 text-lh-muted">
            {issue.paymentEvidenceDescription}
          </dd>
        </div>
      </dl>

      <BookingIssueEvidence issue={issue} />
    </article>
  );
}

function BookingIssueTable({
  issues,
  timezone,
}: {
  issues: AdminBookingIssueRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Booking issue results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[1040px] w-full text-left text-sm">
        <caption className="sr-only">
          Paid booking records requiring verification
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th
              className="sticky left-0 z-10 bg-lh-neutral-2 px-4 py-3"
              scope="col"
            >
              Booking
            </th>
            <th className={cellClass} scope="col">
              Customer
            </th>
            <th className={cellClass} scope="col">
              Requested time
            </th>
            <th className={cellClass} scope="col">
              Payment review
            </th>
            <th className={cellClass} scope="col">
              Review state
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {issues.map((issue) => (
            <tr key={issue.id}>
              <th
                className="sticky left-0 bg-white px-4 py-4 align-top font-semibold"
                scope="row"
              >
                {issue.publicReference}
                <p className="mt-1 max-w-56 text-xs font-normal text-lh-muted">
                  {issue.serviceTitle}
                </p>
                {issue.appointmentId ? (
                  <Link
                    className="mt-3 inline-flex min-h-11 items-center text-xs font-semibold text-lh-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
                    href={`/admin/appointments/${issue.appointmentId}`}
                  >
                    View appointment
                  </Link>
                ) : null}
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{issue.customerName}</p>
                {issue.customerEmail ? (
                  <p className="max-w-56 break-all text-xs text-lh-muted">
                    {issue.customerEmail}
                  </p>
                ) : null}
                {issue.customerPhone ? (
                  <p className="text-xs text-lh-muted">{issue.customerPhone}</p>
                ) : null}
              </td>
              <td className={cellClass}>
                <p className="whitespace-nowrap">
                  {formatDateTime(issue.selectedStart, timezone)}
                </p>
                <p className="mt-1 text-xs text-lh-muted">
                  to {formatTime(issue.selectedEnd, timezone)}
                </p>
                <p className="mt-1 max-w-56 text-xs text-lh-muted">
                  {issue.providerName}
                </p>
              </td>
              <td className={cellClass}>
                <p className="text-xs uppercase tracking-[0.12em] text-lh-muted">
                  {issue.amountLabel}
                </p>
                <p className="font-semibold">
                  {issue.amountCents === null
                    ? "Amount unavailable"
                    : formatMoney(issue.amountCents, issue.currency)}
                </p>
                <p className="mt-1 max-w-56 text-xs text-lh-muted">
                  {issue.paymentRecordedAt
                    ? `Recorded ${formatDateTime(issue.paymentRecordedAt, timezone)}`
                    : "Payment date unavailable"}
                </p>
                <p className="mt-1 max-w-64 text-xs text-lh-muted">
                  {issue.paymentEvidenceDescription}
                </p>
                {issue.hasCompletedRefundEvent ? (
                  <p className="mt-2 max-w-64 text-xs text-lh-muted">
                    A completed Square refund event is recorded.
                  </p>
                ) : null}
              </td>
              <td className={cellClass}>
                <StatusPill tone={issue.issue.tone}>
                  {issue.issue.label}
                </StatusPill>
                {issue.issue.description ? (
                  <p className="mt-2 max-w-72 text-xs text-lh-muted">
                    {issue.issue.description}
                  </p>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BookingIssueEvidence({ issue }: { issue: AdminBookingIssueRow }) {
  if (!issue.appointmentId && !issue.hasCompletedRefundEvent) {
    return null;
  }

  return (
    <div className="mt-4 border-t border-lh-line pt-4 text-sm">
      {issue.appointmentId ? (
        <Link
          className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
          href={`/admin/appointments/${issue.appointmentId}`}
        >
          View appointment
          {issue.appointmentReference ? ` ${issue.appointmentReference}` : ""}
        </Link>
      ) : null}
      {issue.hasCompletedRefundEvent ? (
        <p className="mt-2 text-lh-muted">
          A completed Square refund event is recorded. The booking remains in
          this queue because its local review state is unresolved.
        </p>
      ) : null}
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : "CAD";

  return new Intl.NumberFormat("en-CA", {
    currency: safeCurrency,
    style: "currency",
  }).format(cents / 100);
}

function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}

function formatTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeStyle: "short",
    timeZone,
  }).format(value);
}

function firstString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value[0]
      : undefined;
}

function parsePositivePage(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const page = Number(value);
  return Number.isSafeInteger(page) ? page : undefined;
}

const termClass = "text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-4 align-top";

import Link from "next/link";

import { AdminCard } from "@/components/admin/admin-card";
import { AdminTabLink } from "@/components/admin/admin-tab-link";
import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  AdminWorkspaceRangeError,
  listAdminPayments,
  listAdminRefunds,
  type AdminPaymentRow,
  type AdminPaymentsListInput,
  type AdminRefundRow,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PaymentView = "payments" | "refunds";

interface AdminPaymentsPageProps {
  searchParams: Promise<{
    from?: string | string[];
    page?: string | string[];
    q?: string | string[];
    to?: string | string[];
    view?: string | string[];
  }>;
}

export default async function AdminPaymentsPage({
  searchParams,
}: AdminPaymentsPageProps) {
  await requireAdminPagePermission("payments:view");
  const params = await searchParams;
  const view = normalizeView(firstString(params.view));
  const requestedFrom = firstString(params.from);
  const requestedTo = firstString(params.to);
  const loadResult = await loadPaymentWorkspace(view, {
    from: requestedFrom,
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
    to: requestedTo,
  });
  const result = loadResult.data;

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <>
            <p>
              Checkout payments received across product, training, and
              appointment purchases, plus completed Square refund events.
            </p>
            <p className="mt-2 text-sm">
              Payments received are gross checkout amounts, including recorded
              Square tips, before refunds. The Refunds view reports completed
              Square refund events separately.
            </p>
          </>
        }
        eyebrow="Daily work"
        title="Payments"
      />

      <nav aria-label="Payment views" className="flex flex-wrap gap-2">
        {(["payments", "refunds"] as const).map((candidate) => (
          <AdminTabLink
            active={view === candidate}
            className="px-5 py-2.5"
            href={paymentViewHref(
              candidate,
              result.from,
              result.to,
              result.search,
            )}
            key={candidate}
          >
            {candidate === "payments" ? "Payments received" : "Refunds"}
          </AdminTabLink>
        ))}
      </nav>

      <PaymentFilters
        error={loadResult.error}
        from={requestedFrom ?? result.from}
        search={result.search}
        to={requestedTo ?? result.to}
        view={view}
      />

      <p className="text-sm text-lh-muted">
        Date boundaries and times use {result.timezoneLabel}.
      </p>

      {view === "payments" && loadResult.view === "payments" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <AdminCard
              label="Payments received"
              value={formatMoney(loadResult.data.totalReceivedCents, "CAD")}
            >
              Gross checkout amount before refunds
            </AdminCard>
            <AdminCard label="Checkout records" value={result.total}>
              Paid or subsequently refunded records in this period
            </AdminCard>
            <AdminCard
              label="Tips included"
              value={formatMoney(loadResult.data.totalTipCents, "CAD")}
            >
              Recorded Square tips included in payments received
            </AdminCard>
          </div>

          <AdminWorkspaceResults
            emptyMessage={
              result.search
                ? "No payment records match this search and date range."
                : "No checkout payments were received in this date range."
            }
            page={result.page}
            pageCount={result.pageCount}
            pageSize={result.pageSize}
            path="/admin/payments"
            preservedParams={{
              from: result.from,
              to: result.to,
            }}
            rows={
              <>
                <div className="space-y-3 md:hidden">
                  {loadResult.data.rows.map((payment) => (
                    <PaymentCard
                      key={payment.id}
                      payment={payment}
                      timezone={result.timezone}
                    />
                  ))}
                </div>
                <PaymentTable
                  payments={loadResult.data.rows}
                  timezone={result.timezone}
                />
              </>
            }
            search={result.search}
            total={result.total}
          />
        </>
      ) : null}

      {view === "refunds" && loadResult.view === "refunds" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminCard
              label="Square refunds issued"
              value={formatMoney(loadResult.data.totalRefundedCents, "CAD")}
            >
              Deduplicated completed Square refund events
            </AdminCard>
            <AdminCard label="Refund events" value={result.total}>
              Completed events in this date range
            </AdminCard>
          </div>

          <AdminWorkspaceResults
            emptyMessage={
              result.search
                ? "No completed Square refunds match this search and date range."
                : "No completed Square refund events were recorded in this date range."
            }
            page={result.page}
            pageCount={result.pageCount}
            pageSize={result.pageSize}
            path="/admin/payments"
            preservedParams={{
              from: result.from,
              to: result.to,
              view: "refunds",
            }}
            rows={
              <>
                <div className="space-y-3 md:hidden">
                  {loadResult.data.rows.map((refund) => (
                    <RefundCard
                      key={refund.id}
                      refund={refund}
                      timezone={result.timezone}
                    />
                  ))}
                </div>
                <RefundTable
                  refunds={loadResult.data.rows}
                  timezone={result.timezone}
                />
              </>
            }
            search={result.search}
            total={result.total}
          />
        </>
      ) : null}
    </div>
  );
}

function PaymentFilters({
  error,
  from,
  search,
  to,
  view,
}: {
  error: string | null;
  from: string;
  search: string;
  to: string;
  view: PaymentView;
}) {
  return (
    <form
      action="/admin/payments"
      className="rounded-2xl border border-lh-line bg-white p-4"
      method="GET"
      role="search"
    >
      {view === "refunds" ? (
        <input name="view" type="hidden" value="refunds" />
      ) : null}
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_auto_auto_auto] md:items-end">
        <label className="text-sm font-semibold">
          Search
          <input
            className={inputClass}
            defaultValue={search}
            name="q"
            placeholder="Reference, customer, email, or type"
            type="search"
          />
        </label>
        <label className="text-sm font-semibold">
          From
          <input
            aria-describedby={error ? "payment-range-error" : undefined}
            aria-invalid={error ? true : undefined}
            className={inputClass}
            defaultValue={from}
            name="from"
            type="date"
          />
        </label>
        <label className="text-sm font-semibold">
          To
          <input
            aria-describedby={error ? "payment-range-error" : undefined}
            aria-invalid={error ? true : undefined}
            className={inputClass}
            defaultValue={to}
            name="to"
            type="date"
          />
        </label>
        <div className="flex gap-2">
          <button
            className="min-h-11 rounded-full bg-lh-primary px-5 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary focus-visible:ring-offset-2"
            type="submit"
          >
            Apply
          </button>
          <Link
            className="inline-flex min-h-11 items-center rounded-full border border-lh-line px-5 py-2.5 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary"
            href={
              view === "refunds"
                ? "/admin/payments?view=refunds"
                : "/admin/payments"
            }
          >
            Reset
          </Link>
        </div>
      </div>
      {error ? (
        <p
          className="mt-3 text-sm font-semibold text-lh-accent"
          id="payment-range-error"
          role="alert"
        >
          {error} Showing the default last 30 days.
        </p>
      ) : null}
    </form>
  );
}

function PaymentCard({
  payment,
  timezone,
}: {
  payment: AdminPaymentRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{payment.reference}</p>
          <p className="mt-1 text-sm text-lh-muted">{payment.purpose.label}</p>
        </div>
        <StatusPill tone={payment.status.tone}>
          {payment.status.label}
        </StatusPill>
      </div>
      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className={termClass}>Customer</dt>
          <dd className="mt-1 font-semibold">{payment.customerName}</dd>
          {payment.customerEmail ? (
            <dd className="break-all text-lh-muted">{payment.customerEmail}</dd>
          ) : null}
        </div>
        <div>
          <dt className={termClass}>Received</dt>
          <dd className="mt-1 font-semibold">
            {formatMoney(payment.receivedAmountCents, payment.currency)}
          </dd>
          {payment.tipAmountCents > 0 ? (
            <dd className="text-lh-muted">
              Includes {formatMoney(payment.tipAmountCents, payment.currency)}{" "}
              tip
            </dd>
          ) : null}
          <dd className="text-lh-muted">
            {formatDateTime(payment.paidAt, timezone)} via{" "}
            {payment.paymentProviderLabel}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function PaymentTable({
  payments,
  timezone,
}: {
  payments: AdminPaymentRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Payment results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[940px] w-full text-left text-sm">
        <caption className="sr-only">
          Checkout payments received before refunds
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th className={cellClass} scope="col">
              Reference
            </th>
            <th className={cellClass} scope="col">
              Customer
            </th>
            <th className={cellClass} scope="col">
              Type
            </th>
            <th className={cellClass} scope="col">
              Received
            </th>
            <th className={cellClass} scope="col">
              Current state
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {payments.map((payment) => (
            <tr key={payment.id}>
              <th className={cellClass} scope="row">
                <p className="font-semibold">{payment.reference}</p>
                <p className="mt-1 whitespace-nowrap text-xs font-normal text-lh-muted">
                  {formatDateTime(payment.paidAt, timezone)}
                </p>
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{payment.customerName}</p>
                {payment.customerEmail ? (
                  <p className="max-w-64 break-all text-xs text-lh-muted">
                    {payment.customerEmail}
                  </p>
                ) : null}
              </td>
              <td className={cellClass}>{payment.purpose.label}</td>
              <td className={cellClass}>
                <p className="font-semibold">
                  {formatMoney(payment.receivedAmountCents, payment.currency)}
                </p>
                {payment.tipAmountCents > 0 ? (
                  <p className="mt-1 text-xs text-lh-muted">
                    {formatMoney(payment.subtotalAmountCents, payment.currency)}{" "}
                    checkout +{" "}
                    {formatMoney(payment.tipAmountCents, payment.currency)} tip
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-lh-muted">
                  {payment.paymentProviderLabel}
                </p>
              </td>
              <td className={cellClass}>
                <StatusPill tone={payment.status.tone}>
                  {payment.status.label}
                </StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RefundCard({
  refund,
  timezone,
}: {
  refund: AdminRefundRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{refund.reference}</p>
          <p className="mt-1 text-sm text-lh-muted">{refund.sourceLabel}</p>
        </div>
        <StatusPill tone="success">Refund completed</StatusPill>
      </div>
      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className={termClass}>Customer</dt>
          <dd className="mt-1 font-semibold">{refund.customerName}</dd>
          {refund.customerEmail ? (
            <dd className="break-all text-lh-muted">{refund.customerEmail}</dd>
          ) : null}
        </div>
        <div>
          <dt className={termClass}>Refunded</dt>
          <dd className="mt-1 font-semibold">
            {formatMoney(refund.amountCents, refund.currency)}
          </dd>
          <dd className="text-lh-muted">
            {formatDateTime(refund.occurredAt, timezone)}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function RefundTable({
  refunds,
  timezone,
}: {
  refunds: AdminRefundRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Refund results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[760px] w-full text-left text-sm">
        <caption className="sr-only">
          Deduplicated completed Square refund events
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th className={cellClass} scope="col">
              Reference
            </th>
            <th className={cellClass} scope="col">
              Customer
            </th>
            <th className={cellClass} scope="col">
              Source
            </th>
            <th className={cellClass} scope="col">
              Refunded
            </th>
            <th className={cellClass} scope="col">
              Result
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {refunds.map((refund) => (
            <tr key={refund.id}>
              <th className={cellClass} scope="row">
                <p className="font-semibold">{refund.reference}</p>
                <p className="mt-1 whitespace-nowrap text-xs font-normal text-lh-muted">
                  {formatDateTime(refund.occurredAt, timezone)}
                </p>
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{refund.customerName}</p>
                {refund.customerEmail ? (
                  <p className="max-w-64 break-all text-xs text-lh-muted">
                    {refund.customerEmail}
                  </p>
                ) : null}
              </td>
              <td className={cellClass}>{refund.sourceLabel}</td>
              <td className={cellClass}>
                {formatMoney(refund.amountCents, refund.currency)}
              </td>
              <td className={cellClass}>
                <StatusPill tone="success">Refund completed</StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function loadPaymentWorkspace(
  view: PaymentView,
  input: AdminPaymentsListInput,
) {
  try {
    if (view === "refunds") {
      return {
        data: await listAdminRefunds(input),
        error: null,
        view: "refunds" as const,
      };
    }

    return {
      data: await listAdminPayments(input),
      error: null,
      view: "payments" as const,
    };
  } catch (error) {
    if (!(error instanceof AdminWorkspaceRangeError)) {
      throw error;
    }

    const fallbackInput = {
      page: input.page,
      search: input.search,
    };
    if (view === "refunds") {
      return {
        data: await listAdminRefunds(fallbackInput),
        error: error.message,
        view: "refunds" as const,
      };
    }

    return {
      data: await listAdminPayments(fallbackInput),
      error: error.message,
      view: "payments" as const,
    };
  }
}

function paymentViewHref(
  view: PaymentView,
  from: string,
  to: string,
  search: string,
): string {
  const params = new URLSearchParams({ from, to });
  if (view === "refunds") {
    params.set("view", "refunds");
  }
  if (search) {
    params.set("q", search);
  }
  return `/admin/payments?${params.toString()}`;
}

function normalizeView(value: string | undefined): PaymentView {
  return value === "refunds" ? "refunds" : "payments";
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

const inputClass =
  "mt-1 min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary";
const termClass = "text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-4 align-top";

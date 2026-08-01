import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminTrainingOrders,
  type AdminTrainingOrderRow,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AdminTrainingPageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
  }>;
}

export default async function AdminTrainingPage({
  searchParams,
}: AdminTrainingPageProps) {
  await requireAdminPagePermission("payments:view");
  const params = await searchParams;
  const result = await listAdminTrainingOrders({
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
  });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <>
            <p>
              Training purchases, enrollment setup, scheduling-link state, and
              recorded notification delivery.
            </p>
            <p className="mt-2 text-sm">
              Google appointment time, instructor assignment, and attendance are
              not stored here. “Scheduling recorded” only reflects the
              enrollment record.
            </p>
          </>
        }
        eyebrow="Daily work"
        title="Training"
      />

      <AdminWorkspaceSearch
        action="/admin/training"
        label="Search training purchases"
        placeholder="Search purchase, student, email, or program"
        search={result.search}
      />

      <p className="text-sm text-lh-muted">
        Times shown in {result.timezoneLabel}.
      </p>

      <AdminWorkspaceResults
        emptyMessage={
          result.search
            ? "No training purchases match this search."
            : "No training checkout orders have been recorded."
        }
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        path="/admin/training"
        rows={
          <>
            <div className="space-y-3 md:hidden">
              {result.rows.map((order) => (
                <TrainingCard
                  key={order.id}
                  order={order}
                  timezone={result.timezone}
                />
              ))}
            </div>
            <TrainingTable orders={result.rows} timezone={result.timezone} />
          </>
        }
        search={result.search}
        total={result.total}
      />
    </div>
  );
}

function TrainingCard({
  order,
  timezone,
}: {
  order: AdminTrainingOrderRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{order.programTitle}</p>
          <p className="mt-1 text-xs text-lh-muted">{order.reference}</p>
        </div>
        <StatusPill tone={order.scheduling.tone}>
          {order.scheduling.label}
        </StatusPill>
      </div>

      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className={termClass}>Student</dt>
          <dd className="mt-1 font-semibold">{order.customerName}</dd>
          {order.customerEmail ? (
            <dd className="break-all text-lh-muted">{order.customerEmail}</dd>
          ) : null}
        </div>
        <div>
          <dt className={termClass}>Payment</dt>
          <dd className="mt-1">
            <StatusPill tone={order.paymentStatus.tone}>
              {order.paymentStatus.label}
            </StatusPill>
          </dd>
          <dd className="mt-2">
            {formatMoney(order.amountCents, order.currency)}
          </dd>
          <dd className="text-lh-muted">
            {order.paidAt
              ? `Received ${formatDateTime(order.paidAt, timezone)} via ${order.paymentProviderLabel}`
              : `Payment date not recorded · ${order.paymentProviderLabel}`}
          </dd>
        </div>
        <PresentationDetail
          label="Scheduling"
          presentation={order.scheduling}
        />
        {order.tokenExpiresAt ? (
          <div>
            <dt className={termClass}>Scheduling link expiry</dt>
            <dd className="mt-1">
              {formatDateTime(order.tokenExpiresAt, timezone)}
            </dd>
          </div>
        ) : null}
        <PresentationDetail
          label="Notifications"
          presentation={order.notification}
        />
      </dl>
    </article>
  );
}

function TrainingTable({
  orders,
  timezone,
}: {
  orders: AdminTrainingOrderRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Training purchase results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[1020px] w-full text-left text-sm">
        <caption className="sr-only">
          Training purchases, scheduling state, and notification delivery
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th
              className="sticky left-0 z-10 bg-lh-neutral-2 px-4 py-3"
              scope="col"
            >
              Purchase
            </th>
            <th className={cellClass} scope="col">
              Student
            </th>
            <th className={cellClass} scope="col">
              Payment
            </th>
            <th className={cellClass} scope="col">
              Scheduling
            </th>
            <th className={cellClass} scope="col">
              Notifications
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {orders.map((order) => (
            <tr key={order.id}>
              <th
                className="sticky left-0 bg-white px-4 py-4 align-top font-semibold"
                scope="row"
              >
                <span className="block max-w-64">{order.programTitle}</span>
                <span className="mt-1 block text-xs font-normal text-lh-muted">
                  {order.reference}
                </span>
                <span className="mt-1 block whitespace-nowrap text-xs font-normal text-lh-muted">
                  {formatDateTime(order.createdAt, timezone)}
                </span>
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{order.customerName}</p>
                {order.customerEmail ? (
                  <p className="max-w-56 break-all text-xs text-lh-muted">
                    {order.customerEmail}
                  </p>
                ) : null}
              </td>
              <td className={cellClass}>
                <StatusPill tone={order.paymentStatus.tone}>
                  {order.paymentStatus.label}
                </StatusPill>
                <p className="mt-2 font-semibold">
                  {formatMoney(order.amountCents, order.currency)}
                </p>
                <p className="mt-1 max-w-56 text-xs text-lh-muted">
                  {order.paidAt
                    ? `Received ${formatDateTime(order.paidAt, timezone)} via ${order.paymentProviderLabel}`
                    : `Payment date not recorded · ${order.paymentProviderLabel}`}
                </p>
              </td>
              <td className={cellClass}>
                <StatusPill tone={order.scheduling.tone}>
                  {order.scheduling.label}
                </StatusPill>
                {order.scheduling.description ? (
                  <p className="mt-2 max-w-64 text-xs text-lh-muted">
                    {order.scheduling.description}
                  </p>
                ) : null}
                {order.tokenExpiresAt ? (
                  <p className="mt-2 text-xs text-lh-muted">
                    Link expiry:{" "}
                    {formatDateTime(order.tokenExpiresAt, timezone)}
                  </p>
                ) : null}
              </td>
              <td className={cellClass}>
                <StatusPill tone={order.notification.tone}>
                  {order.notification.label}
                </StatusPill>
                {order.notification.description ? (
                  <p className="mt-2 max-w-64 text-xs text-lh-muted">
                    {order.notification.description}
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

function PresentationDetail({
  label,
  presentation,
}: {
  label: string;
  presentation: AdminTrainingOrderRow["scheduling"];
}) {
  return (
    <div>
      <dt className={termClass}>{label}</dt>
      <dd className="mt-1">
        <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>
      </dd>
      {presentation.description ? (
        <dd className="mt-1 text-lh-muted">{presentation.description}</dd>
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

import {
  AdminWorkspaceHeader,
  AdminWorkspaceResults,
  AdminWorkspaceSearch,
} from "@/components/admin/admin-workspace-list";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminProductOrders,
  type AdminProductOrderRow,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { OrderShippingControls } from "@/components/admin/order-shipping-controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AdminOrdersPageProps {
  searchParams: Promise<{
    page?: string | string[];
    q?: string | string[];
  }>;
}

export default async function AdminOrdersPage({
  searchParams,
}: AdminOrdersPageProps) {
  await requireAdminPagePermission("fulfillment:view");
  const params = await searchParams;
  const result = await listAdminProductOrders({
    page: parsePositivePage(firstString(params.page)),
    search: firstString(params.q),
  });

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <p>
            Product purchases, payment state, Chit Chats label purchase,
            tracking, and customer confirmation delivery.
          </p>
        }
        eyebrow="Daily work"
        title="Orders"
      />

      <AdminWorkspaceSearch
        action="/admin/orders"
        label="Search product orders"
        placeholder="Search order, customer, or email"
        search={result.search}
      />

      <p className="text-sm text-lh-muted">
        Times shown in {result.timezoneLabel}.
      </p>

      <AdminWorkspaceResults
        emptyMessage={
          result.search
            ? "No product orders match this search."
            : "No product checkout orders have been recorded."
        }
        page={result.page}
        pageCount={result.pageCount}
        pageSize={result.pageSize}
        path="/admin/orders"
        rows={
          <>
            <div className="space-y-3 md:hidden">
              {result.rows.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  timezone={result.timezone}
                />
              ))}
            </div>
            <OrderTable orders={result.rows} timezone={result.timezone} />
          </>
        }
        search={result.search}
        total={result.total}
      />
    </div>
  );
}

function OrderCard({
  order,
  timezone,
}: {
  order: AdminProductOrderRow;
  timezone: string;
}) {
  return (
    <article className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{order.reference}</p>
          <p className="mt-1 text-sm text-lh-muted">
            {formatDateTime(order.createdAt, timezone)}
          </p>
        </div>
        <StatusPill tone={order.status.tone}>{order.status.label}</StatusPill>
      </div>

      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Customer
          </dt>
          <dd className="mt-1 font-semibold">{order.customerName}</dd>
          {order.customerEmail ? (
            <dd className="break-all text-lh-muted">{order.customerEmail}</dd>
          ) : null}
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Payment
          </dt>
          <dd className="mt-1">
            {formatMoney(order.amountCents, order.currency)}
          </dd>
          <dd className="text-lh-muted">
            {order.paidAt
              ? `Received ${formatDateTime(order.paidAt, timezone)}`
              : "Payment date not recorded"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
            Confirmation
          </dt>
          <dd className="mt-1">
            <StatusPill tone={order.confirmation.tone}>
              {order.confirmation.label}
            </StatusPill>
          </dd>
          {order.confirmation.description ? (
            <dd className="mt-1 text-lh-muted">
              {order.confirmation.description}
            </dd>
          ) : null}
        </div>
      </dl>

      <OrderDetails order={order} />
      <OrderOperations order={order} timezone={timezone} />
      {order.shipment ? (
        <OrderShippingControls
          orderId={order.reference}
          shipmentId={order.shipment.id}
          stateVersion={order.shipment.stateVersion}
          status={order.shipment.status}
          defaultWeightGrams={order.shipment.packageWeightGrams}
          trackingNumber={order.shipment.trackingNumber}
          trackingUrl={order.shipment.trackingUrl}
        />
      ) : null}
    </article>
  );
}

function OrderTable({
  orders,
  timezone,
}: {
  orders: AdminProductOrderRow[];
  timezone: string;
}) {
  return (
    <div
      aria-label="Product order results"
      className="hidden overflow-x-auto rounded-2xl border border-lh-line bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary md:block"
      role="region"
      tabIndex={0}
    >
      <table className="min-w-[980px] w-full text-left text-sm">
        <caption className="sr-only">
          Product orders, payment state, and confirmation delivery
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted">
          <tr>
            <th
              className="sticky left-0 z-10 bg-lh-neutral-2 px-4 py-3"
              scope="col"
            >
              Order
            </th>
            <th className={cellClass} scope="col">
              Customer
            </th>
            <th className={cellClass} scope="col">
              Items
            </th>
            <th className={cellClass} scope="col">
              Payment
            </th>
            <th className={cellClass} scope="col">
              Confirmation
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
                {order.reference}
                <p className="mt-1 whitespace-nowrap text-xs font-normal text-lh-muted">
                  {formatDateTime(order.createdAt, timezone)}
                </p>
              </th>
              <td className={cellClass}>
                <p className="font-semibold">{order.customerName}</p>
                {order.customerEmail ? (
                  <p className="max-w-56 break-all text-xs text-lh-muted">
                    {order.customerEmail}
                  </p>
                ) : null}
                {order.shippingLines ? (
                  <details className="mt-2">
                    <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold text-lh-primary">
                      Shipping address
                    </summary>
                    <address className="not-italic text-xs text-lh-muted">
                      {order.shippingLines.map((line) => (
                        <span className="block" key={line}>
                          {line}
                        </span>
                      ))}
                    </address>
                  </details>
                ) : null}
              </td>
              <td className={cellClass}>
                <OrderLineItems order={order} />
              </td>
              <td className={cellClass}>
                <StatusPill tone={order.status.tone}>
                  {order.status.label}
                </StatusPill>
                <p className="mt-2 font-semibold">
                  {formatMoney(order.amountCents, order.currency)}
                </p>
                <p className="mt-1 text-xs text-lh-muted">
                  {order.paidAt
                    ? `Received ${formatDateTime(order.paidAt, timezone)}`
                    : "Payment date not recorded"}
                </p>
              </td>
              <td className={cellClass}>
                <StatusPill tone={order.confirmation.tone}>
                  {order.confirmation.label}
                </StatusPill>
                {order.confirmation.description ? (
                  <p className="mt-2 max-w-64 text-xs text-lh-muted">
                    {order.confirmation.description}
                  </p>
                ) : null}
                <OrderOperations order={order} timezone={timezone} />
                {order.shipment ? (
                  <OrderShippingControls
                    orderId={order.reference}
                    shipmentId={order.shipment.id}
                    stateVersion={order.shipment.stateVersion}
                    status={order.shipment.status}
                    defaultWeightGrams={order.shipment.packageWeightGrams}
                    trackingNumber={order.shipment.trackingNumber}
                    trackingUrl={order.shipment.trackingUrl}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderOperations({
  order,
  timezone,
}: {
  order: AdminProductOrderRow;
  timezone: string;
}) {
  const operations = order.operations;
  const items = [
    `Risk: ${operations.fraudClassification}${operations.fraudRiskReasons.length ? ` (${operations.fraudRiskReasons.join(", ")})` : ""}`,
    `Open cases: ${operations.openCaseCount}`,
    `Refund: ${operations.latestRefundStatus ?? "none"}`,
    `Customer decision: ${operations.customerDecisionStatus ?? "none"}`,
    `Address change: ${operations.addressChangeStatus ?? "none"}${operations.addressChangeReconciliationState ? ` / ${operations.addressChangeReconciliationState}` : ""}`,
    `Shipment history: ${operations.shipmentHistoryCount}`,
  ];
  if (order.shipment) {
    items.push(
      `Active shipment: ${order.shipment.purpose} #${order.shipment.sequence}`,
      `Signature: ${order.shipment.signatureRequired ? "required" : "not required"}`,
    );
    if (order.shipment.handoffDeadlineAt)
      items.push(
        `Handoff deadline: ${formatDateTime(order.shipment.handoffDeadlineAt, timezone)}`,
      );
    if (order.shipment.autoRefundDeadlineAt)
      items.push(
        `Auto-refund deadline: ${formatDateTime(order.shipment.autoRefundDeadlineAt, timezone)}`,
      );
  }
  return (
    <details className="mt-3 border-t border-lh-line pt-1">
      <summary className="min-h-11 cursor-pointer py-3 text-xs font-semibold uppercase tracking-[0.12em] text-lh-primary">
        Policy queue
      </summary>
      <ul className="space-y-1 text-xs text-lh-muted">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function OrderDetails({ order }: { order: AdminProductOrderRow }) {
  return (
    <details className="mt-4 border-t border-lh-line pt-1">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-lh-primary">
        Items and shipping
      </summary>
      <OrderLineItems order={order} />
      {order.shippingLines ? (
        <address className="mt-3 border-t border-lh-line pt-3 text-sm not-italic text-lh-muted">
          {order.shippingLines.map((line) => (
            <span className="block" key={line}>
              {line}
            </span>
          ))}
        </address>
      ) : (
        <p className="mt-3 text-sm text-lh-muted">
          No shipping address is available.
        </p>
      )}
    </details>
  );
}

function OrderLineItems({ order }: { order: AdminProductOrderRow }) {
  return (
    <ul className="space-y-2">
      {order.lineItems.map((item, index) => (
        <li
          className="flex justify-between gap-4"
          key={`${item.description}-${index}`}
        >
          <span>
            {item.description}
            {item.quantity > 1 ? ` × ${item.quantity}` : ""}
          </span>
          <span className="whitespace-nowrap text-lh-muted">
            {formatMoney(item.totalCents, order.currency)}
          </span>
        </li>
      ))}
    </ul>
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

const cellClass = "px-4 py-4 align-top";

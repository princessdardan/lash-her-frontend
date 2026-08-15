import Link from "next/link";

import { AdminWorkspaceHeader } from "@/components/admin/admin-workspace-list";
import { FulfillmentOperationControls } from "@/components/admin/fulfillment-operation-controls";
import {
  ADMIN_FULFILLMENT_QUEUE_KEYS,
  listAdminFulfillmentOperations,
  type AdminFulfillmentOperationRow,
  type AdminFulfillmentQueueKey,
} from "@/lib/admin/operations-workspaces";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const QUEUE_LABELS: Record<AdminFulfillmentQueueKey, string> = {
  risk: "Payment risk",
  "provider-jobs": "Provider outcomes and jobs",
  notifications: "Customer notifications",
  "shipment-generations": "Shipment generations",
  "addresses-and-supplements": "Addresses and supplements",
  "decisions-and-extensions": "Decisions and extensions",
  "cases-claims-replacements-returns":
    "Cases, claims, replacements, and returns",
  refunds: "Refunds",
  "manual-fulfillment": "Manual pickup and shipping",
  funding: "Funding",
  "calendar-tax-policy-readiness": "Calendar, tax, and policy readiness",
};

export default async function AdminOperationsPage() {
  await requireAdminPagePermission("fulfillment:view");
  const result = await listAdminFulfillmentOperations();
  const totalActionable = Object.values(result.queues).reduce(
    (total, queue) => total + queue.total,
    0,
  );

  return (
    <div className="space-y-6">
      <AdminWorkspaceHeader
        description={
          <p>
            Product checkout exceptions ordered by their next operational
            deadline. Refresh after every mutation before taking the next
            action; versions and conflict tokens identify the state reviewed.
          </p>
        }
        eyebrow="Daily work"
        title="Operations"
      />

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-lh-muted">
        <p>
          {totalActionable} actionable item
          {totalActionable === 1 ? "" : "s"}. Times shown in{" "}
          {result.timezoneLabel}.
        </p>
        <Link
          className="inline-flex min-h-11 items-center rounded-full border border-lh-line px-4 font-semibold text-lh-primary"
          href="/admin/operations"
        >
          Refresh queue
        </Link>
      </div>

      {ADMIN_FULFILLMENT_QUEUE_KEYS.map((queue) => {
        const rows = result.rows.filter((row) => row.queue === queue);
        const queueState = result.queues[queue];
        return (
          <section
            aria-labelledby={`queue-${queue}`}
            className="rounded-2xl border border-lh-line bg-white p-5 shadow-sm"
            key={queue}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold" id={`queue-${queue}`}>
                {QUEUE_LABELS[queue]}
              </h2>
              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
                {queueState.returned === queueState.total
                  ? `${queueState.total} open`
                  : `${queueState.returned} of ${queueState.total} open`}
              </span>
            </div>
            {queueState.truncated ? (
              <p
                className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900"
                role="status"
              >
                This queue is truncated. Showing all current control blockers
                and up to {queueState.limit} database items with the earliest
                deadlines; {queueState.total - queueState.returned} later item
                {queueState.total - queueState.returned === 1
                  ? " remains"
                  : "s remain"}{" "}
                queued. Refresh after resolving visible work.
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-lh-muted">No actionable items.</p>
            ) : (
              <ol className="mt-4 divide-y divide-lh-line">
                {rows.map((row) => (
                  <OperationItem
                    generatedAt={result.generatedAt}
                    key={`${row.queue}:${row.id}`}
                    row={row}
                    timezone={result.timezone}
                  />
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

function OperationItem({
  generatedAt,
  row,
  timezone,
}: {
  generatedAt: Date;
  row: AdminFulfillmentOperationRow;
  timezone: string;
}) {
  const overdue =
    row.deadlineAt !== null &&
    row.deadlineAt.getTime() <= generatedAt.getTime();
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{row.title}</h3>
          <p className="mt-1 text-sm text-lh-muted">{row.detail}</p>
        </div>
        <p
          className={
            overdue
              ? "text-sm font-semibold text-red-700"
              : "text-sm text-lh-muted"
          }
        >
          {row.deadlineAt
            ? `${overdue ? "Due" : "Deadline"}: ${formatDateTime(row.deadlineAt, timezone)}`
            : "No deadline recorded"}
        </p>
      </div>
      <dl className="mt-3 grid gap-2 text-xs text-lh-muted sm:grid-cols-3">
        <div>
          <dt className="font-semibold uppercase tracking-[0.1em]">
            Stable ID
          </dt>
          <dd className="mt-1 break-all font-mono">{row.id}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-[0.1em]">Version</dt>
          <dd className="mt-1 font-mono">{row.stateVersion}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-[0.1em]">
            Conflict token
          </dt>
          <dd className="mt-1 break-all font-mono">{row.conflictToken}</dd>
        </div>
      </dl>
      {row.evidence.length ? (
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-lh-primary">
            Evidence ({row.evidence.length})
          </summary>
          <ul className="list-disc space-y-1 pl-5 text-sm text-lh-muted">
            {row.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="mt-3 text-sm font-semibold text-amber-800">
          Required evidence is not recorded.
        </p>
      )}
      <div className="mt-3 rounded-xl bg-lh-neutral-2 p-3 text-sm text-lh-muted">
        <p className="font-semibold text-lh-primary">Legal next action</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {row.legalNextActions.map((action) => (
            <li key={action}>{action}</li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {row.orderReference ? (
          <Link
            className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline underline-offset-4"
            href={`/admin/orders?q=${encodeURIComponent(row.orderReference)}`}
          >
            Open order
          </Link>
        ) : null}
        <FulfillmentOperationControls item={row} />
      </div>
    </li>
  );
}

function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}

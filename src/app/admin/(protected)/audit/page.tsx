import Link from "next/link";
import type { ReactNode } from "react";

import { StatusPill } from "@/components/admin/status-pill";
import {
  listAdminActivityHistory,
  type AdminActivityHistoryResult,
} from "@/lib/admin/audit-log";
import {
  ADMIN_ACTIVITY_AREA_OPTIONS,
  ADMIN_ACTIVITY_RESULT_OPTIONS,
  ADMIN_ACTIVITY_TIMEZONE,
  parseAdminActivityQuery,
  type AdminActivityFilterValues,
  type AdminActivityPresentation,
} from "@/lib/admin/activity-presentation";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ActivityHistorySearchParams {
  actor?: string | string[];
  area?: string | string[];
  from?: string | string[];
  page?: string | string[];
  result?: string | string[];
  to?: string | string[];
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<ActivityHistorySearchParams>;
}) {
  await requireAdminPagePermission("audit:view");
  const parsed = parseAdminActivityQuery(await searchParams);
  const history = await listAdminActivityHistory(parsed.filters);
  const firstVisible =
    history.total === 0 ? 0 : (history.page - 1) * history.pageSize + 1;
  const lastVisible = Math.min(history.page * history.pageSize, history.total);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Settings
        </p>
        <h1 className="font-heading text-4xl uppercase tracking-[0.06em] text-lh-shadow sm:text-5xl lg:text-6xl">
          Activity history
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-lh-muted sm:text-base">
          Supported changes and selected customer-data views recorded by this
          admin application. This is not a complete security or accounting
          audit.
        </p>
        <p className="text-sm text-lh-muted">Times shown in Toronto time.</p>
      </header>

      <ActivityFilters
        actors={history.actors}
        dateError={parsed.dateError}
        values={parsed.values}
      />

      <section aria-labelledby="activity-results-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-heading text-2xl uppercase tracking-[0.06em] text-lh-shadow"
              id="activity-results-heading"
            >
              Recorded activity
            </h2>
            <p aria-live="polite" className="mt-1 text-sm text-lh-muted">
              {history.total === 0
                ? "No matching activity"
                : `Showing ${firstVisible}–${lastVisible} of ${history.total}`}
            </p>
          </div>
        </div>

        {history.rows.length === 0 ? (
          <div className="rounded-2xl border border-lh-line bg-white px-5 py-10 text-center">
            <p className="font-semibold text-lh-shadow">
              No activity matches these filters.
            </p>
            <p className="mt-2 text-sm text-lh-muted">
              Clear one or more filters to widen the history.
            </p>
          </div>
        ) : (
          <>
            <ActivityCards rows={history.rows} />
            <ActivityTable rows={history.rows} />
          </>
        )}

        <ActivityPagination history={history} values={parsed.values} />
      </section>
    </div>
  );
}

function ActivityFilters({
  actors,
  dateError,
  values,
}: {
  actors: AdminActivityHistoryResult["actors"];
  dateError: string | null;
  values: AdminActivityFilterValues;
}) {
  return (
    <section
      aria-labelledby="activity-filter-heading"
      className="rounded-2xl border border-lh-line bg-white p-4 sm:p-5"
    >
      <h2
        className="font-heading text-xl uppercase tracking-[0.06em] text-lh-shadow"
        id="activity-filter-heading"
      >
        Filter activity
      </h2>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5"
        method="get"
      >
        <FilterField label="Person">
          <select
            className={inputClass}
            defaultValue={values.actorId}
            name="actor"
          >
            <option value="">All people</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="From">
          <input
            aria-describedby={dateError ? "activity-date-error" : undefined}
            aria-invalid={dateError ? true : undefined}
            className={inputClass}
            defaultValue={values.from}
            name="from"
            type="date"
          />
        </FilterField>
        <FilterField label="To">
          <input
            aria-describedby={dateError ? "activity-date-error" : undefined}
            aria-invalid={dateError ? true : undefined}
            className={inputClass}
            defaultValue={values.to}
            name="to"
            type="date"
          />
        </FilterField>
        <FilterField label="Area">
          <select className={inputClass} defaultValue={values.area} name="area">
            <option value="">All areas</option>
            {ADMIN_ACTIVITY_AREA_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Result">
          <select
            className={inputClass}
            defaultValue={values.outcome}
            name="result"
          >
            <option value="">All results</option>
            {ADMIN_ACTIVITY_RESULT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </FilterField>
        {dateError ? (
          <p
            className="text-sm text-lh-accent sm:col-span-2 xl:col-span-5"
            id="activity-date-error"
            role="alert"
          >
            {dateError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3 sm:col-span-2 xl:col-span-5">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-2 text-sm font-semibold text-white transition hover:bg-lh-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary"
            type="submit"
          >
            Apply filters
          </button>
          <Link
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-2 text-sm font-semibold text-lh-shadow transition hover:border-lh-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary"
            href="/admin/audit"
          >
            Clear filters
          </Link>
        </div>
      </form>
    </section>
  );
}

function ActivityCards({ rows }: { rows: AdminActivityPresentation[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {rows.map((row) => (
        <li
          className="rounded-2xl border border-lh-line bg-white p-4"
          key={row.id}
        >
          <div className="flex items-start justify-between gap-3">
            <time
              className="text-xs font-medium text-lh-muted"
              dateTime={row.createdAt.toISOString()}
            >
              {formatActivityTime(row.createdAt)}
            </time>
            <StatusPill tone={row.result.tone}>{row.result.label}</StatusPill>
          </div>
          <p className="mt-3 text-sm leading-6 text-lh-shadow">
            {row.description}
          </p>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
            {row.areaLabel}
          </p>
          <ActivityRecordLink row={row} />
          <SystemDetails row={row} />
        </li>
      ))}
    </ul>
  );
}

function ActivityTable({ rows }: { rows: AdminActivityPresentation[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border border-lh-line bg-white md:block">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Supported admin activity, newest first
        </caption>
        <thead className="bg-lh-neutral-2 text-xs uppercase tracking-[0.14em] text-lh-muted">
          <tr>
            <th className={headingCellClass} scope="col">
              When
            </th>
            <th className={headingCellClass} scope="col">
              Activity
            </th>
            <th className={headingCellClass} scope="col">
              Area
            </th>
            <th className={headingCellClass} scope="col">
              Result
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-lh-line">
          {rows.map((row) => (
            <tr className="align-top" key={row.id}>
              <td className="whitespace-nowrap px-4 py-4 text-xs text-lh-muted">
                <time dateTime={row.createdAt.toISOString()}>
                  {formatActivityTime(row.createdAt)}
                </time>
              </td>
              <td className="px-4 py-4">
                <p className="max-w-2xl leading-6 text-lh-shadow">
                  {row.description}
                </p>
                <ActivityRecordLink row={row} />
                <SystemDetails row={row} />
              </td>
              <td className="whitespace-nowrap px-4 py-4 text-lh-muted">
                {row.areaLabel}
              </td>
              <td className="whitespace-nowrap px-4 py-4">
                <StatusPill tone={row.result.tone}>
                  {row.result.label}
                </StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityRecordLink({ row }: { row: AdminActivityPresentation }) {
  if (!row.targetHref || !row.targetLabel) {
    return null;
  }
  return (
    <Link
      className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-lh-primary underline decoration-lh-primary/30 underline-offset-4 hover:decoration-lh-primary"
      href={row.targetHref}
    >
      View {row.targetLabel}
    </Link>
  );
}

function SystemDetails({ row }: { row: AdminActivityPresentation }) {
  const details = row.systemDetails;
  return (
    <details className="mt-2 text-xs text-lh-muted">
      <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-lh-shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary">
        System details
      </summary>
      <dl className="grid gap-x-4 gap-y-2 border-l border-lh-line pl-3 sm:grid-cols-[max-content_1fr]">
        <Detail label="Action code" value={details.action} />
        <Detail label="Area code" value={details.domain} />
        <Detail label="Result code" value={details.outcome} />
        <Detail label="Actor role" value={details.actorRole} />
        {details.reason ? (
          <Detail label="Reason code" value={details.reason} />
        ) : null}
        {details.requestedPermission ? (
          <Detail
            label="Requested permission"
            value={details.requestedPermission}
          />
        ) : null}
        {details.targetType ? (
          <Detail label="Record type" value={details.targetType} />
        ) : null}
        {details.targetId ? (
          <Detail label="Record ID" value={details.targetId} />
        ) : null}
        {details.correlationId ? (
          <Detail label="Correlation ID" value={details.correlationId} />
        ) : null}
      </dl>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-semibold">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  );
}

function ActivityPagination({
  history,
  values,
}: {
  history: AdminActivityHistoryResult;
  values: AdminActivityFilterValues;
}) {
  if (history.pageCount <= 1) {
    return null;
  }
  return (
    <nav
      aria-label="Activity history pages"
      className="flex items-center justify-between gap-4"
    >
      {history.page > 1 ? (
        <Link
          className={paginationLinkClass}
          href={pageHref(values, history.page - 1)}
          rel="prev"
        >
          Previous
        </Link>
      ) : (
        <span aria-disabled="true" className={paginationDisabledClass}>
          Previous
        </span>
      )}
      <span className="text-sm text-lh-muted">
        Page {history.page} of {history.pageCount}
      </span>
      {history.page < history.pageCount ? (
        <Link
          className={paginationLinkClass}
          href={pageHref(values, history.page + 1)}
          rel="next"
        >
          Next
        </Link>
      ) : (
        <span aria-disabled="true" className={paginationDisabledClass}>
          Next
        </span>
      )}
    </nav>
  );
}

function FilterField({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-lh-shadow">
      <span>{label}</span>
      {children}
    </label>
  );
}

function pageHref(values: AdminActivityFilterValues, page: number): string {
  const query = new URLSearchParams();
  if (values.actorId) query.set("actor", values.actorId);
  if (values.from) query.set("from", values.from);
  if (values.to) query.set("to", values.to);
  if (values.area) query.set("area", values.area);
  if (values.outcome) query.set("result", values.outcome);
  if (page > 1) query.set("page", String(page));
  const serialized = query.toString();
  return serialized ? `/admin/audit?${serialized}` : "/admin/audit";
}

function formatActivityTime(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: ADMIN_ACTIVITY_TIMEZONE,
  }).format(date);
}

const inputClass =
  "min-h-11 w-full rounded-lg border border-lh-line bg-white px-3 py-2 text-sm text-lh-shadow focus:border-lh-primary focus:outline-none focus:ring-2 focus:ring-lh-primary/20";
const headingCellClass = "px-4 py-3 font-semibold";
const paginationLinkClass =
  "inline-flex min-h-11 min-w-24 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold text-lh-shadow transition hover:border-lh-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lh-primary";
const paginationDisabledClass =
  "inline-flex min-h-11 min-w-24 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold text-lh-muted opacity-50";

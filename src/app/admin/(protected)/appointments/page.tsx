import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminTable } from "@/components/admin/admin-table";
import { StatusPill } from "@/components/admin/status-pill";
import {
  ADMIN_APPOINTMENT_VIEWS,
  getAdminAppointments,
  type AdminAppointmentFilters,
  type AdminAppointmentSearchParams,
  type AdminAppointmentView,
} from "@/lib/admin/appointment-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIEW_LABELS: Record<AdminAppointmentView, string> = {
  all: "All",
  "needs-attention": "Needs attention",
  past: "Past",
  today: "Today",
  upcoming: "Upcoming",
};

export default async function AdminAppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<AdminAppointmentSearchParams>;
}) {
  await requireAdminPagePermission("bookings:view");
  const data = await getAdminAppointments(await searchParams);

  if (data.pageCount > 0 && data.page > data.pageCount) {
    redirect(
      buildAppointmentsHref(data.filters, {
        page: data.pageCount,
      }),
    );
  }

  const firstVisible =
    data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const lastVisible = Math.min(data.page * data.pageSize, data.total);
  const hasFilters = Boolean(
    data.filters.from ||
    data.filters.providerId ||
    data.filters.query ||
    data.filters.status ||
    data.filters.to,
  );

  return (
    <div className="space-y-7">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Daily work
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Appointments
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Find appointments, record attendance, and resolve bookings that need
          follow-up. Times shown in {data.businessTimezoneLabel}.
        </p>
      </header>

      <nav
        aria-label="Appointment views"
        className="flex gap-2 overflow-x-auto pb-1"
      >
        {ADMIN_APPOINTMENT_VIEWS.map((view) => {
          const active = data.filters.view === view;
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-lh-shadow px-4 py-2 text-sm font-semibold text-white"
                  : "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-lh-line bg-white px-4 py-2 text-sm font-semibold text-lh-shadow transition hover:border-lh-primary hover:bg-lh-neutral-2"
              }
              href={buildAppointmentsHref(data.filters, {
                page: null,
                view,
              })}
              key={view}
            >
              {VIEW_LABELS[view]}
              {view === "needs-attention" && data.attentionCount > 0 ? (
                <span
                  className={
                    active
                      ? "rounded-full bg-white/20 px-2 py-0.5 text-xs"
                      : "rounded-full bg-lh-light-soft px-2 py-0.5 text-xs text-lh-accent"
                  }
                >
                  {data.attentionCount.toLocaleString("en-CA")}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <form
        action="/admin/appointments"
        className="rounded-2xl border border-lh-line bg-white p-4 sm:p-5"
        method="get"
      >
        <input name="view" type="hidden" value={data.filters.view} />
        {data.filters.dateBasis === "completed" ? (
          <input name="basis" type="hidden" value="completed" />
        ) : null}
        {data.filters.dateBasis === "completed" ? (
          <p className="mb-4 text-sm text-lh-muted">
            Date filters use the appointment completion date.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <FilterField
            error={data.fieldErrors.query}
            id="appointment-search"
            label="Customer or reference"
          >
            <input
              aria-describedby={
                data.fieldErrors.query ? "appointment-search-error" : undefined
              }
              aria-invalid={data.fieldErrors.query ? true : undefined}
              className={inputClass}
              defaultValue={data.filters.query}
              id="appointment-search"
              maxLength={120}
              name="q"
              placeholder="Name, email, or reference"
              type="search"
            />
          </FilterField>
          <FilterField
            error={data.fieldErrors.from}
            id="appointment-from"
            label="From"
          >
            <input
              aria-describedby={
                data.fieldErrors.from ? "appointment-from-error" : undefined
              }
              aria-invalid={data.fieldErrors.from ? true : undefined}
              className={inputClass}
              defaultValue={data.filters.from}
              id="appointment-from"
              name="from"
              type="date"
            />
          </FilterField>
          <FilterField
            error={data.fieldErrors.to}
            id="appointment-to"
            label="To"
          >
            <input
              aria-describedby={
                data.fieldErrors.to ? "appointment-to-error" : undefined
              }
              aria-invalid={data.fieldErrors.to ? true : undefined}
              className={inputClass}
              defaultValue={data.filters.to}
              id="appointment-to"
              name="to"
              type="date"
            />
          </FilterField>
          <FilterField
            error={data.fieldErrors.provider}
            id="appointment-provider"
            label="Provider"
          >
            <select
              aria-describedby={
                data.fieldErrors.provider
                  ? "appointment-provider-error"
                  : undefined
              }
              aria-invalid={data.fieldErrors.provider ? true : undefined}
              className={inputClass}
              defaultValue={data.filters.providerId}
              id="appointment-provider"
              name="provider"
            >
              <option value="">All providers</option>
              {data.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField
            error={data.fieldErrors.status}
            id="appointment-status"
            label="Status"
          >
            <select
              aria-describedby={
                data.fieldErrors.status ? "appointment-status-error" : undefined
              }
              aria-invalid={data.fieldErrors.status ? true : undefined}
              className={inputClass}
              defaultValue={data.filters.status}
              id="appointment-status"
              name="status"
            >
              <option value="">All statuses</option>
              {data.statusOptions.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </FilterField>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-shadow px-5 py-2 text-sm font-semibold text-white transition hover:bg-lh-primary"
            type="submit"
          >
            Apply filters
          </button>
          {hasFilters ? (
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-2 text-sm font-semibold text-lh-shadow transition hover:bg-lh-neutral-2"
              href={buildAppointmentsHref(data.filters, {
                basis: null,
                from: null,
                page: null,
                provider: null,
                q: null,
                status: null,
                to: null,
              })}
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="appointment-results-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-heading text-3xl uppercase tracking-[0.08em]"
              id="appointment-results-heading"
            >
              {VIEW_LABELS[data.filters.view]}
            </h2>
            <p aria-live="polite" className="mt-1 text-sm text-lh-muted">
              {data.total === 0
                ? "0 appointments"
                : `Showing ${firstVisible}–${lastVisible} of ${data.total.toLocaleString("en-CA")}`}
            </p>
          </div>
        </div>

        {data.rows.length > 0 ? (
          <>
            <ul className="space-y-3 md:hidden">
              {data.rows.map((row) => (
                <li
                  className="rounded-2xl border border-lh-line bg-white p-4"
                  key={row.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link
                        className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline-offset-4 hover:underline"
                        href={`/admin/appointments/${row.id}`}
                      >
                        {formatDateTime(
                          row.selectedStart,
                          data.businessTimezone,
                        )}
                      </Link>
                      <p className="mt-1 text-xs text-lh-muted">
                        Ends{" "}
                        {formatTime(row.selectedEnd, data.businessTimezone)}
                      </p>
                    </div>
                    <StatusPill tone={row.status.tone}>
                      {row.status.label}
                    </StatusPill>
                  </div>
                  <p className="mt-4 font-semibold text-lh-shadow">
                    {row.customerName}
                  </p>
                  <p className="mt-1 text-sm text-lh-muted">
                    {row.serviceName}
                    {row.addOnName ? ` · ${row.addOnName}` : ""}
                  </p>
                  <p className="mt-2 text-sm">
                    <span className="text-lh-muted">Provider: </span>
                    {row.providerName}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill tone={row.paymentStatus.tone}>
                      {row.paymentStatus.label}
                    </StatusPill>
                    <StatusPill tone={row.calendarStatus.tone}>
                      {row.calendarStatus.label}
                    </StatusPill>
                  </div>
                  {row.attentionReasons.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-sm text-lh-accent">
                      {row.attentionReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-4 text-xs text-lh-muted">
                    Reference {row.publicReference}
                  </p>
                </li>
              ))}
            </ul>

            <AdminTable
              caption={`${VIEW_LABELS[data.filters.view]} appointments`}
              className="hidden md:block"
              minimumWidth="content"
            >
              <thead className={theadClass}>
                <tr>
                  <th className={cellClass} scope="col">
                    When
                  </th>
                  <th className={cellClass} scope="col">
                    Customer & service
                  </th>
                  <th className={cellClass} scope="col">
                    Provider
                  </th>
                  <th className={cellClass} scope="col">
                    Status
                  </th>
                  <th className={cellClass} scope="col">
                    Payment & calendar
                  </th>
                  <th className={cellClass} scope="col">
                    Reference
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-lh-line">
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className={cellClass}>
                      <Link
                        className="inline-flex min-h-11 items-center font-semibold text-lh-primary underline-offset-4 hover:underline"
                        href={`/admin/appointments/${row.id}`}
                      >
                        {formatDateTime(
                          row.selectedStart,
                          data.businessTimezone,
                        )}
                      </Link>
                      <p className="mt-1 text-xs text-lh-muted">
                        to {formatTime(row.selectedEnd, data.businessTimezone)}
                      </p>
                    </td>
                    <td className={cellClass}>
                      <p className="font-semibold">{row.customerName}</p>
                      <p className="mt-1 max-w-64 text-xs text-lh-muted">
                        {row.serviceName}
                        {row.addOnName ? ` · ${row.addOnName}` : ""}
                      </p>
                    </td>
                    <td className={cellClass}>{row.providerName}</td>
                    <td className={cellClass}>
                      <StatusPill tone={row.status.tone}>
                        {row.status.label}
                      </StatusPill>
                      {row.attentionReasons.length > 0 ? (
                        <ul className="mt-2 max-w-64 space-y-1 text-xs text-lh-accent">
                          {row.attentionReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td className={cellClass}>
                      <div className="flex max-w-64 flex-wrap gap-2">
                        <StatusPill tone={row.paymentStatus.tone}>
                          {row.paymentStatus.label}
                        </StatusPill>
                        <StatusPill tone={row.calendarStatus.tone}>
                          {row.calendarStatus.label}
                        </StatusPill>
                      </div>
                    </td>
                    <td className={cellClass}>{row.publicReference}</td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </>
        ) : (
          <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
            {getEmptyMessage(data.filters.view, hasFilters)}
          </p>
        )}
      </section>

      {data.pageCount > 1 ? (
        <nav
          aria-label="Appointment result pages"
          className="flex items-center justify-between gap-4"
        >
          {data.page > 1 ? (
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line bg-white px-5 py-2 text-sm font-semibold transition hover:bg-lh-neutral-2"
              href={buildAppointmentsHref(data.filters, {
                page: data.page - 1,
              })}
              rel="prev"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          <p className="text-sm text-lh-muted">
            Page {data.page.toLocaleString("en-CA")} of{" "}
            {data.pageCount.toLocaleString("en-CA")}
          </p>
          {data.page < data.pageCount ? (
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line bg-white px-5 py-2 text-sm font-semibold transition hover:bg-lh-neutral-2"
              href={buildAppointmentsHref(data.filters, {
                page: data.page + 1,
              })}
              rel="next"
            >
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

function FilterField({
  children,
  error,
  id,
  label,
}: {
  children: React.ReactNode;
  error?: string;
  id: string;
  label: string;
}) {
  return (
    <div>
      <label
        className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted"
        htmlFor={id}
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-red-700" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

type AppointmentHrefOverrides = Partial<{
  basis: string | null;
  from: string | null;
  page: number | null;
  provider: string | null;
  q: string | null;
  status: string | null;
  to: string | null;
  view: AdminAppointmentView;
}>;

function buildAppointmentsHref(
  filters: AdminAppointmentFilters,
  overrides: AppointmentHrefOverrides,
): string {
  const values: Record<string, string> = {
    basis: filters.dateBasis === "completed" ? filters.dateBasis : "",
    from: filters.from,
    provider: filters.providerId,
    q: filters.query,
    status: filters.status,
    to: filters.to,
    view: filters.view,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete values[key];
    } else if (value !== undefined) {
      values[key] = String(value);
    }
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value && !(key === "page" && value === "1")) query.set(key, value);
  }

  const serialized = query.toString();
  return serialized
    ? `/admin/appointments?${serialized}`
    : "/admin/appointments";
}

function getEmptyMessage(
  view: AdminAppointmentView,
  hasFilters: boolean,
): string {
  if (hasFilters) return "No appointments match these filters.";
  if (view === "today") return "No appointments are scheduled today.";
  if (view === "upcoming") return "No upcoming appointments were found.";
  if (view === "past") return "No past appointments were found.";
  if (view === "needs-attention") {
    return "No appointments currently need attention.";
  }
  return "No appointments have been created yet.";
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

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm text-lh-shadow outline-none transition focus:border-lh-primary focus:ring-2 focus:ring-lh-primary/20 aria-[invalid=true]:border-red-600 aria-[invalid=true]:ring-red-100";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "whitespace-nowrap px-4 py-3 align-top";

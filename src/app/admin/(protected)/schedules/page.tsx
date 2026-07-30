import Link from "next/link";

import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { AdminTabLink } from "@/components/admin/admin-tab-link";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { formatDateInTimezone } from "@/lib/admin/business-time";
import { listAdminSchedules } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  getBookingConfigurationStatusPresentation,
  getScheduleExceptionKindLabel,
  getScheduleExceptionStatusPresentation,
  getTimezoneLabel,
} from "@/lib/admin/presentation";

import {
  cancelScheduleExceptionAction,
  createResourceScheduleAction,
  createScheduleExceptionAction,
  disableResourceScheduleAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AvailabilityTab = "calendar" | "exceptions" | "hours";

const weekdays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export default async function AdminSchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
    resource?: string | string[];
    tab?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("schedules:view");
  const data = await listAdminSchedules({
    resourceId: firstString(feedback.resource),
  });
  const tab = normalizeTab(firstString(feedback.tab));
  const requestedResourceId = firstString(feedback.resource);
  const selectedResourceId = data.resources.some(
    (resource) => resource.id === requestedResourceId,
  )
    ? requestedResourceId
    : "";
  const canManage = canAdmin({
    action: "schedules:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const resourcesById = new Map(
    data.resources.map((resource) => [resource.id, resource]),
  );
  const now = new Date();
  const schedules = selectedResourceId
    ? data.schedules.filter(
        (schedule) => schedule.resourceId === selectedResourceId,
      )
    : data.schedules;
  const currentSchedules = schedules.filter(
    (schedule) =>
      schedule.status === "active" &&
      (schedule.effectiveUntil === null ||
        schedule.effectiveUntil >=
          formatDateInTimezone(now, schedule.timezone)),
  );
  const scheduleHistory = schedules.filter(
    (schedule) => !currentSchedules.includes(schedule),
  );
  const exceptions = selectedResourceId
    ? data.exceptions.filter(
        (exception) => exception.resourceId === selectedResourceId,
      )
    : data.exceptions;
  const currentExceptions = exceptions.filter(
    (exception) => exception.status === "active" && exception.endsAt >= now,
  );
  const exceptionHistory = exceptions.filter(
    (exception) => exception.status !== "active" || exception.endsAt < now,
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Manage business
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Availability
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Set regular hours, block time off, or open extra hours for a specific
          date.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <nav aria-label="Availability sections" className="flex flex-wrap gap-2">
        {(
          [
            ["hours", "Regular hours"],
            ["exceptions", "Time off and extra hours"],
            ["calendar", "Calendar sync"],
          ] as const
        ).map(([value, label]) => (
          <AdminTabLink
            active={tab === value}
            className="px-5"
            href={availabilityHref(value, selectedResourceId)}
            key={value}
          >
            {label}
          </AdminTabLink>
        ))}
      </nav>

      {data.resources.length > 1 && tab !== "calendar" ? (
        <form
          action="/admin/schedules"
          className="flex max-w-xl flex-col gap-3 rounded-2xl border border-lh-line bg-white p-4 sm:flex-row sm:items-end"
          method="get"
        >
          <input name="tab" type="hidden" value={tab} />
          <Field label="Availability for">
            <select
              className={inputClass}
              defaultValue={selectedResourceId}
              name="resource"
            >
              <option value="">Everyone and all resources</option>
              {data.resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
          </Field>
          <button className={secondaryButtonClass} type="submit">
            Apply
          </button>
        </form>
      ) : null}

      {canManage && data.resources.length > 0 ? (
        <div>
          {tab === "hours" ? (
            <details className={panelClass}>
              <summary className={summaryClass}>Add weekly hours</summary>
              <form action={createResourceScheduleAction} className="mt-5">
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <ResourceField
                    defaultResourceId={selectedResourceId}
                    resources={data.resources}
                  />
                  <Field label="Weekday">
                    <select className={inputClass} name="weekday">
                      {weekdays.map((day, index) => (
                        <option key={day} value={index + 1}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Starts">
                    <input
                      className={inputClass}
                      name="startsAt"
                      type="time"
                      required
                    />
                  </Field>
                  <Field label="Ends">
                    <input
                      className={inputClass}
                      name="endsAt"
                      type="time"
                      required
                    />
                  </Field>
                  <Field label="Effective from">
                    <input
                      className={inputClass}
                      name="effectiveFrom"
                      type="date"
                      required
                    />
                  </Field>
                  <Field label="Effective until (optional)">
                    <input
                      className={inputClass}
                      name="effectiveUntil"
                      type="date"
                    />
                  </Field>
                </div>
                <AdminSubmitButton
                  className={primaryButtonClass}
                  pendingLabel="Adding hours…"
                >
                  Add hours
                </AdminSubmitButton>
              </form>
            </details>
          ) : null}

          {tab === "exceptions" ? (
            <details className={panelClass} id="time-off">
              <summary className={summaryClass}>
                Add time off or extra hours
              </summary>
              <form action={createScheduleExceptionAction} className="mt-5">
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <ResourceField
                    defaultResourceId={selectedResourceId}
                    resources={data.resources}
                  />
                  <Field label="Type">
                    <select
                      className={inputClass}
                      name="kind"
                      defaultValue="unavailable"
                    >
                      <option value="unavailable">
                        {getScheduleExceptionKindLabel("unavailable")}
                      </option>
                      <option value="available">
                        {getScheduleExceptionKindLabel("available")}
                      </option>
                    </select>
                  </Field>
                  <Field label="Starts">
                    <input
                      className={inputClass}
                      name="startsAtLocal"
                      type="datetime-local"
                      required
                    />
                  </Field>
                  <Field label="Ends">
                    <input
                      className={inputClass}
                      name="endsAtLocal"
                      type="datetime-local"
                      required
                    />
                  </Field>
                  <Field label="Note">
                    <input className={inputClass} name="note" maxLength={500} />
                  </Field>
                </div>
                <AdminSubmitButton
                  className={primaryButtonClass}
                  pendingLabel="Adding time change…"
                >
                  Add time change
                </AdminSubmitButton>
              </form>
            </details>
          ) : null}
        </div>
      ) : null}

      {tab === "hours" ? (
        <section className="space-y-4">
          <h2 className={sectionHeadingClass}>Regular hours</h2>
          {currentSchedules.length > 0 ? (
            <AdminTable caption="Regular availability by person, room, or equipment">
              <thead className={theadClass}>
                <tr>
                  <th className={cellClass} scope="col">
                    Person, room, or equipment
                  </th>
                  <th className={cellClass} scope="col">
                    Day
                  </th>
                  <th className={cellClass} scope="col">
                    Hours
                  </th>
                  <th className={cellClass} scope="col">
                    Effective dates
                  </th>
                  <th className={cellClass} scope="col">
                    Status
                  </th>
                  <th className={cellClass} scope="col">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-lh-line">
                {currentSchedules.map((schedule) => {
                  const status = getBookingConfigurationStatusPresentation(
                    schedule.status,
                  );

                  return (
                    <tr key={schedule.id}>
                      <td className={cellClass}>
                        {resourcesById.get(schedule.resourceId)?.name ??
                          "Unknown"}
                      </td>
                      <td className={cellClass}>
                        {weekdays[schedule.weekday - 1]}
                      </td>
                      <td className={cellClass}>
                        {schedule.startsAt.slice(0, 5)}–
                        {schedule.endsAt.slice(0, 5)}
                        <p className="text-xs text-lh-muted">
                          {getTimezoneLabel(schedule.timezone)}
                        </p>
                      </td>
                      <td className={cellClass}>
                        {schedule.effectiveFrom}
                        {schedule.effectiveUntil
                          ? ` to ${schedule.effectiveUntil}`
                          : " onward"}
                      </td>
                      <td className={cellClass}>
                        <StatusPill tone={status.tone}>
                          {status.label}
                        </StatusPill>
                      </td>
                      <td className={cellClass}>
                        {canManage && schedule.status === "active" ? (
                          <form action={disableResourceScheduleAction}>
                            <input
                              type="hidden"
                              name="scheduleId"
                              value={schedule.id}
                            />
                            <input
                              type="hidden"
                              name="resourceId"
                              value={schedule.resourceId}
                            />
                            <ConfirmSubmitButton
                              className={secondaryButtonClass}
                              confirmation={`Disable weekly hours for ${
                                resourcesById.get(schedule.resourceId)?.name ??
                                "this resource"
                              }?`}
                            >
                              Disable
                            </ConfirmSubmitButton>
                          </form>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </AdminTable>
          ) : (
            <p className={emptyStateClass}>
              No current or upcoming regular hours match this view.
            </p>
          )}
          {scheduleHistory.length > 0 ? (
            <details className="rounded-2xl border border-lh-line bg-white p-4">
              <summary className={summaryClass}>
                History ({scheduleHistory.length})
              </summary>
              <ul className="mt-4 divide-y divide-lh-line">
                {scheduleHistory.map((schedule) => {
                  const status = getBookingConfigurationStatusPresentation(
                    schedule.status,
                  );
                  return (
                    <li
                      className="grid gap-2 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                      key={schedule.id}
                    >
                      <div>
                        <p className="font-semibold">
                          {resourcesById.get(schedule.resourceId)?.name ??
                            "Unknown"}
                          {" · "}
                          {weekdays[schedule.weekday - 1]}
                        </p>
                        <p className="mt-1 text-lh-muted">
                          {schedule.startsAt.slice(0, 5)}–
                          {schedule.endsAt.slice(0, 5)}
                          {" · "}
                          {schedule.effectiveFrom}
                          {schedule.effectiveUntil
                            ? ` to ${schedule.effectiveUntil}`
                            : " onward"}
                        </p>
                      </div>
                      <StatusPill tone={status.tone}>
                        {schedule.status === "active"
                          ? "Expired"
                          : status.label}
                      </StatusPill>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {tab === "exceptions" ? (
        <section className="space-y-4">
          <h2 className={sectionHeadingClass}>Time off and extra hours</h2>
          <p className="max-w-3xl text-sm leading-6 text-lh-muted">
            Block time removes availability. Open extra hours adds availability
            outside regular hours.
          </p>
          {currentExceptions.length > 0 ? (
            <>
              <AdminTable caption="Current and upcoming time off and extra hours">
                <thead className={theadClass}>
                  <tr>
                    <th className={cellClass} scope="col">
                      Person, room, or equipment
                    </th>
                    <th className={cellClass} scope="col">
                      Type
                    </th>
                    <th className={cellClass} scope="col">
                      When
                    </th>
                    <th className={cellClass} scope="col">
                      Note
                    </th>
                    <th className={cellClass} scope="col">
                      Status
                    </th>
                    <th className={cellClass} scope="col">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-lh-line">
                  {currentExceptions.map((exception) => {
                    const resource = resourcesById.get(exception.resourceId);
                    return (
                      <tr key={exception.id}>
                        <td className={cellClass}>
                          {resource?.name ?? "Unknown"}
                        </td>
                        <td className={cellClass}>
                          {getScheduleExceptionKindLabel(exception.kind)}
                        </td>
                        <td className={cellClass}>
                          {formatDate(exception.startsAt, exception.timezone)}
                          <br />
                          to {formatDate(exception.endsAt, exception.timezone)}
                          <p className="text-xs text-lh-muted">
                            {getTimezoneLabel(exception.timezone)}
                          </p>
                        </td>
                        <td className={cellClass}>{exception.note ?? "—"}</td>
                        <td className={cellClass}>
                          <ExceptionStatus status={exception.status} />
                        </td>
                        <td className={cellClass}>
                          {canManage && exception.status === "active" ? (
                            <form action={cancelScheduleExceptionAction}>
                              <input
                                type="hidden"
                                name="exceptionId"
                                value={exception.id}
                              />
                              <input
                                type="hidden"
                                name="resourceId"
                                value={exception.resourceId}
                              />
                              <ConfirmSubmitButton
                                className={secondaryButtonClass}
                                confirmation={
                                  exception.kind === "unavailable"
                                    ? `Cancel this time off for ${resource?.name ?? "this resource"} and reopen the time?`
                                    : `Cancel these extra hours for ${resource?.name ?? "this resource"}?`
                                }
                              >
                                Cancel
                              </ConfirmSubmitButton>
                            </form>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </AdminTable>
              {currentExceptions.length === 200 ? (
                <p className="text-xs text-lh-muted">
                  Showing the next 200 current or upcoming time changes.
                </p>
              ) : null}
            </>
          ) : (
            <p className={emptyStateClass}>
              No current or upcoming time changes match this view.
            </p>
          )}

          {exceptionHistory.length > 0 ? (
            <details className="rounded-2xl border border-lh-line bg-white p-4">
              <summary className={summaryClass}>
                History ({exceptionHistory.length})
              </summary>
              <div className="mt-4">
                <ExceptionHistoryTable
                  exceptions={exceptionHistory}
                  resourcesById={resourcesById}
                />
                {exceptionHistory.length === 100 ? (
                  <p className="mt-3 text-xs text-lh-muted">
                    Showing the 100 most recent history records.
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {tab === "calendar" ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <h2 className={sectionHeadingClass}>Calendar sync</h2>
          <p className="mt-3 max-w-3xl text-lh-muted">
            Choose where new appointments are added and which connected
            calendars block times that are already busy.
          </p>
          <Link
            className={`${secondaryButtonClass} mt-5`}
            href="/admin/calendar-connections"
          >
            Manage calendar sync
          </Link>
        </section>
      ) : null}
    </div>
  );
}

function ResourceField({
  defaultResourceId,
  resources,
}: {
  defaultResourceId: string;
  resources: Array<{ id: string; name: string; timezone: string }>;
}) {
  return (
    <Field label="Person, room, or equipment">
      <select
        className={inputClass}
        defaultValue={defaultResourceId || resources[0]?.id}
        name="resourceId"
      >
        {resources.map((resource) => (
          <option key={resource.id} value={resource.id}>
            {resource.name} ({getTimezoneLabel(resource.timezone)})
          </option>
        ))}
      </select>
    </Field>
  );
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
function ExceptionStatus({ status }: { status: "active" | "cancelled" }) {
  const presentation = getScheduleExceptionStatusPresentation(status);
  return <StatusPill tone={presentation.tone}>{presentation.label}</StatusPill>;
}

function ExceptionHistoryTable({
  exceptions,
  resourcesById,
}: {
  exceptions: Awaited<ReturnType<typeof listAdminSchedules>>["exceptions"];
  resourcesById: Map<
    string,
    Awaited<ReturnType<typeof listAdminSchedules>>["resources"][number]
  >;
}) {
  return (
    <AdminTable caption="Past and cancelled time changes">
      <thead className={theadClass}>
        <tr>
          <th className={cellClass} scope="col">
            Person, room, or equipment
          </th>
          <th className={cellClass} scope="col">
            Type
          </th>
          <th className={cellClass} scope="col">
            When
          </th>
          <th className={cellClass} scope="col">
            Note
          </th>
          <th className={cellClass} scope="col">
            Status
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-lh-line">
        {exceptions.map((exception) => (
          <tr key={exception.id}>
            <td className={cellClass}>
              {resourcesById.get(exception.resourceId)?.name ?? "Unknown"}
            </td>
            <td className={cellClass}>
              {getScheduleExceptionKindLabel(exception.kind)}
            </td>
            <td className={cellClass}>
              {formatDate(exception.startsAt, exception.timezone)}
              <br />
              to {formatDate(exception.endsAt, exception.timezone)}
              <p className="text-xs text-lh-muted">
                {getTimezoneLabel(exception.timezone)}
              </p>
            </td>
            <td className={cellClass}>{exception.note ?? "—"}</td>
            <td className={cellClass}>
              {exception.status === "active" ? (
                <StatusPill>Expired</StatusPill>
              ) : (
                <ExceptionStatus status={exception.status} />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </AdminTable>
  );
}

function normalizeTab(value: string): AvailabilityTab {
  return value === "exceptions" || value === "calendar" ? value : "hours";
}

function firstString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function availabilityHref(tab: AvailabilityTab, resourceId: string): string {
  const params = new URLSearchParams({ tab });
  if (resourceId && tab !== "calendar") {
    params.set("resource", resourceId);
  }
  return `/admin/schedules?${params.toString()}`;
}

function formatDate(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}
const panelClass = "rounded-2xl border border-lh-line bg-white p-6";
const sectionHeadingClass = "font-heading text-4xl uppercase tracking-[0.08em]";
const summaryClass =
  "flex min-h-11 cursor-pointer items-center font-semibold text-lh-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary";
const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "mt-5 min-h-11 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const emptyStateClass =
  "rounded-2xl border border-dashed border-lh-line bg-white p-6 text-sm text-lh-muted";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";

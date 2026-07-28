import { AdminTable } from "@/components/admin/admin-table";
import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { listAdminSchedules } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

import {
  cancelScheduleExceptionAction,
  createResourceScheduleAction,
  createScheduleExceptionAction,
  disableResourceScheduleAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("schedules:view");
  const data = await listAdminSchedules();
  const canManage = canAdmin({
    action: "schedules:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const resourcesById = new Map(
    data.resources.map((resource) => [resource.id, resource]),
  );

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Availability control
        </p>
        <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
          Schedules & time off
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Weekly hours use each resource&apos;s timezone. Exceptions add
          availability or close a specific local date and time range.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {canManage && data.resources.length > 0 ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <form action={createResourceScheduleAction} className={panelClass}>
            <h2 className={headingClass}>Add weekly hours</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <ResourceField resources={data.resources} />
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
            <SubmitButton>Add hours</SubmitButton>
          </form>

          <form action={createScheduleExceptionAction} className={panelClass}>
            <h2 className={headingClass}>Add exception</h2>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <ResourceField resources={data.resources} />
              <Field label="Type">
                <select
                  className={inputClass}
                  name="kind"
                  defaultValue="unavailable"
                >
                  <option value="unavailable">Unavailable / time off</option>
                  <option value="available">Extra availability</option>
                </select>
              </Field>
              <Field label="Local start">
                <input
                  className={inputClass}
                  name="startsAtLocal"
                  type="datetime-local"
                  required
                />
              </Field>
              <Field label="Local end">
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
            <SubmitButton>Add exception</SubmitButton>
          </form>
        </div>
      ) : null}

      <section className="space-y-4">
        <h2 className={sectionHeadingClass}>Weekly hours</h2>
        <AdminTable caption="Recurring resource schedules">
          <thead className={theadClass}>
            <tr>
              <th className={cellClass}>Resource</th>
              <th className={cellClass}>Day</th>
              <th className={cellClass}>Hours</th>
              <th className={cellClass}>Effective dates</th>
              <th className={cellClass}>Status</th>
              <th className={cellClass}>Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lh-line">
            {data.schedules.map((schedule) => (
              <tr key={schedule.id}>
                <td className={cellClass}>
                  {resourcesById.get(schedule.resourceId)?.name ?? "Unknown"}
                </td>
                <td className={cellClass}>{weekdays[schedule.weekday - 1]}</td>
                <td className={cellClass}>
                  {schedule.startsAt.slice(0, 5)}–{schedule.endsAt.slice(0, 5)}
                  <p className="text-xs text-lh-muted">{schedule.timezone}</p>
                </td>
                <td className={cellClass}>
                  {schedule.effectiveFrom}
                  {schedule.effectiveUntil
                    ? ` to ${schedule.effectiveUntil}`
                    : " onward"}
                </td>
                <td className={cellClass}>
                  <StatusPill
                    tone={schedule.status === "active" ? "success" : "neutral"}
                  >
                    {schedule.status}
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
                        confirmation="Disable these weekly hours?"
                      >
                        Disable
                      </ConfirmSubmitButton>
                    </form>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      </section>

      <section className="space-y-4">
        <h2 className={sectionHeadingClass}>Exceptions</h2>
        <AdminTable caption="Resource schedule exceptions">
          <thead className={theadClass}>
            <tr>
              <th className={cellClass}>Resource</th>
              <th className={cellClass}>Type</th>
              <th className={cellClass}>When</th>
              <th className={cellClass}>Note</th>
              <th className={cellClass}>Status</th>
              <th className={cellClass}>Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-lh-line">
            {data.exceptions.map((exception) => {
              const resource = resourcesById.get(exception.resourceId);
              return (
                <tr key={exception.id}>
                  <td className={cellClass}>{resource?.name ?? "Unknown"}</td>
                  <td className={cellClass}>{exception.kind}</td>
                  <td className={cellClass}>
                    {formatDate(exception.startsAt, exception.timezone)}
                    <br />
                    to {formatDate(exception.endsAt, exception.timezone)}
                  </td>
                  <td className={cellClass}>{exception.note ?? "—"}</td>
                  <td className={cellClass}>
                    <StatusPill
                      tone={
                        exception.status === "active" ? "success" : "neutral"
                      }
                    >
                      {exception.status}
                    </StatusPill>
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
                          confirmation="Cancel this schedule exception and release its blocked time?"
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
      </section>
    </div>
  );
}

function ResourceField({
  resources,
}: {
  resources: Array<{ id: string; name: string; timezone: string }>;
}) {
  return (
    <Field label="Resource">
      <select className={inputClass} name="resourceId">
        {resources.map((resource) => (
          <option key={resource.id} value={resource.id}>
            {resource.name} ({resource.timezone})
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
function SubmitButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      className="mt-5 rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white"
      type="submit"
    >
      {children}
    </button>
  );
}
function formatDate(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}

const panelClass = "rounded-2xl border border-lh-line bg-white p-6";
const headingClass = "font-heading text-3xl uppercase tracking-[0.08em]";
const sectionHeadingClass = "font-heading text-4xl uppercase tracking-[0.08em]";
const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const secondaryButtonClass =
  "rounded-full border border-lh-line px-3 py-2 text-xs font-semibold";
const theadClass =
  "bg-lh-neutral-2 text-xs uppercase tracking-[0.12em] text-lh-muted";
const cellClass = "px-4 py-3 align-top";

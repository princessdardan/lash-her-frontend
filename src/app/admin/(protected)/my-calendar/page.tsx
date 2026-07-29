import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { redirect } from "next/navigation";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listEmployeeCalendarWorkspace,
  listEmployeeGoogleCalendars,
} from "@/lib/admin/employee-calendar";
import type { GoogleCalendarOption } from "@/lib/booking/google-calendar";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

import {
  createMyCalendarConnectionAction,
  disableMyCalendarAssignmentAction,
  disconnectMyCalendarConnectionAction,
  reconnectMyCalendarConnectionAction,
  saveMyCalendarAssignmentAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission(
    "calendar-connections:self-manage",
  );
  if (actor.user.role !== "employee") {
    redirect("/admin/not-authorized");
  }
  const data = await listEmployeeCalendarWorkspace();
  const contextResourceId = data.resources[0]?.id;
  const discoveredEntries = await Promise.all(
    data.connections.map(async (connection) => {
      if (connection.status !== "active" || !contextResourceId) {
        return [connection.id, [] as GoogleCalendarOption[]] as const;
      }
      try {
        return [
          connection.id,
          await listEmployeeGoogleCalendars({
            connectionId: connection.id,
            resourceId: contextResourceId,
          }),
        ] as const;
      } catch {
        return [connection.id, [] as GoogleCalendarOption[]] as const;
      }
    }),
  );
  const calendarsByConnection = new Map(discoveredEntries);
  const ownedConnectionIds = new Set(
    data.connections.map((connection) => connection.id),
  );
  const ownerManagedAssignments = data.assignments.filter(
    (assignment) => !ownedConnectionIds.has(assignment.connectionId),
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
            Contractor self-service
          </p>
          <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">
            My Calendar
          </h1>
          <p className="mt-3 max-w-3xl text-lh-muted">
            Connect Google accounts you control and choose calendars that block
            your availability. Only the owner or an admin can select where new
            bookings are written.
          </p>
        </div>
        {contextResourceId ? (
          <form
            action={createMyCalendarConnectionAction}
            className="flex gap-2"
          >
            <select
              aria-label="Provider resource for new Google connection"
              className={inputClass}
              name="resourceId"
              required
            >
              {data.resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
            <button className={primaryButtonClass} type="submit">
              Connect Google account
            </button>
          </form>
        ) : null}
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <section className="grid gap-5 xl:grid-cols-2">
        {data.connections.map((connection) => {
          const calendars = calendarsByConnection.get(connection.id) ?? [];
          const assignments = data.assignments.filter(
            (assignment) => assignment.connectionId === connection.id,
          );
          const activeWriteAssignment = assignments.some(
            (assignment) =>
              assignment.status === "active" && assignment.acceptsBookings,
          );

          return (
            <article
              className="rounded-2xl border border-lh-line bg-white p-6"
              key={connection.id}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">
                    {connection.accountEmail ?? "Google account not connected"}
                  </h2>
                  <p className="mt-1 text-sm text-lh-muted">
                    Last verified:{" "}
                    {connection.lastVerifiedAt
                      ? connection.lastVerifiedAt.toLocaleString("en-CA")
                      : "Never"}
                  </p>
                </div>
                <StatusPill
                  tone={
                    connection.status === "active" ? "success" : "attention"
                  }
                >
                  {connection.status}
                </StatusPill>
              </div>

              {contextResourceId ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  <form action={reconnectMyCalendarConnectionAction}>
                    <input
                      name="connectionId"
                      type="hidden"
                      value={connection.id}
                    />
                    <input
                      name="resourceId"
                      type="hidden"
                      value={contextResourceId}
                    />
                    <button className={secondaryButtonClass} type="submit">
                      {connection.status === "active"
                        ? "Reconnect"
                        : "Authorize"}
                    </button>
                  </form>
                  {!activeWriteAssignment &&
                  connection.status !== "disabled" ? (
                    <form action={disconnectMyCalendarConnectionAction}>
                      <input
                        name="connectionId"
                        type="hidden"
                        value={connection.id}
                      />
                      <input
                        name="resourceId"
                        type="hidden"
                        value={contextResourceId}
                      />
                      <ConfirmSubmitButton
                        className={secondaryButtonClass}
                        confirmation="Disconnect this Google account and remove its busy assignments?"
                      >
                        Disconnect
                      </ConfirmSubmitButton>
                    </form>
                  ) : null}
                  {activeWriteAssignment ? (
                    <p className="w-full text-xs text-lh-muted">
                      This account receives bookings. The owner must move that
                      destination before you can disconnect it.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {connection.status === "active" && calendars.length > 0 ? (
                <form
                  action={saveMyCalendarAssignmentAction}
                  className="mt-6 rounded-2xl bg-lh-neutral-2 p-4"
                >
                  <h3 className="font-semibold">Add busy calendar</h3>
                  <input
                    name="connectionId"
                    type="hidden"
                    value={connection.id}
                  />
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Provider resource">
                      <select className={inputClass} name="resourceId" required>
                        {data.resources.map((resource) => (
                          <option key={resource.id} value={resource.id}>
                            {resource.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Google calendar">
                      <select
                        className={inputClass}
                        name="providerCalendarId"
                        required
                      >
                        {calendars.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.label} · {calendar.accessRole}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Display label">
                      <input className={inputClass} name="calendarLabel" />
                    </Field>
                  </div>
                  <p className="mt-3 text-xs text-lh-muted">
                    Contractor assignments always block busy time and never
                    receive bookings.
                  </p>
                  <button
                    className={`${primaryButtonClass} mt-4`}
                    type="submit"
                  >
                    Add busy calendar
                  </button>
                </form>
              ) : null}

              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-lh-muted">
                  Assignments for my resources
                </h3>
                {assignments.map((assignment) => {
                  const employeeMayDisable =
                    assignment.status === "active" &&
                    !assignment.acceptsBookings &&
                    assignment.connectionOwnerAdminUserId === actor.user.id;
                  return (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm"
                      key={assignment.id}
                    >
                      <div>
                        <p className="font-semibold">
                          {assignment.resourceName} ·{" "}
                          {assignment.calendarLabel ??
                            assignment.providerCalendarId}
                        </p>
                        <p className="text-xs text-lh-muted">
                          {assignment.acceptsBookings
                            ? "Receives bookings and blocks busy time"
                            : "Blocks busy time"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill
                          tone={
                            assignment.status === "active"
                              ? "success"
                              : "neutral"
                          }
                        >
                          {assignment.status}
                        </StatusPill>
                        {employeeMayDisable ? (
                          <form action={disableMyCalendarAssignmentAction}>
                            <input
                              name="assignmentId"
                              type="hidden"
                              value={assignment.id}
                            />
                            <input
                              name="resourceId"
                              type="hidden"
                              value={assignment.resourceId}
                            />
                            <ConfirmSubmitButton
                              className={secondaryButtonClass}
                              confirmation="Remove this busy calendar assignment?"
                            >
                              Remove
                            </ConfirmSubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {assignments.length === 0 ? (
                  <p className="text-sm text-lh-muted">
                    No calendars assigned.
                  </p>
                ) : null}
              </div>
            </article>
          );
        })}
        {data.connections.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">
            No contractor-owned Google Calendar accounts are connected.
          </p>
        ) : null}
      </section>

      {ownerManagedAssignments.length > 0 ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <h2 className="text-xl font-semibold">Owner-managed assignments</h2>
          <p className="mt-2 text-sm text-lh-muted">
            These calendars apply to your assigned resources, but their Google
            connections are managed by the owner or an admin.
          </p>
          <div className="mt-5 space-y-3">
            {ownerManagedAssignments.map((assignment) => (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm"
                key={assignment.id}
              >
                <div>
                  <p className="font-semibold">
                    {assignment.resourceName} ·{" "}
                    {assignment.calendarLabel ?? assignment.providerCalendarId}
                  </p>
                  <p className="text-xs text-lh-muted">
                    {assignment.connectionAccountEmail ??
                      "Admin-managed account"}
                    {" · "}
                    {assignment.acceptsBookings
                      ? "Receives bookings and blocks busy time"
                      : "Blocks busy time"}
                  </p>
                </div>
                <StatusPill
                  tone={assignment.status === "active" ? "success" : "neutral"}
                >
                  {assignment.status}
                </StatusPill>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
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

const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "inline-flex rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white";
const secondaryButtonClass =
  "inline-flex rounded-full border border-lh-line px-3 py-2 text-xs font-semibold";

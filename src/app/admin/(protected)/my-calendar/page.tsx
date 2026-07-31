import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import {
  CalendarAssignmentForm,
  type CurrentBookingDestinationOption,
} from "@/components/admin/calendar-assignment-form";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listEmployeeCalendarWorkspace,
  listEmployeeGoogleCalendars,
} from "@/lib/admin/employee-calendar";
import {
  loadCalendarDiscoveryResult,
  type CalendarDiscoveryResult,
} from "@/lib/admin/calendar-discovery-result";
import type { GoogleCalendarOption } from "@/lib/booking/google-calendar";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  getCalendarAssignmentStatusPresentation,
  getCalendarConnectionStatusPresentation,
} from "@/lib/admin/presentation";

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
    resource?: string | string[];
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
  const requestedResourceId = firstString(feedback.resource);
  const contextResource =
    data.resources.find((resource) => resource.id === requestedResourceId) ??
    data.resources[0];
  const contextResourceId = contextResource?.id;
  const discoveredEntries: Array<
    readonly [string, CalendarDiscoveryResult<GoogleCalendarOption>]
  > = await Promise.all(
    data.connections.map(async (connection) => {
      if (connection.status !== "active" || !contextResourceId) {
        return [
          connection.id,
          { calendars: [], kind: "ready" } as const,
        ] as const;
      }
      return [
        connection.id,
        await loadCalendarDiscoveryResult(() =>
          listEmployeeGoogleCalendars({
            connectionId: connection.id,
            resourceId: contextResourceId,
          }),
        ),
      ] as const;
    }),
  );
  const discoveryByConnection = new Map(discoveredEntries);
  const ownedConnectionIds = new Set(
    data.connections.map((connection) => connection.id),
  );
  const ownerManagedAssignments = data.assignments.filter(
    (assignment) =>
      assignment.resourceId === contextResourceId &&
      !ownedConnectionIds.has(assignment.connectionId),
  );
  const currentDestinations: CurrentBookingDestinationOption[] =
    data.assignments
      .filter((assignment) => assignment.acceptsBookings)
      .map((assignment) => ({
        assignmentId: assignment.id,
        calendarLabel: assignment.calendarLabel ?? "Unnamed Google calendar",
        connectionId: assignment.connectionId,
        connectionLabel:
          assignment.connectionAccountEmail ?? "Lash Her managed account",
        providerCalendarId: assignment.providerCalendarId,
        resourceId: assignment.resourceId,
        resourceName: assignment.resourceName,
      }));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
            Daily work
          </p>
          <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] sm:text-5xl lg:text-6xl">
            My availability
          </h1>
          <p className="mt-3 max-w-3xl text-lh-muted">
            Review your hours, connect personal calendars, and choose where new
            bookings for your assigned provider profile should be added.
          </p>
        </div>
        {contextResourceId ? (
          <div className="flex flex-wrap gap-2">
            <Link
              className={secondaryButtonClass}
              href={`/admin/schedules?resource=${encodeURIComponent(contextResourceId)}`}
            >
              View hours and time off
            </Link>
            <form action={createMyCalendarConnectionAction}>
              <input
                name="resourceId"
                type="hidden"
                value={contextResourceId}
              />
              <AdminSubmitButton
                className={primaryButtonClass}
                pendingLabel="Connecting…"
              >
                Connect Google account
              </AdminSubmitButton>
            </form>
          </div>
        ) : null}
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {data.resources.length > 1 && contextResourceId ? (
        <form
          action="/admin/my-calendar"
          className="flex max-w-xl flex-col gap-2 rounded-2xl border border-lh-line bg-white p-4 sm:flex-row sm:items-end"
          method="get"
        >
          <Field label="Availability for">
            <select
              className={inputClass}
              defaultValue={contextResourceId}
              name="resource"
            >
              {data.resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name}
                </option>
              ))}
            </select>
          </Field>
          <button className={secondaryButtonClass} type="submit">
            Switch resource
          </button>
        </form>
      ) : null}

      {contextResource ? (
        <p className="text-sm text-lh-muted">
          Showing calendars for {contextResource.name}.
        </p>
      ) : null}

      <section className="grid gap-5 xl:grid-cols-2">
        {data.connections.map((connection) => {
          const discovery = discoveryByConnection.get(connection.id) ?? {
            kind: "error" as const,
          };
          const assignments = data.assignments.filter(
            (assignment) =>
              assignment.resourceId === contextResourceId &&
              assignment.connectionId === connection.id,
          );
          const activeWriteAssignment = assignments.some(
            (assignment) =>
              assignment.status === "active" && assignment.acceptsBookings,
          );
          const connectionStatus =
            connection.status === "active" && discovery.kind === "error"
              ? { label: "Calendar check failed", tone: "attention" as const }
              : getCalendarConnectionStatusPresentation(connection.status);

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
                <StatusPill tone={connectionStatus.tone}>
                  {connectionStatus.label}
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
                    <AdminSubmitButton
                      className={secondaryButtonClass}
                      pendingLabel="Reconnecting…"
                    >
                      {connection.status === "active"
                        ? "Reconnect"
                        : "Authorize"}
                    </AdminSubmitButton>
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
                        confirmation={`Disconnect ${connection.accountEmail ?? "this Google account"} and remove its ${assignments.length} busy calendar assignment${assignments.length === 1 ? "" : "s"}?`}
                      >
                        Disconnect
                      </ConfirmSubmitButton>
                    </form>
                  ) : null}
                  {activeWriteAssignment ? (
                    <p className="w-full text-xs text-lh-muted">
                      This account receives bookings. Move that destination to
                      another calendar before disconnecting it.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {connection.status === "active" ? (
                discovery.kind === "error" ? (
                  <div
                    className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
                    role="alert"
                  >
                    Calendars could not be checked. Retry this page or reconnect
                    the Google account before assigning a calendar.
                  </div>
                ) : discovery.calendars.length === 0 ? (
                  <p
                    className="mt-6 rounded-2xl border border-lh-line bg-lh-neutral-2 p-4 text-sm text-lh-muted"
                    role="status"
                  >
                    No calendars were found for this Google account. Check its
                    calendar access or reconnect it.
                  </p>
                ) : (
                  <CalendarAssignmentForm
                    action={saveMyCalendarAssignmentAction}
                    calendars={discovery.calendars}
                    connectionId={connection.id}
                    connectionLabel={
                      connection.accountEmail ?? "Personal Google account"
                    }
                    currentDestinations={currentDestinations}
                    resources={contextResource ? [contextResource] : []}
                  />
                )
              ) : null}

              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-lh-muted">
                  Calendars for {contextResource?.name ?? "this availability"}
                </h3>
                {assignments.map((assignment) => {
                  const employeeMayDisable =
                    assignment.status === "active" &&
                    !assignment.acceptsBookings &&
                    assignment.connectionOwnerAdminUserId === actor.user.id;
                  const assignmentStatus =
                    getCalendarAssignmentStatusPresentation(assignment.status);
                  return (
                    <div
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm"
                      key={assignment.id}
                    >
                      <div>
                        <p className="font-semibold">
                          {assignment.resourceName} ·{" "}
                          {assignment.calendarLabel ?? "Google calendar"}
                        </p>
                        <p className="text-xs text-lh-muted">
                          {assignment.acceptsBookings
                            ? "Receives bookings and blocks busy time"
                            : "Blocks busy time"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={assignmentStatus.tone}>
                          {assignmentStatus.label}
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
                              confirmation={`Remove ${assignment.calendarLabel ?? "this Google calendar"} from ${assignment.resourceName}? It will no longer block busy time.`}
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
            No Google Calendar accounts are connected for your availability.
          </p>
        ) : null}
      </section>

      {ownerManagedAssignments.length > 0 ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <h2 className="text-xl font-semibold">Managed by Lash Her</h2>
          <p className="mt-2 text-sm text-lh-muted">
            These calendars apply to your provider profile, but their Google
            connections are controlled by the owner or an administrator.
          </p>
          <div className="mt-5 space-y-3">
            {ownerManagedAssignments.map((assignment) => {
              const assignmentStatus = getCalendarAssignmentStatusPresentation(
                assignment.status,
              );
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm"
                  key={assignment.id}
                >
                  <div>
                    <p className="font-semibold">
                      {assignment.resourceName} ·{" "}
                      {assignment.calendarLabel ?? "Google calendar"}
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
                  <StatusPill tone={assignmentStatus.tone}>
                    {assignmentStatus.label}
                  </StatusPill>
                </div>
              );
            })}
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

function firstString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-wait disabled:opacity-60";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-3 py-2 text-xs font-semibold disabled:cursor-wait disabled:opacity-60";

import Link from "next/link";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import {
  CalendarAssignmentForm,
  type CurrentBookingDestinationOption,
} from "@/components/admin/calendar-assignment-form";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import {
  listConnectedGoogleCalendars,
  type AdminGoogleCalendarOption,
} from "@/lib/admin/calendar-discovery";
import {
  loadCalendarDiscoveryResult,
  type CalendarDiscoveryResult,
} from "@/lib/admin/calendar-discovery-result";
import { listAdminCalendarConnections } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import {
  getBookingConfigurationStatusPresentation,
  getCalendarAssignmentStatusPresentation,
  getCalendarConnectionStatusPresentation,
} from "@/lib/admin/presentation";

import {
  createCalendarConnectionAction,
  disableCalendarAssignmentAction,
  disableCalendarConnectionAction,
  saveCalendarAssignmentAction,
  transferCalendarConnectionOwnershipAction,
} from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminCalendarConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("calendar-connections:view");
  const data = await listAdminCalendarConnections();
  const canManage = canAdmin({
    action: "calendar-connections:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const discoveredEntries: Array<
    readonly [string, CalendarDiscoveryResult<AdminGoogleCalendarOption>]
  > = await Promise.all(
    data.connections.map(async (connection) => {
      if (connection.status !== "active") {
        return [
          connection.id,
          { calendars: [], kind: "ready" } as const,
        ] as const;
      }
      return [
        connection.id,
        await loadCalendarDiscoveryResult(() =>
          listConnectedGoogleCalendars(connection.id),
        ),
      ] as const;
    }),
  );
  const discoveryByConnection = new Map(discoveredEntries);
  const connectionById = new Map(
    data.connections.map((connection) => [connection.id, connection]),
  );
  const visibleResources = data.resources.filter(
    (resource) => resource.status !== "archived",
  );
  const currentDestinations: CurrentBookingDestinationOption[] =
    data.assignments
      .filter(
        (assignment) =>
          assignment.status === "active" && assignment.acceptsBookings,
      )
      .map((assignment) => ({
        assignmentId: assignment.id,
        calendarLabel: getCalendarName(assignment.calendarLabel),
        connectionId: assignment.connectionId,
        connectionLabel:
          connectionById.get(assignment.connectionId)?.accountEmail ??
          "Google account",
        providerCalendarId: assignment.providerCalendarId,
        resourceId: assignment.resourceId,
        resourceName: assignment.resourceName,
      }));

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
            Availability
          </p>
          <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] sm:text-5xl lg:text-6xl">
            Calendar sync
          </h1>
          <p className="mt-3 max-w-3xl text-lh-muted">
            Review where new appointments are added and which calendars block
            unavailable times for each provider.
          </p>
        </div>
        {canManage ? (
          <form action={createCalendarConnectionAction}>
            <AdminSubmitButton
              className={primaryButtonClass}
              pendingLabel="Connecting…"
            >
              Connect Google account
            </AdminSubmitButton>
          </form>
        ) : null}
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <section aria-labelledby="resource-calendar-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2
              className="font-heading text-3xl uppercase tracking-[0.08em]"
              id="resource-calendar-heading"
            >
              Providers
            </h2>
            <p className="mt-2 text-sm text-lh-muted">
              A booking destination receives new appointments. Busy calendars
              prevent appointments from being offered during existing events.
            </p>
          </div>
          {data.connections.length > 0 ? (
            <a
              className={secondaryButtonClass}
              href="#calendar-account-management"
            >
              Manage accounts
            </a>
          ) : null}
        </div>

        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {visibleResources.map((resource) => {
            const assignments = data.assignments.filter(
              (assignment) =>
                assignment.resourceId === resource.id &&
                assignment.status === "active",
            );
            const destination =
              assignments.find((assignment) => assignment.acceptsBookings) ??
              null;
            const destinationConnection = destination
              ? connectionById.get(destination.connectionId)
              : undefined;
            const assignedConnections = [
              ...new Set(
                assignments.map((assignment) => assignment.connectionId),
              ),
            ]
              .map((connectionId) => connectionById.get(connectionId))
              .filter((connection) => connection !== undefined);
            const failedDiscovery = assignedConnections.some(
              (connection) =>
                connection.status === "active" &&
                discoveryByConnection.get(connection.id)?.kind === "error",
            );
            const unhealthyConnection = assignedConnections.some(
              (connection) => connection.status !== "active",
            );
            const missingConnection = assignments.some(
              (assignment) => !connectionById.has(assignment.connectionId),
            );
            const health =
              resource.status !== "active"
                ? { label: "Not available online", tone: "neutral" as const }
                : destination === null
                  ? {
                      label: "Booking destination missing",
                      tone: "attention" as const,
                    }
                  : destinationConnection?.status !== "active" ||
                      unhealthyConnection ||
                      missingConnection ||
                      !destination.contributesBusy
                    ? {
                        label: "Connection needs attention",
                        tone: "attention" as const,
                      }
                    : failedDiscovery
                      ? {
                          label: "Calendar check failed",
                          tone: "attention" as const,
                        }
                      : { label: "Ready", tone: "success" as const };
            const resourceStatus = getBookingConfigurationStatusPresentation(
              resource.status,
            );

            return (
              <article
                className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6"
                key={resource.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-lh-muted">
                      Provider
                    </p>
                    <h3 className="mt-1 text-xl font-semibold">
                      {resource.name}
                    </h3>
                  </div>
                  <StatusPill tone={health.tone}>{health.label}</StatusPill>
                </div>

                {resource.status !== "active" ? (
                  <p className="mt-4 rounded-xl bg-lh-neutral-2 p-3 text-sm text-lh-muted">
                    This provider is {resourceStatus.label.toLowerCase()} and is
                    not currently offered for online booking.
                  </p>
                ) : null}

                <div className="mt-5 rounded-xl border border-lh-line p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-lh-muted">
                    Booking destination
                  </p>
                  {destination ? (
                    <>
                      <p className="mt-2 font-semibold">
                        {getCalendarName(destination.calendarLabel)}
                      </p>
                      <p className="mt-1 text-sm text-lh-muted">
                        New appointments are added to this calendar.
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-sm text-lh-muted">
                      No booking destination is set. Online bookings cannot be
                      accepted until one is selected.
                    </p>
                  )}
                </div>

                <div className="mt-5">
                  <h4 className="text-sm font-semibold">Busy calendars</h4>
                  {assignments.some(
                    (assignment) => assignment.contributesBusy,
                  ) ? (
                    <ul className="mt-2 space-y-2">
                      {assignments
                        .filter((assignment) => assignment.contributesBusy)
                        .map((assignment) => (
                          <li
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-lh-neutral-2 px-3 py-3 text-sm"
                            key={assignment.id}
                          >
                            <span className="font-medium">
                              {getCalendarName(assignment.calendarLabel)}
                            </span>
                            <span className="text-xs text-lh-muted">
                              {assignment.acceptsBookings
                                ? "Also receives bookings"
                                : "Blocks unavailable times"}
                            </span>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-lh-muted">
                      No calendars currently block unavailable times.
                    </p>
                  )}
                </div>

                {failedDiscovery ? (
                  <p
                    className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                    role="alert"
                  >
                    Google calendars could not be checked. Reconnect the
                    affected account before changing this calendar setup.
                  </p>
                ) : null}
                {!failedDiscovery &&
                resource.status === "active" &&
                destination !== null &&
                (destinationConnection?.status !== "active" ||
                  unhealthyConnection ||
                  missingConnection ||
                  !destination.contributesBusy) ? (
                  <p
                    className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                    role="alert"
                  >
                    One of these calendars needs to be reconnected or reassigned
                    before online availability can be trusted.
                  </p>
                ) : null}

                {data.connections.length > 0 ? (
                  <a
                    className={`${secondaryButtonClass} mt-5`}
                    href="#calendar-account-management"
                  >
                    Change calendar setup
                  </a>
                ) : canManage ? (
                  <p className="mt-4 text-sm text-lh-muted">
                    Connect a Google account to finish this setup.
                  </p>
                ) : null}
              </article>
            );
          })}
          {visibleResources.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted xl:col-span-2">
              <p>No provider accounts are configured.</p>
              <Link
                className={`${secondaryButtonClass} mt-4`}
                href="/admin/staff"
              >
                View Team
              </Link>
            </div>
          ) : null}
        </div>
      </section>

      <details
        className="rounded-2xl border border-lh-line bg-white"
        id="calendar-account-management"
      >
        <summary className="flex min-h-11 cursor-pointer items-center px-5 py-4 font-semibold sm:px-6">
          Advanced account management
        </summary>
        <div className="border-t border-lh-line p-5 sm:p-6">
          <p className="max-w-3xl text-sm text-lh-muted">
            Connect or reconnect Google accounts, choose who manages each
            account, and change calendar assignments.
          </p>

          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            {data.connections.map((connection) => {
              const discovery = discoveryByConnection.get(connection.id) ?? {
                kind: "error" as const,
              };
              const assignments = data.assignments.filter(
                (row) => row.connectionId === connection.id,
              );
              const bookingDestinations = assignments.filter(
                (assignment) =>
                  assignment.status === "active" && assignment.acceptsBookings,
              );
              const connectionStatus =
                connection.status === "active" && discovery.kind === "error"
                  ? {
                      label: "Calendar check failed",
                      tone: "attention" as const,
                    }
                  : getCalendarConnectionStatusPresentation(connection.status);

              return (
                <article
                  className="rounded-2xl border border-lh-line p-5"
                  key={connection.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold">
                        {connection.accountEmail ??
                          "Google account not connected"}
                      </h3>
                      <p className="mt-1 text-sm text-lh-muted">
                        Last checked:{" "}
                        {connection.lastVerifiedAt
                          ? connection.lastVerifiedAt.toLocaleString("en-CA")
                          : "Not yet checked"}
                      </p>
                    </div>
                    <StatusPill tone={connectionStatus.tone}>
                      {connectionStatus.label}
                    </StatusPill>
                  </div>

                  {canManage ? (
                    <form
                      action={transferCalendarConnectionOwnershipAction}
                      className="mt-4 rounded-xl border border-lh-line p-3"
                    >
                      <input
                        name="connectionId"
                        type="hidden"
                        value={connection.id}
                      />
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <Field label="Managed by">
                          <select
                            className={inputClass}
                            defaultValue={
                              connection.credentialOwnerAdminUserId ?? ""
                            }
                            name="employeeUserId"
                          >
                            <option value="">Owner/admin team</option>
                            {data.employees.map((employee) => (
                              <option key={employee.id} value={employee.id}>
                                {employee.displayName ?? employee.email}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <ConfirmSubmitButton
                          className={secondaryButtonClass}
                          confirmation={`Change who manages ${connection.accountEmail ?? "this Google account"}? Confirm that all calendars assigned through it belong to the selected person.`}
                        >
                          Save account manager
                        </ConfirmSubmitButton>
                      </div>
                    </form>
                  ) : null}

                  {canManage ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {connection.status !== "disabled" ? (
                        <Link
                          className={secondaryButtonClass}
                          href={`/api/admin/calendar-connections/${connection.id}/oauth/start?returnTo=/admin/calendar-connections`}
                        >
                          {connection.status === "active"
                            ? "Reconnect"
                            : "Authorize"}
                        </Link>
                      ) : null}
                      {connection.status !== "disabled" ? (
                        bookingDestinations.length === 0 ? (
                          <form action={disableCalendarConnectionAction}>
                            <input
                              name="connectionId"
                              type="hidden"
                              value={connection.id}
                            />
                            <ConfirmSubmitButton
                              className={secondaryButtonClass}
                              confirmation={`Disable ${connection.accountEmail ?? "this Google account"} and remove its ${assignments.length} active calendar assignment${assignments.length === 1 ? "" : "s"}?`}
                            >
                              Disable account
                            </ConfirmSubmitButton>
                          </form>
                        ) : (
                          <p className="w-full text-xs text-lh-muted">
                            Move the booking destination for{" "}
                            {formatResourceNames(
                              bookingDestinations.map(
                                (assignment) => assignment.resourceName,
                              ),
                            )}{" "}
                            before disabling this account.
                          </p>
                        )
                      ) : null}
                    </div>
                  ) : null}

                  {canManage && connection.status === "active" ? (
                    discovery.kind === "error" ? (
                      <div
                        className="mt-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
                        role="alert"
                      >
                        Calendars could not be checked. Retry this page or
                        reconnect the Google account before assigning a
                        calendar.
                      </div>
                    ) : discovery.calendars.length === 0 ? (
                      <p
                        className="mt-5 rounded-xl border border-lh-line bg-lh-neutral-2 p-4 text-sm text-lh-muted"
                        role="status"
                      >
                        No calendars were found for this Google account. Check
                        its calendar access or reconnect it.
                      </p>
                    ) : (
                      <CalendarAssignmentForm
                        action={saveCalendarAssignmentAction}
                        calendars={discovery.calendars}
                        connectionId={connection.id}
                        connectionLabel={
                          connection.accountEmail ?? "Google account"
                        }
                        currentDestinations={currentDestinations}
                        resources={visibleResources}
                      />
                    )
                  ) : null}

                  <div className="mt-5 space-y-3">
                    <h4 className="text-sm font-semibold">
                      Calendars assigned through this account
                    </h4>
                    {assignments.map((assignment) => {
                      const assignmentStatus =
                        getCalendarAssignmentStatusPresentation(
                          assignment.status,
                        );
                      return (
                        <div
                          className="rounded-xl border border-lh-line p-3 text-sm"
                          key={assignment.id}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-semibold">
                                {assignment.resourceName} ·{" "}
                                {getCalendarName(assignment.calendarLabel)}
                              </p>
                              <p className="mt-1 text-xs text-lh-muted">
                                {assignment.acceptsBookings
                                  ? "Receives bookings and blocks unavailable times"
                                  : "Blocks unavailable times"}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill tone={assignmentStatus.tone}>
                                {assignmentStatus.label}
                              </StatusPill>
                              {canManage &&
                              assignment.status === "active" &&
                              !assignment.acceptsBookings ? (
                                <form action={disableCalendarAssignmentAction}>
                                  <input
                                    name="assignmentId"
                                    type="hidden"
                                    value={assignment.id}
                                  />
                                  <ConfirmSubmitButton
                                    className={secondaryButtonClass}
                                    confirmation={`Disable ${getCalendarName(assignment.calendarLabel)} for ${assignment.resourceName}? It will no longer block unavailable times.`}
                                  >
                                    Disable
                                  </ConfirmSubmitButton>
                                </form>
                              ) : canManage &&
                                assignment.status === "active" &&
                                assignment.acceptsBookings ? (
                                <span className="max-w-44 text-right text-xs text-lh-muted">
                                  Move the booking destination before disabling.
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <details className="mt-3 text-xs text-lh-muted">
                            <summary className="min-h-11 cursor-pointer py-3 font-semibold text-lh-shadow">
                              System details
                            </summary>
                            <dl className="grid gap-2 break-all sm:grid-cols-[9rem_1fr]">
                              <dt>Calendar ID</dt>
                              <dd>{assignment.providerCalendarId}</dd>
                              <dt>Assignment ID</dt>
                              <dd>{assignment.id}</dd>
                            </dl>
                          </details>
                        </div>
                      );
                    })}
                    {assignments.length === 0 ? (
                      <p className="text-sm text-lh-muted">
                        No calendars are assigned through this account.
                      </p>
                    ) : null}
                  </div>

                  <details className="mt-4 border-t border-lh-line pt-3 text-xs text-lh-muted">
                    <summary className="min-h-11 cursor-pointer py-3 font-semibold text-lh-shadow">
                      System details
                    </summary>
                    <dl className="grid gap-2 break-all sm:grid-cols-[9rem_1fr]">
                      <dt>Connection ID</dt>
                      <dd>{connection.id}</dd>
                      <dt>Account manager</dt>
                      <dd>
                        {connection.ownerDisplayName ??
                          connection.ownerEmail ??
                          "Owner/admin team"}
                      </dd>
                      {connection.lastErrorCode ? (
                        <>
                          <dt>Last reported issue</dt>
                          <dd>{connection.lastErrorCode}</dd>
                        </>
                      ) : null}
                    </dl>
                  </details>
                </article>
              );
            })}
            {data.connections.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-lh-line p-6 text-lh-muted xl:col-span-2">
                No Google accounts are connected. Connect an account to assign
                calendars.
              </p>
            ) : null}
          </div>
        </div>
      </details>
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
    <label className="block flex-1 text-sm font-semibold">
      <span className="mb-2 block">{label}</span>
      {children}
    </label>
  );
}

function getCalendarName(calendarLabel: string | null): string {
  const label = calendarLabel?.trim();
  return label || "Unnamed Google calendar";
}

function formatResourceNames(resourceNames: string[]): string {
  const names = [...new Set(resourceNames)];
  if (names.length <= 1) return names[0] ?? "this resource";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

const inputClass =
  "min-h-11 w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-wait disabled:opacity-60";
const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-4 py-2 text-xs font-semibold transition hover:bg-lh-neutral-2 disabled:cursor-wait disabled:opacity-60";

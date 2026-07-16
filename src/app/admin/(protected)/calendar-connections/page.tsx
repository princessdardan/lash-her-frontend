import Link from "next/link";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import {
  canGoogleCalendarAcceptBookings,
  listConnectedGoogleCalendars,
  type AdminGoogleCalendarOption,
} from "@/lib/admin/calendar-discovery";
import { listAdminCalendarConnections } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

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
  searchParams: Promise<{ error?: string | string[]; notice?: string | string[] }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("calendar-connections:view");
  const data = await listAdminCalendarConnections();
  const canManage = canAdmin({
    action: "calendar-connections:manage",
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const discoveredEntries: Array<readonly [string, AdminGoogleCalendarOption[]]> = await Promise.all(data.connections.map(async (connection) => {
    if (connection.status !== "active") return [connection.id, [] as AdminGoogleCalendarOption[]] as const;
    try {
      return [connection.id, await listConnectedGoogleCalendars(connection.id)] as const;
    } catch {
      return [connection.id, [] as AdminGoogleCalendarOption[]] as const;
    }
  }));
  const calendarsByConnection = new Map(discoveredEntries);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">Private integrations</p>
          <h1 className="mt-2 font-heading text-6xl uppercase tracking-[0.08em]">Calendar connections</h1>
          <p className="mt-3 max-w-3xl text-lh-muted">Connect a Google account, then assign one or more canonical calendars to each booking resource. One active calendar receives bookings; any number can contribute busy time.</p>
        </div>
        {canManage ? <form action={createCalendarConnectionAction}><button className={primaryButtonClass} type="submit">Connect Google account</button></form> : null}
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      <section className="grid gap-5 xl:grid-cols-2">
        {data.connections.map((connection) => {
          const calendars = calendarsByConnection.get(connection.id) ?? [];
          const assignments = data.assignments.filter((row) => row.connectionId === connection.id);
          return (
            <article key={connection.id} className="rounded-2xl border border-lh-line bg-white p-6">
              <div className="flex items-start justify-between gap-4">
                <div><h2 className="text-xl font-semibold">{connection.accountEmail ?? "Google account not connected"}</h2><p className="mt-1 text-xs text-lh-muted">{connection.id}</p></div>
                <StatusPill tone={connection.status === "active" ? "success" : connection.status === "reconnect_required" ? "attention" : "neutral"}>{connection.status}</StatusPill>
              </div>
              <p className="mt-3 text-sm text-lh-muted">Last verified: {connection.lastVerifiedAt ? connection.lastVerifiedAt.toLocaleString("en-CA") : "Never"}{connection.lastErrorCode ? ` · ${connection.lastErrorCode}` : ""}</p>
              <p className="mt-2 text-sm text-lh-muted">
                Credential owner: {connection.ownerDisplayName ?? connection.ownerEmail ?? "Owner/admin managed"}
              </p>

              {canManage ? (
                <form action={transferCalendarConnectionOwnershipAction} className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-lh-line p-3">
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <Field label="Credential ownership">
                    <select className={inputClass} name="employeeUserId" defaultValue={connection.credentialOwnerAdminUserId ?? ""}>
                      <option value="">Owner/admin managed</option>
                      {data.employees.map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.displayName ?? employee.email}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <ConfirmSubmitButton className={secondaryButtonClass} confirmation="Transfer this connection only if every active assignment belongs to the selected employee?">Update owner</ConfirmSubmitButton>
                </form>
              ) : null}

              {canManage ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {connection.status !== "disabled" ? <Link className={secondaryButtonClass} href={`/api/admin/calendar-connections/${connection.id}/oauth/start?returnTo=/admin/calendar-connections`}>{connection.status === "active" ? "Reconnect" : "Authorize"}</Link> : null}
                  {connection.status !== "disabled" ? <form action={disableCalendarConnectionAction}><input type="hidden" name="connectionId" value={connection.id} /><ConfirmSubmitButton className={secondaryButtonClass} confirmation="Disable this connection and all of its calendar assignments?">Disable connection</ConfirmSubmitButton></form> : null}
                </div>
              ) : null}

              {canManage && connection.status === "active" ? (
                <form action={saveCalendarAssignmentAction} className="mt-6 rounded-2xl bg-lh-neutral-2 p-4">
                  <h3 className="font-semibold">Assign calendar</h3>
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="Resource"><select className={inputClass} name="resourceId">{data.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></Field>
                    {calendars.length > 0 ? (
                      <Field label="Google calendar"><select className={inputClass} name="providerCalendarId">{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.label}{calendar.primary ? " (primary)" : ""} · {canGoogleCalendarAcceptBookings(calendar.accessRole) ? calendar.accessRole : `${calendar.accessRole} (busy only)`}</option>)}</select></Field>
                    ) : (
                      <Field label="Canonical calendar ID"><input className={inputClass} name="providerCalendarId" required placeholder="name@example.com" /></Field>
                    )}
                    <Field label="Display label"><input className={inputClass} name="calendarLabel" /></Field>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-5 text-sm">
                    <label className="flex items-center gap-2"><input name="contributesBusy" type="checkbox" defaultChecked /> Blocks busy time</label>
                    <label className="flex items-center gap-2"><input name="acceptsBookings" type="checkbox" /> Receives new bookings</label>
                  </div>
                  <button className={`${primaryButtonClass} mt-4`} type="submit">Save assignment</button>
                </form>
              ) : null}

              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-lh-muted">Assignments</h3>
                {assignments.map((assignment) => (
                  <div key={assignment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lh-line p-3 text-sm">
                    <div><p className="font-semibold">{assignment.resourceName} · {assignment.calendarLabel ?? assignment.providerCalendarId}</p><p className="text-xs text-lh-muted">{assignment.contributesBusy ? "Busy" : ""}{assignment.acceptsBookings ? " · Receives bookings" : ""}</p></div>
                    <div className="flex items-center gap-2"><StatusPill tone={assignment.status === "active" ? "success" : "neutral"}>{assignment.status}</StatusPill>{canManage && assignment.status === "active" ? <form action={disableCalendarAssignmentAction}><input type="hidden" name="assignmentId" value={assignment.id} /><ConfirmSubmitButton className={secondaryButtonClass} confirmation="Disable this calendar assignment?">Disable</ConfirmSubmitButton></form> : null}</div>
                  </div>
                ))}
                {assignments.length === 0 ? <p className="text-sm text-lh-muted">No resources assigned.</p> : null}
              </div>
            </article>
          );
        })}
        {data.connections.length === 0 ? <p className="rounded-2xl border border-dashed border-lh-line bg-white p-6 text-lh-muted">No Google Calendar connections. Connect the owner&apos;s account to begin.</p> : null}
      </section>
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) { return <label className="block text-sm font-semibold"><span className="mb-2 block">{label}</span>{children}</label>; }
const inputClass = "w-full rounded-xl border border-lh-line bg-white px-3 py-2 text-sm";
const primaryButtonClass = "inline-flex rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white";
const secondaryButtonClass = "inline-flex rounded-full border border-lh-line px-3 py-2 text-xs font-semibold";

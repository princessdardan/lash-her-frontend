import { notFound } from "next/navigation";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { toAdminAppointmentSnapshotPresentation } from "@/lib/admin/appointment-presentation";
import { getAdminAppointmentDetail } from "@/lib/admin/operations-read";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";

import { setAppointmentAttendanceStatusAction } from "../../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminAppointmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  await requireAdminPagePermission("bookings:view");
  const feedback = await searchParams;
  const { id } = await params;
  const appointment = await getAdminAppointmentDetail(id);
  if (!appointment) notFound();
  const attendanceCanBeRecorded =
    appointment.status === "confirmed" && appointment.selectedEnd <= new Date();
  const snapshotPresentation = toAdminAppointmentSnapshotPresentation({
    intake: appointment.intakeSnapshot,
    offering: appointment.offeringSnapshot,
    provider: appointment.providerSnapshot,
  });

  return (
    <div className="space-y-6">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Appointment
        </p>
        <h1 className="mt-2 font-heading text-5xl uppercase tracking-[0.08em]">
          {appointment.publicReference}
        </h1>
      </header>
      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Customer">
          <Detail label="Name" value={appointment.customerName} />
          <Detail label="Email" value={appointment.customerEmail} />
          <Detail
            label="Phone"
            value={appointment.customerPhone ?? "Not provided"}
          />
        </Section>
        <Section title="Booking">
          <Detail label="Provider" value={appointment.providerDisplayName} />
          <Detail
            label="When"
            value={`${formatDate(appointment.selectedStart, appointment.timezone)} to ${formatTime(appointment.selectedEnd, appointment.timezone)}`}
          />
          <Detail label="Status" value={appointment.status} />
          <Detail label="Origin" value={appointment.origin} />
        </Section>
        <Section title="Payment & calendar">
          <Detail label="Payment" value={appointment.paymentStatus} />
          <Detail
            label="Calendar sync"
            value={appointment.calendarSyncStatus}
          />
          <Detail
            label="Last calendar error"
            value={appointment.calendarSyncLastErrorCode ?? "None"}
          />
          <Detail
            label="Cancellation reason"
            value={appointment.cancellationReason ?? "None"}
          />
        </Section>
        <Section title="Immutable booking snapshot">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-lh-neutral-2 p-4 text-xs">
            {JSON.stringify(snapshotPresentation, null, 2)}
          </pre>
        </Section>
      </div>
      {attendanceCanBeRecorded ? (
        <section className="rounded-2xl border border-lh-line bg-white p-6">
          <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
            Record attendance
          </h2>
          <p className="mt-2 text-sm text-lh-muted">
            These actions update attendance only. Marking a no-show does not
            charge the customer.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <form action={setAppointmentAttendanceStatusAction}>
              <input
                type="hidden"
                name="appointmentId"
                value={appointment.id}
              />
              <input type="hidden" name="status" value="completed" />
              <button
                className="rounded-full bg-lh-charcoal px-5 py-2 text-sm font-semibold text-white"
                type="submit"
              >
                Mark completed
              </button>
            </form>
            <form action={setAppointmentAttendanceStatusAction}>
              <input
                type="hidden"
                name="appointmentId"
                value={appointment.id}
              />
              <input type="hidden" name="status" value="no_show" />
              <ConfirmSubmitButton
                className="rounded-full border border-lh-line px-5 py-2 text-sm font-semibold"
                confirmation="Mark this appointment as a no-show? This records attendance only and will not charge the customer."
              >
                Mark no-show
              </ConfirmSubmitButton>
            </form>
          </div>
        </section>
      ) : null}
      <p className="rounded-2xl border border-lh-line bg-white p-4 text-sm text-lh-muted">
        Cancellation, rescheduling, no-show charging, and refunds remain
        disabled here until their payment, reservation, calendar, and
        notification compensations are implemented as one durable workflow.
      </p>
    </div>
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-2xl border border-lh-line bg-white p-6">
      <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
        {title}
      </h2>
      <dl className="mt-4 space-y-3">{children}</dl>
    </section>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}
function formatDate(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value);
}
function formatTime(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeStyle: "short",
    timeZone,
  }).format(value);
}

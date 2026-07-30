import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { ConfirmSubmitButton } from "@/components/admin/confirm-submit-button";
import { StatusPill } from "@/components/admin/status-pill";
import { getAdminAppointmentDetail } from "@/lib/admin/appointment-read";
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

  const appointmentDate = formatDateTime(
    appointment.selectedStart,
    appointment.businessTimezone,
  );

  return (
    <div className="space-y-7">
      <header>
        <Link
          className="inline-flex min-h-11 items-center text-sm font-semibold text-lh-primary underline-offset-4 hover:underline"
          href="/admin/appointments"
        >
          Back to appointments
        </Link>
        <p className="mt-3 font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Appointment · {appointment.publicReference}
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase tracking-[0.08em] sm:text-5xl lg:text-6xl">
          {appointment.customerName}
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          {appointment.serviceName} with {appointment.providerName}. Times shown
          in {appointment.businessTimezoneLabel}.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {appointment.attentionReasons.length > 0 ? (
        <section
          aria-labelledby="appointment-attention-heading"
          className="rounded-2xl border border-lh-accent-soft bg-lh-light-soft p-5"
        >
          <h2
            className="text-lg font-semibold text-lh-accent"
            id="appointment-attention-heading"
          >
            Needs attention
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-lh-shadow">
            {appointment.attentionReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label="Appointment summary"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <SummaryItem label="When">
          <time dateTime={appointment.selectedStart.toISOString()}>
            {appointmentDate}
          </time>
          <span className="mt-1 block text-sm font-normal text-lh-muted">
            to{" "}
            {formatTime(appointment.selectedEnd, appointment.businessTimezone)}
          </span>
        </SummaryItem>
        <SummaryItem label="Service">
          {appointment.serviceName}
          {appointment.addOn ? (
            <span className="mt-1 block text-sm font-normal text-lh-muted">
              Add-on: {appointment.addOn.name}
            </span>
          ) : null}
        </SummaryItem>
        <SummaryItem label="Provider">{appointment.providerName}</SummaryItem>
        <SummaryItem label="Status">
          <StatusPill tone={appointment.status.tone}>
            {appointment.status.label}
          </StatusPill>
        </SummaryItem>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Appointment">
          <Detail
            label="Date and time"
            value={
              <>
                <time dateTime={appointment.selectedStart.toISOString()}>
                  {appointmentDate}
                </time>{" "}
                to{" "}
                <time dateTime={appointment.selectedEnd.toISOString()}>
                  {formatTime(
                    appointment.selectedEnd,
                    appointment.businessTimezone,
                  )}
                </time>
              </>
            }
          />
          <Detail label="Service" value={appointment.serviceName} />
          <Detail label="Provider" value={appointment.providerName} />
          {appointment.durationMinutes ? (
            <Detail
              label="Duration"
              value={`${appointment.durationMinutes.toLocaleString("en-CA")} minutes`}
            />
          ) : null}
          {appointment.addOn ? (
            <Detail
              label="Add-on"
              value={
                <>
                  {appointment.addOn.name}
                  {appointment.addOn.description ? (
                    <span className="mt-1 block text-sm font-normal text-lh-muted">
                      {appointment.addOn.description}
                    </span>
                  ) : null}
                </>
              }
            />
          ) : null}
          {appointment.cancellationNote ? (
            <Detail
              label="Cancellation note"
              value={appointment.cancellationNote}
            />
          ) : null}
        </Section>

        <Section title="Customer">
          <Detail label="Name" value={appointment.customerName} />
          <Detail
            label="Email"
            value={
              <a
                className="inline-flex min-h-11 items-center text-lh-primary underline-offset-4 hover:underline"
                href={`mailto:${appointment.customerEmail}`}
              >
                {appointment.customerEmail}
              </a>
            }
          />
          <Detail
            label="Phone"
            value={
              appointment.customerPhone ? (
                <a
                  className="inline-flex min-h-11 items-center text-lh-primary underline-offset-4 hover:underline"
                  href={`tel:${appointment.customerPhone}`}
                >
                  {appointment.customerPhone}
                </a>
              ) : (
                "Not provided"
              )
            }
          />
        </Section>

        <Section title="Payment">
          <Detail
            label="Recorded status"
            value={
              <StatusPill tone={appointment.paymentStatus.tone}>
                {appointment.paymentStatus.label}
              </StatusPill>
            }
          />
          <p className="rounded-xl bg-lh-neutral-2 p-4 text-sm leading-6 text-lh-muted">
            Payment amounts are not shown because this appointment does not
            contain a verified transaction total. Use the booking reference when
            checking the payment provider.
          </p>
        </Section>

        <Section title="Calendar and email">
          <Detail
            label="Booking calendar"
            value={
              <StatusPill tone={appointment.calendarStatus.tone}>
                {appointment.calendarStatus.label}
              </StatusPill>
            }
          />
          <Detail
            label="Confirmation email"
            value={
              <StatusPill tone={appointment.emailStatus.tone}>
                {appointment.emailStatus.label}
              </StatusPill>
            }
          />
        </Section>
      </div>

      <Section title="Intake">
        {appointment.intake.length > 0 ? (
          <div className="space-y-4">
            {appointment.intake.map((answer, index) => (
              <Detail
                key={`${answer.label}-${index}`}
                label={answer.label}
                value={answer.answer}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-lh-muted">
            No intake responses were recorded for this appointment.
          </p>
        )}
      </Section>

      {appointment.attendanceCanBeRecorded ? (
        <section className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6">
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
                name="appointmentId"
                type="hidden"
                value={appointment.id}
              />
              <input name="status" type="hidden" value="completed" />
              <ConfirmSubmitButton
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-lh-shadow px-5 py-2 text-sm font-semibold text-white transition hover:bg-lh-primary disabled:cursor-wait disabled:opacity-60"
                confirmation={`Mark ${appointment.customerName}'s ${appointmentDate} appointment as completed? This updates attendance only.`}
              >
                Mark completed
              </ConfirmSubmitButton>
            </form>
            <form action={setAppointmentAttendanceStatusAction}>
              <input
                name="appointmentId"
                type="hidden"
                value={appointment.id}
              />
              <input name="status" type="hidden" value="no_show" />
              <ConfirmSubmitButton
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-lh-line px-5 py-2 text-sm font-semibold transition hover:bg-lh-neutral-2 disabled:cursor-wait disabled:opacity-60"
                confirmation={`Mark ${appointment.customerName}'s ${appointmentDate} appointment as a no-show? This records attendance only and will not charge the customer.`}
              >
                Mark no-show
              </ConfirmSubmitButton>
            </form>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6">
        <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
          Changes that require escalation
        </h2>
        <p className="mt-2 text-sm leading-6 text-lh-muted">
          Cancellation, rescheduling, no-show charging, and refunds are not
          available from this page.
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-6 text-lh-shadow">
          <li>Preserve the booking and payment records.</li>
          <li>
            Check whether the booking already has a calendar event before
            creating any replacement.
          </li>
          <li>
            For a paid booking without a usable slot, keep it pending rebooking,
            offer an alternate time, and refund only if rebooking fails or the
            business owner chooses a refund.
          </li>
          <li>
            Escalate booking reference {appointment.publicReference} to the
            business owner and technical operator when payment succeeded but
            booking finalization is uncertain.
          </li>
        </ol>
      </section>

      <Section title="Activity">
        {appointment.activity.length > 0 ? (
          <>
            <ol className="divide-y divide-lh-line">
              {appointment.activity.map((event, index) => (
                <li
                  className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
                  key={`${event.createdAt.toISOString()}-${index}`}
                >
                  <div>
                    <p className="font-medium">{event.label}</p>
                    <p className="mt-1 text-sm text-lh-muted">
                      {event.actorName ?? "System"}
                    </p>
                  </div>
                  <time
                    className="text-sm text-lh-muted"
                    dateTime={event.createdAt.toISOString()}
                  >
                    {formatDateTime(
                      event.createdAt,
                      appointment.businessTimezone,
                    )}
                  </time>
                </li>
              ))}
            </ol>
            {appointment.activity.length === 50 ? (
              <p className="mt-3 text-xs text-lh-muted">
                Showing the 50 most recent updates.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-lh-muted">
            No activity has been recorded for this appointment.
          </p>
        )}
      </Section>

      <details className="rounded-2xl border border-lh-line bg-white p-5">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          System details
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Detail
            label="Booking reference"
            value={appointment.publicReference}
          />
          <Detail label="Booking source" value={appointment.originLabel} />
          <Detail
            label="Created"
            value={formatDateTime(
              appointment.createdAt,
              appointment.businessTimezone,
            )}
          />
          <Detail
            label="Last updated"
            value={formatDateTime(
              appointment.updatedAt,
              appointment.businessTimezone,
            )}
          />
        </div>
      </details>
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
    <section className="rounded-2xl border border-lh-line bg-white p-5 sm:p-6">
      <h2 className="font-heading text-3xl uppercase tracking-[0.08em]">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function SummaryItem({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-lh-line bg-white p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </p>
      <div className="mt-2 font-semibold text-lh-shadow">{children}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="text-xs uppercase tracking-[0.12em] text-lh-muted">
        {label}
      </p>
      <div className="mt-1 break-words font-medium">{value}</div>
    </div>
  );
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

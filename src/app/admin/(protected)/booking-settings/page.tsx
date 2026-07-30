import { AdminActionFeedback } from "@/components/admin/admin-action-feedback";
import { AdminSubmitButton } from "@/components/admin/admin-submit-button";
import { BookingQuestionsEditor } from "@/components/admin/booking-questions-editor";
import { getSetupReadiness } from "@/lib/admin/operations-read";
import { canAdmin } from "@/lib/admin/permissions";
import { requireAdminPagePermission } from "@/lib/admin/page-authorization";
import { getTimezoneLabel } from "@/lib/admin/presentation";
import { DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL } from "@/lib/booking/operational-ui-settings";

import { updateBookingSettingsAction } from "../actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function AdminBookingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string | string[];
    notice?: string | string[];
  }>;
}) {
  const feedback = await searchParams;
  const actor = await requireAdminPagePermission("setup:view");
  const readiness = await getSetupReadiness();
  const canManage = canAdmin({
    action: "settings:manage",
    bookingProviderResourceIds: actor.bookingProviderResourceIds,
    bookingResourceIds: actor.bookingResourceIds,
    role: actor.user.role,
  });
  const settings = readiness.settings ?? {
    bookingHorizonDays: 30,
    defaultBufferAfterMinutes: 15,
    defaultBufferBeforeMinutes: 15,
    intakeQuestions: [],
    marketingOptInLabel: DEFAULT_BOOKING_MARKETING_OPT_IN_LABEL,
    minimumLeadTimeHours: 24,
    slotIntervalMinutes: 15,
    timezone: "America/Toronto",
  };

  return (
    <div className="space-y-8">
      <header>
        <p className="font-smallcaps text-sm uppercase tracking-[0.2em] text-lh-muted">
          Settings
        </p>
        <h1 className="mt-2 font-heading text-4xl uppercase leading-none tracking-[0.08em] sm:text-5xl lg:text-6xl">
          Booking settings
        </h1>
        <p className="mt-3 max-w-3xl text-lh-muted">
          Set the default booking window, notice period, timing, and client
          intake text.
        </p>
      </header>

      <AdminActionFeedback error={feedback.error} notice={feedback.notice} />

      {canManage ? (
        <form
          action={updateBookingSettingsAction}
          className="rounded-2xl border border-lh-line bg-white p-6"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Business time zone">
              <select
                className={inputClass}
                defaultValue={settings.timezone}
                name="timezone"
                required
              >
                {settings.timezone !== "America/Toronto" ? (
                  <option value={settings.timezone}>
                    {getTimezoneLabel(settings.timezone)} (current)
                  </option>
                ) : null}
                <option value="America/Toronto">Toronto time</option>
              </select>
            </Field>
            <Field label="How far ahead clients can book">
              <NumberInput
                defaultValue={settings.bookingHorizonDays}
                min={1}
                name="bookingHorizonDays"
                suffix="days"
              />
            </Field>
            <Field label="Minimum notice before an appointment">
              <NumberInput
                defaultValue={settings.minimumLeadTimeHours}
                min={0}
                name="minimumLeadTimeHours"
                suffix="hours"
              />
            </Field>
          </div>

          <details className="mt-6 rounded-2xl border border-lh-line p-5">
            <summary className="cursor-pointer font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lh-primary">
              Advanced timing and intake settings
            </summary>
            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Appointment start interval">
                <NumberInput
                  defaultValue={settings.slotIntervalMinutes}
                  min={1}
                  name="slotIntervalMinutes"
                  suffix="minutes"
                />
              </Field>
              <Field label="Default time before">
                <NumberInput
                  defaultValue={settings.defaultBufferBeforeMinutes}
                  min={0}
                  name="defaultBufferBeforeMinutes"
                  suffix="minutes"
                />
              </Field>
              <Field label="Default time after">
                <NumberInput
                  defaultValue={settings.defaultBufferAfterMinutes}
                  min={0}
                  name="defaultBufferAfterMinutes"
                  suffix="minutes"
                />
              </Field>
            </div>
            <div className="mt-4 grid gap-6">
              <div>
                <h3 className="text-sm font-semibold">
                  Client intake questions
                </h3>
                <p className="mt-1 text-xs text-lh-muted">
                  Ask only for information needed to prepare for the
                  appointment.
                </p>
                <div className="mt-3">
                  <BookingQuestionsEditor
                    questions={settings.intakeQuestions}
                  />
                </div>
              </div>
              <Field label="Marketing opt-in wording">
                <textarea
                  className={`${inputClass} min-h-28`}
                  defaultValue={settings.marketingOptInLabel}
                  name="marketingOptInLabel"
                  required
                />
              </Field>
            </div>
          </details>

          <AdminSubmitButton
            className="mt-5 inline-flex min-h-11 items-center rounded-full bg-lh-primary px-5 py-3 text-sm font-semibold uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            pendingLabel="Saving…"
          >
            Save booking settings
          </AdminSubmitButton>
        </form>
      ) : (
        <p className="rounded-2xl border border-lh-line bg-white p-5 text-lh-muted">
          You can view booking health, but only an owner or administrator can
          change these settings.
        </p>
      )}
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

function NumberInput({
  defaultValue,
  min,
  name,
  suffix,
}: {
  defaultValue: number;
  min: number;
  name: string;
  suffix: string;
}) {
  return (
    <span className="flex items-center rounded-xl border border-lh-line bg-white focus-within:ring-2 focus-within:ring-lh-primary">
      <input
        className="min-w-0 flex-1 rounded-xl px-3 py-3 text-sm outline-none"
        defaultValue={defaultValue}
        min={min}
        name={name}
        required
        type="number"
      />
      <span className="pr-3 text-xs text-lh-muted">{suffix}</span>
    </span>
  );
}

const inputClass =
  "w-full rounded-xl border border-lh-line bg-white px-3 py-3 text-sm";

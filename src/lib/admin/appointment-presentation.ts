import type {
  AppointmentCalendarSyncStatus,
  AppointmentPaymentStatus,
  AppointmentStatus,
} from "@/lib/private-db/schema";

const MAX_INTAKE_ANSWERS = 50;
const MAX_INTAKE_ANSWER_LENGTH = 4_000;
const MAX_LABEL_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1_000;

export interface AdminAppointmentSnapshotPresentation {
  addOn: {
    description: string | null;
    name: string;
  } | null;
  durationMinutes: number | null;
  intake: Array<{
    answer: string;
    label: string;
  }>;
  providerName: string | null;
  serviceName: string | null;
}

export function toAdminAppointmentSnapshotPresentation(input: {
  intake: unknown;
  offering: unknown;
  provider: unknown;
}): AdminAppointmentSnapshotPresentation {
  const offering = asRecord(input.offering);
  const provider = asRecord(input.provider);
  const service = asRecord(offering?.service);
  const selectedAddOn = asRecord(offering?.selectedAddOn);

  return {
    addOn: getAddOn(selectedAddOn),
    durationMinutes: readPositiveInteger(offering?.durationMinutes),
    intake: getIntakeAnswers(input.intake),
    providerName: readDisplayText(provider?.displayName, MAX_LABEL_LENGTH),
    serviceName:
      readDisplayText(service?.displayTitle, MAX_LABEL_LENGTH) ??
      readDisplayText(offering?.displayTitle, MAX_LABEL_LENGTH) ??
      readDisplayText(offering?.title, MAX_LABEL_LENGTH),
  };
}

export function getAdminAppointmentAttentionReasons(input: {
  bookingConfirmationEmailFailed: boolean;
  calendarSyncStatus: AppointmentCalendarSyncStatus;
  now: Date;
  paymentStatus: AppointmentPaymentStatus;
  selectedEnd: Date;
  status: AppointmentStatus;
}): string[] {
  const reasons: string[] = [];

  if (input.status === "rebooking_pending") {
    reasons.push("Rebooking is required");
  } else if (input.status === "manual_followup") {
    reasons.push("Manual follow-up is required");
  }

  if (input.paymentStatus === "refund_required") {
    reasons.push("Refund review is required");
  }
  if (input.calendarSyncStatus === "manual_followup") {
    reasons.push("Calendar sync needs attention");
  }
  if (input.status === "confirmed" && input.selectedEnd < input.now) {
    reasons.push("Attendance has not been recorded");
  }
  if (input.bookingConfirmationEmailFailed && input.status !== "cancelled") {
    reasons.push("Confirmation email delivery failed");
  }

  return reasons;
}

export function getAdminAppointmentEmailPresentation(input: {
  lastError: string | null;
  sentAt: Date | null;
}): {
  label: string;
  tone: "attention" | "neutral" | "success";
} {
  if (input.sentAt) return { label: "Sent", tone: "success" };
  if (input.lastError) {
    return { label: "Delivery needs attention", tone: "attention" };
  }
  return { label: "Not sent yet", tone: "neutral" };
}

const APPOINTMENT_EVENT_LABELS: Readonly<Record<string, string>> = {
  appointment_completed: "Marked completed",
  appointment_confirmed: "Appointment confirmed",
  appointment_created: "Appointment record created",
  appointment_marked_no_show: "Marked as a no-show",
  calendar_manual_followup: "Calendar follow-up requested",
  calendar_synced: "Added to the booking calendar",
  payment_captured: "Payment received",
  rebooking_required: "Rebooking requested",
};

export function getAdminAppointmentEventLabel(eventType: string): string {
  return APPOINTMENT_EVENT_LABELS[eventType] ?? "Appointment updated";
}

function getAddOn(
  selectedAddOn: Record<string, unknown> | null,
): AdminAppointmentSnapshotPresentation["addOn"] {
  const name = readDisplayText(selectedAddOn?.name, MAX_LABEL_LENGTH);
  if (!name) return null;

  return {
    description: readDisplayText(
      selectedAddOn?.description,
      MAX_DESCRIPTION_LENGTH,
    ),
    name,
  };
}

function getIntakeAnswers(
  value: unknown,
): AdminAppointmentSnapshotPresentation["intake"] {
  const intake = asRecord(value);
  if (!Array.isArray(intake?.answers)) return [];

  return intake.answers.slice(0, MAX_INTAKE_ANSWERS).flatMap((item, index) => {
    const answer = asRecord(item);
    const answerText = readDisplayText(
      answer?.answer,
      MAX_INTAKE_ANSWER_LENGTH,
    );
    if (!answerText) return [];

    return [
      {
        answer: answerText,
        label:
          readDisplayText(answer?.questionLabel, MAX_LABEL_LENGTH) ??
          `Intake response ${index + 1}`,
      },
    ];
  });
}

function readDisplayText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maximumLength);
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 24 * 60
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

import type {
  CalendarFinalizationStatus,
  CheckoutOrderPurpose,
  CheckoutOrderStatus,
  TrainingEnrollmentSchedulingStatus,
} from "@/lib/private-db/schema";

export const ADMIN_WORKSPACE_PAGE_SIZE = 20;
export const ADMIN_WORKSPACE_SEARCH_LIMIT = 120;

export type AdminWorkspaceStatusTone = "attention" | "neutral" | "success";

export interface AdminWorkspaceStatusPresentation {
  description?: string;
  label: string;
  tone: AdminWorkspaceStatusTone;
}

export interface AdminWorkspacePagination {
  offset: number;
  page: number;
  pageCount: number;
  pageSize: number;
}

export interface AdminInquiryContentPresentation {
  detailLines: string[];
  message: string | null;
  messageTruncated: boolean;
  redacted: boolean;
  subject: string;
}

export function normalizeAdminWorkspaceSearch(
  value: string | undefined,
): string {
  return value?.trim().slice(0, ADMIN_WORKSPACE_SEARCH_LIMIT) ?? "";
}

export function getAdminWorkspacePagination(
  requestedPage: number | undefined,
  total: number,
  pageSize = ADMIN_WORKSPACE_PAGE_SIZE,
): AdminWorkspacePagination {
  const safeTotal = Number.isSafeInteger(total) && total > 0 ? total : 0;
  const safePageSize =
    Number.isSafeInteger(pageSize) && pageSize > 0
      ? pageSize
      : ADMIN_WORKSPACE_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const candidate =
    typeof requestedPage === "number" &&
    Number.isSafeInteger(requestedPage) &&
    requestedPage > 0
      ? requestedPage
      : 1;
  const page = Math.min(candidate, pageCount);

  return {
    offset: (page - 1) * safePageSize,
    page,
    pageCount,
    pageSize: safePageSize,
  };
}

export function getCheckoutOrderStatusPresentation(
  status: CheckoutOrderStatus,
): AdminWorkspaceStatusPresentation {
  switch (status) {
    case "paid":
      return { label: "Paid", tone: "success" };
    case "pending":
      return { label: "Awaiting payment", tone: "neutral" };
    case "verification_failed":
      return {
        description: "The recorded payment could not be verified.",
        label: "Payment verification issue",
        tone: "attention",
      };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "refunded":
      return { label: "Refund recorded", tone: "neutral" };
  }
}

export function getProductConfirmationPresentation(input: {
  lastError: string | null;
  sentAt: Date | null;
  status: CheckoutOrderStatus;
}): AdminWorkspaceStatusPresentation {
  if (input.sentAt !== null) {
    return { label: "Confirmation sent", tone: "success" };
  }

  if (input.status === "paid" && input.lastError !== null) {
    return {
      description: "The customer order confirmation could not be delivered.",
      label: "Delivery needs attention",
      tone: "attention",
    };
  }

  switch (input.status) {
    case "paid":
      return {
        description: "No completed confirmation delivery is recorded.",
        label: "Confirmation not recorded",
        tone: "attention",
      };
    case "pending":
      return { label: "Starts after payment", tone: "neutral" };
    case "verification_failed":
      return {
        description: "Confirmation waits until payment review is resolved.",
        label: "Waiting for payment review",
        tone: "neutral",
      };
    case "cancelled":
      return { label: "No delivery expected", tone: "neutral" };
    case "refunded":
      return {
        description:
          "The order is refunded and no completed confirmation delivery is recorded.",
        label: "Delivery not recorded",
        tone: "neutral",
      };
  }
}

export function getTrainingSchedulingPresentation(input: {
  enrollmentStatus: TrainingEnrollmentSchedulingStatus | null;
  hasEnrollment: boolean;
  now: Date;
  orderStatus: CheckoutOrderStatus;
  providerStatus: string | null;
  tokenExpiresAt: Date | null;
  tokenUsedAt: Date | null;
}): AdminWorkspaceStatusPresentation {
  if (input.orderStatus === "pending") {
    return { label: "Starts after payment", tone: "neutral" };
  }

  if (input.orderStatus === "verification_failed") {
    return {
      description: "Enrollment setup waits until payment review is resolved.",
      label: "Waiting for payment review",
      tone: "neutral",
    };
  }

  if (input.orderStatus === "cancelled") {
    return { label: "Purchase cancelled", tone: "neutral" };
  }

  if (!input.hasEnrollment) {
    if (input.orderStatus === "refunded") {
      return { label: "No enrollment recorded", tone: "neutral" };
    }

    return {
      description: "Payment is recorded, but an enrollment record is missing.",
      label: "Enrollment setup needs attention",
      tone: "attention",
    };
  }

  if (input.providerStatus === "finalization_failed") {
    return {
      description: "Payment is recorded, but enrollment setup did not finish.",
      label: "Enrollment setup needs attention",
      tone: input.orderStatus === "refunded" ? "neutral" : "attention",
    };
  }

  if (input.enrollmentStatus === "manual_followup") {
    return {
      description: "The enrollment is marked for staff follow-up.",
      label: "Manual follow-up",
      tone: "attention",
    };
  }

  if (
    input.enrollmentStatus === "expired" ||
    (input.enrollmentStatus === "pending" &&
      input.tokenExpiresAt !== null &&
      input.tokenExpiresAt <= input.now)
  ) {
    return {
      description: "The private scheduling link is no longer active.",
      label: "Scheduling link expired",
      tone: input.orderStatus === "refunded" ? "neutral" : "attention",
    };
  }

  if (input.enrollmentStatus === "scheduled") {
    return {
      description:
        "The enrollment record is marked as scheduled. Google appointment details are not stored here.",
      label: "Scheduling recorded",
      tone: "success",
    };
  }

  if (input.enrollmentStatus === "pending" && input.tokenUsedAt !== null) {
    return {
      description:
        "The scheduling token was used but the enrollment remains pending.",
      label: "Scheduling record needs attention",
      tone: "attention",
    };
  }

  if (input.orderStatus === "refunded") {
    return {
      description: "The purchase is refunded; the enrollment remains pending.",
      label: "Purchase refunded",
      tone: "neutral",
    };
  }

  return { label: "Awaiting scheduling", tone: "neutral" };
}

export function getTrainingNotificationPresentation(input: {
  hasEnrollment: boolean;
  lastError: string | null;
  orderStatus: CheckoutOrderStatus;
  staffAlertedAt: Date | null;
  studentEmailSentAt: Date | null;
}): AdminWorkspaceStatusPresentation {
  if (input.staffAlertedAt !== null && input.studentEmailSentAt !== null) {
    return { label: "Notifications sent", tone: "success" };
  }

  if (input.staffAlertedAt !== null || input.studentEmailSentAt !== null) {
    return {
      description:
        "Only part of the training notification workflow is recorded as complete.",
      label: "Partially sent",
      tone: input.orderStatus === "refunded" ? "neutral" : "attention",
    };
  }

  if (input.orderStatus === "pending") {
    return { label: "Starts after payment", tone: "neutral" };
  }

  if (input.orderStatus === "verification_failed") {
    return {
      description: "Notifications wait until payment review is resolved.",
      label: "Waiting for payment review",
      tone: "neutral",
    };
  }

  if (input.orderStatus === "cancelled") {
    return { label: "Purchase cancelled", tone: "neutral" };
  }

  if (!input.hasEnrollment) {
    return {
      label:
        input.orderStatus === "refunded"
          ? "No notifications recorded"
          : "Not recorded",
      tone: input.orderStatus === "refunded" ? "neutral" : "attention",
    };
  }

  if (input.lastError !== null) {
    return {
      description:
        input.orderStatus === "refunded"
          ? "A delivery failure was recorded before the purchase was refunded."
          : "One or more training payment notifications could not be delivered.",
      label:
        input.orderStatus === "refunded"
          ? "Delivery failure recorded"
          : "Delivery needs attention",
      tone: input.orderStatus === "refunded" ? "neutral" : "attention",
    };
  }

  return {
    description:
      input.orderStatus === "refunded"
        ? "The purchase is refunded and no completed notification delivery is recorded."
        : "No completed training notification delivery is recorded.",
    label: "Notifications not recorded",
    tone: input.orderStatus === "refunded" ? "neutral" : "attention",
  };
}

export function getCheckoutPurposePresentation(purpose: CheckoutOrderPurpose): {
  label: string;
  shortLabel: string;
} {
  switch (purpose) {
    case "product":
      return { label: "Product order", shortLabel: "Product" };
    case "training":
      return { label: "Training purchase", shortLabel: "Training" };
    case "course":
      return { label: "Online course", shortLabel: "Course" };
    case "appointment_deposit":
      return { label: "Appointment deposit", shortLabel: "Deposit" };
    case "appointment_full":
      return { label: "Appointment payment", shortLabel: "Appointment" };
    case "appointment_custom_partial":
      return {
        label: "Appointment partial payment",
        shortLabel: "Partial payment",
      };
  }
}

export function getBookingIssuePresentation(input: {
  appointmentId: string | null;
  finalizationStatus: CalendarFinalizationStatus;
  hasCustomerEmailFailure: boolean;
  hasPaymentEvidence: boolean;
  holdStatus: string;
}): AdminWorkspaceStatusPresentation {
  if (
    input.holdStatus === "refund_required" ||
    input.finalizationStatus === "refund_required"
  ) {
    return {
      description: input.hasPaymentEvidence
        ? "Payment evidence requires manual refund or cancellation verification. No refund action is available here."
        : "Refund or cancellation review is recorded, but payment capture is not verified. No refund action is available here.",
      label: "Refund review needed",
      tone: "attention",
    };
  }

  if (
    input.holdStatus === "paid_unbookable_rebooking_pending" ||
    input.finalizationStatus === "paid_unbookable_rebooking_pending"
  ) {
    return {
      description: input.hasPaymentEvidence
        ? "Payment evidence is recorded, but the requested booking could not be confirmed."
        : "The booking is marked for rebooking, but payment capture is not verified.",
      label: "Rebooking review needed",
      tone: "attention",
    };
  }

  if (
    input.holdStatus === "manual_followup" ||
    input.finalizationStatus === "manual_review"
  ) {
    return {
      description:
        "The paid booking or its calendar confirmation requires staff review.",
      label: "Manual follow-up",
      tone: "attention",
    };
  }

  if (input.hasPaymentEvidence && input.appointmentId === null) {
    return {
      description:
        "A captured payment is recorded without a corresponding appointment.",
      label: "Payment needs booking review",
      tone: "attention",
    };
  }

  if (
    input.holdStatus === "paid_pending_booking" ||
    input.finalizationStatus === "paid_calendar_pending"
  ) {
    return {
      description: "Payment is recorded, but booking confirmation is delayed.",
      label: "Booking confirmation delayed",
      tone: "attention",
    };
  }

  if (
    input.holdStatus === "booking_failed" ||
    input.finalizationStatus === "failed"
  ) {
    return {
      description: "Payment evidence exists, but booking setup did not finish.",
      label: "Booking setup needs attention",
      tone: "attention",
    };
  }

  if (input.hasCustomerEmailFailure) {
    return {
      description:
        "The customer booking confirmation email could not be delivered. No resend action is available here.",
      label: "Customer email needs attention",
      tone: "attention",
    };
  }

  return { label: "Needs review", tone: "attention" };
}

export function getInquiryTypeLabel(
  value: "general_inquiry" | "training_contact",
): string {
  return value === "training_contact" ? "Training inquiry" : "General inquiry";
}

export function getInquiryConsentLabel(value: string): string {
  switch (value) {
    case "opted_in":
      return "Marketing opt-in";
    case "not_opted_in":
      return "No marketing opt-in";
    case "unsubscribed":
      return "Unsubscribed";
    default:
      return "Consent recorded";
  }
}

export function getInquiryContentPresentation(input: {
  payload: unknown;
  submissionType: "general_inquiry" | "training_contact";
}): AdminInquiryContentPresentation {
  if (!isRecord(input.payload) || input.payload.redacted === true) {
    return {
      detailLines: [],
      message: null,
      messageTruncated: false,
      redacted: true,
      subject: getInquiryTypeLabel(input.submissionType),
    };
  }

  if (input.submissionType === "general_inquiry") {
    const message = readBoundedText(input.payload.message, 4_000);

    return {
      detailLines: [],
      message: message.value,
      messageTruncated: message.truncated,
      redacted: false,
      subject: "General inquiry",
    };
  }

  const programTitle =
    readBoundedText(input.payload.programTitle, 200).value ??
    "Training program";
  const location = readBoundedText(input.payload.location, 200).value;

  return {
    detailLines: location === null ? [] : [`Location: ${location}`],
    message: null,
    messageTruncated: false,
    redacted: false,
    subject: programTitle,
  };
}

export function getHumanTimezoneLabel(timezone: string): string {
  if (timezone === "America/Toronto") {
    return "Toronto time";
  }

  const city = timezone.split("/").at(-1)?.replaceAll("_", " ").trim();
  return city ? `${city} time` : "business local time";
}

export function readSnapshotLabel(
  value: unknown,
  keys: readonly string[],
  fallback: string,
): string {
  if (!isRecord(value)) {
    return fallback;
  }

  for (const key of keys) {
    const label = readBoundedText(value[key], 200).value;
    if (label !== null) {
      return label;
    }
  }

  return fallback;
}

function readBoundedText(
  value: unknown,
  maxLength: number,
): { truncated: boolean; value: string | null } {
  if (typeof value !== "string") {
    return { truncated: false, value: null };
  }

  const cleaned = value.trim();
  if (cleaned.length === 0) {
    return { truncated: false, value: null };
  }

  if (cleaned.length <= maxLength) {
    return { truncated: false, value: cleaned };
  }

  return {
    truncated: true,
    value: `${cleaned.slice(0, maxLength).trimEnd()}…`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

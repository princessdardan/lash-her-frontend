import type {
  AdminAuditOutcome,
  AdminUserStatus,
  AppointmentCalendarSyncStatus,
  AppointmentHoldStatus,
  AppointmentOrigin,
  AppointmentPaymentStatus,
  AppointmentStatus,
  BookingCalendarAssignmentStatus,
  BookingCalendarConnectionStatus,
  BookingConfigurationStatus,
  BookingOfferingResourceRole,
  BookingResourceKind,
  BookingScheduleExceptionKind,
  BookingScheduleExceptionStatus,
  CalendarFinalizationStatus,
  CheckoutOrderPurpose,
  CheckoutOrderStatus,
  MarketingContactSubmissionType,
  MarketingContactSyncJobStatus,
  SquareTeamMemberMappingStatus,
  TrainingEnrollmentSchedulingStatus,
} from "@/lib/private-db/schema";

import type { AdminRole } from "./types";

export type AdminStatusTone = "attention" | "neutral" | "success";

export interface AdminStatusPresentation {
  label: string;
  tone: AdminStatusTone;
}

const ADMIN_ROLE_LABELS = {
  admin: "Administrator",
  employee: "Contractor",
  owner: "Owner",
} satisfies Record<AdminRole, string>;

const ADMIN_USER_STATUS_PRESENTATIONS = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Access disabled", tone: "neutral" },
} satisfies Record<AdminUserStatus, AdminStatusPresentation>;

const APPOINTMENT_STATUS_PRESENTATIONS = {
  cancelled: { label: "Cancelled", tone: "neutral" },
  completed: { label: "Completed", tone: "success" },
  confirmed: { label: "Confirmed", tone: "success" },
  manual_followup: { label: "Follow-up needed", tone: "attention" },
  no_show: { label: "No-show", tone: "attention" },
  rebooking_pending: { label: "Rebooking needed", tone: "attention" },
} satisfies Record<AppointmentStatus, AdminStatusPresentation>;

const APPOINTMENT_ORIGIN_LABELS = {
  admin: "Staff-created",
  imported: "Imported",
  online: "Online booking",
} satisfies Record<AppointmentOrigin, string>;

const APPOINTMENT_PAYMENT_STATUS_PRESENTATIONS = {
  not_required: { label: "No payment required", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  partially_paid: { label: "Partially paid", tone: "neutral" },
  pending: { label: "Payment pending", tone: "neutral" },
  refund_required: { label: "Refund review needed", tone: "attention" },
  refunded: { label: "Refunded", tone: "neutral" },
} satisfies Record<AppointmentPaymentStatus, AdminStatusPresentation>;

const APPOINTMENT_CALENDAR_SYNC_STATUS_PRESENTATIONS = {
  manual_followup: {
    label: "Calendar needs attention",
    tone: "attention",
  },
  not_required: { label: "No calendar event required", tone: "neutral" },
  pending: { label: "Sync pending", tone: "neutral" },
  retryable_failed: { label: "Retry scheduled", tone: "attention" },
  synced: { label: "Added to calendar", tone: "success" },
} satisfies Record<AppointmentCalendarSyncStatus, AdminStatusPresentation>;

const MARKETING_SOURCE_LABELS = {
  booking_marketing_choice: "Booking opt-in",
  contact_popup: "Website sign-up",
  general_inquiry: "General inquiry",
  sanity_backfill: "Imported contact",
  training_contact: "Training inquiry",
} satisfies Record<MarketingContactSubmissionType, string>;

const MARKETING_SYNC_STATUS_PRESENTATIONS = {
  dead_letter: { label: "Needs manual review", tone: "attention" },
  processing: { label: "Syncing", tone: "neutral" },
  queued: { label: "Waiting to sync", tone: "neutral" },
  retryable_failed: { label: "Retry scheduled", tone: "attention" },
  skipped_unconfigured: {
    label: "Delivery sync not configured",
    tone: "attention",
  },
  succeeded: { label: "Synced", tone: "success" },
} satisfies Record<MarketingContactSyncJobStatus, AdminStatusPresentation>;

const AUDIT_OUTCOME_PRESENTATIONS = {
  denied: { label: "Denied", tone: "attention" },
  failure: { label: "Failed", tone: "attention" },
  success: { label: "Completed", tone: "success" },
} satisfies Record<AdminAuditOutcome, AdminStatusPresentation>;

const BOOKING_RESOURCE_KIND_LABELS = {
  equipment: "Equipment",
  provider: "Bookable team member",
  room: "Room",
} satisfies Record<BookingResourceKind, string>;

const BOOKING_OFFERING_RESOURCE_ROLE_LABELS = {
  equipment: "Required equipment",
  provider: "Service provider",
  room: "Treatment room",
} satisfies Record<BookingOfferingResourceRole, string>;

const BOOKING_CONFIGURATION_STATUS_PRESENTATIONS = {
  active: { label: "Active", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
  disabled: { label: "Disabled", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
} satisfies Record<BookingConfigurationStatus, AdminStatusPresentation>;

const SCHEDULE_EXCEPTION_KIND_LABELS = {
  available: "Open extra hours",
  unavailable: "Block time",
} satisfies Record<BookingScheduleExceptionKind, string>;

const SCHEDULE_EXCEPTION_STATUS_PRESENTATIONS = {
  active: { label: "Current", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} satisfies Record<BookingScheduleExceptionStatus, AdminStatusPresentation>;

const CALENDAR_CONNECTION_STATUS_PRESENTATIONS = {
  active: { label: "Connected", tone: "success" },
  disabled: { label: "Disconnected", tone: "neutral" },
  reconnect_required: { label: "Reconnect needed", tone: "attention" },
  revoked: { label: "Access revoked", tone: "attention" },
} satisfies Record<BookingCalendarConnectionStatus, AdminStatusPresentation>;

const CALENDAR_ASSIGNMENT_STATUS_PRESENTATIONS = {
  active: { label: "Active", tone: "success" },
  disabled: { label: "Disabled", tone: "neutral" },
} satisfies Record<BookingCalendarAssignmentStatus, AdminStatusPresentation>;

const SQUARE_MAPPING_STATUS_PRESENTATIONS = {
  active: { label: "Matched", tone: "success" },
  inactive: { label: "Inactive match", tone: "attention" },
  missing: { label: "Needs matching", tone: "attention" },
} satisfies Record<SquareTeamMemberMappingStatus, AdminStatusPresentation>;

const TRAINING_SCHEDULING_STATUS_PRESENTATIONS = {
  expired: { label: "Scheduling expired", tone: "attention" },
  manual_followup: { label: "Follow-up needed", tone: "attention" },
  pending: { label: "Awaiting scheduling", tone: "attention" },
  scheduled: { label: "Scheduled", tone: "success" },
} satisfies Record<TrainingEnrollmentSchedulingStatus, AdminStatusPresentation>;

const CHECKOUT_ORDER_STATUS_PRESENTATIONS = {
  cancelled: { label: "Cancelled", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  pending: { label: "Payment pending", tone: "neutral" },
  refunded: { label: "Refunded", tone: "neutral" },
  verification_failed: {
    label: "Payment verification failed",
    tone: "attention",
  },
} satisfies Record<CheckoutOrderStatus, AdminStatusPresentation>;

const CHECKOUT_ORDER_PURPOSE_LABELS = {
  appointment_custom_partial: "Appointment partial payment",
  appointment_deposit: "Appointment deposit",
  appointment_full: "Appointment payment",
  product: "Product order",
  training: "Training enrollment",
} satisfies Record<CheckoutOrderPurpose, string>;

const APPOINTMENT_HOLD_STATUS_PRESENTATIONS = {
  booked: { label: "Appointment created", tone: "success" },
  booking_failed: { label: "Booking failed", tone: "attention" },
  expired: { label: "Expired", tone: "neutral" },
  held: { label: "Booking held", tone: "neutral" },
  manual_followup: { label: "Follow-up needed", tone: "attention" },
  manual_rebooked: { label: "Rebooked manually", tone: "success" },
  paid_pending_booking: { label: "Paid—booking pending", tone: "attention" },
  paid_unbookable_rebooking_pending: {
    label: "Paid—rebooking needed",
    tone: "attention",
  },
  payment_failed: { label: "Payment failed", tone: "attention" },
  payment_pending: { label: "Payment pending", tone: "neutral" },
  refund_required: { label: "Refund review needed", tone: "attention" },
  refunded: { label: "Refunded", tone: "neutral" },
  released: { label: "Released", tone: "neutral" },
} satisfies Record<AppointmentHoldStatus, AdminStatusPresentation>;

const CALENDAR_FINALIZATION_STATUS_PRESENTATIONS = {
  booked: { label: "Appointment created", tone: "success" },
  failed: { label: "Booking failed", tone: "attention" },
  manual_rebooked: { label: "Rebooked manually", tone: "success" },
  manual_review: { label: "Manual review needed", tone: "attention" },
  not_required: { label: "Not required", tone: "neutral" },
  paid_calendar_pending: {
    label: "Paid—calendar pending",
    tone: "attention",
  },
  paid_unbookable_rebooking_pending: {
    label: "Paid—rebooking needed",
    tone: "attention",
  },
  pending: { label: "Booking pending", tone: "neutral" },
  refund_required: { label: "Refund review needed", tone: "attention" },
  refunded: { label: "Refunded", tone: "neutral" },
} satisfies Record<CalendarFinalizationStatus, AdminStatusPresentation>;

const AUDIT_ACTION_LABELS = {
  appointment_completed: "Marked an appointment completed",
  appointment_detail_view: "Viewed an appointment",
  appointment_marked_no_show: "Marked an appointment as a no-show",
  audit_log_view: "Viewed activity history",
  booking_resource_created: "Created a booking resource",
  booking_resource_profile_updated: "Updated a booking resource",
  booking_resource_status_changed: "Changed a booking resource status",
  booking_service_created: "Created a service",
  booking_service_profile_updated: "Updated a service",
  booking_service_status_changed: "Changed a service status",
  booking_settings_updated: "Updated booking settings",
  calendar_assignment_disabled: "Removed a calendar assignment",
  calendar_assignment_saved: "Updated a calendar assignment",
  calendar_connection_authorization_failed:
    "Could not authorize a calendar connection",
  calendar_connection_authorized: "Connected a calendar account",
  calendar_connection_created: "Started a calendar connection",
  calendar_connection_disabled: "Disconnected a calendar account",
  calendar_connection_ownership_transferred:
    "Transferred a calendar connection",
  employee_calendar_assignment_disabled:
    "Removed a contractor calendar assignment",
  employee_calendar_assignment_saved:
    "Updated a contractor calendar assignment",
  employee_calendar_authorization_failed:
    "Could not authorize a contractor calendar",
  employee_calendar_connection_created:
    "Started a contractor calendar connection",
  employee_calendar_connection_disconnected:
    "Disconnected a contractor calendar",
  employee_calendar_oauth_completed: "Connected a contractor calendar",
  marketing_contacts_view: "Viewed marketing contacts",
  offering_add_on_created: "Created a service add-on",
  offering_add_on_status_changed: "Changed an add-on status",
  resource_schedule_created: "Added regular hours",
  resource_schedule_disabled: "Disabled regular hours",
  schedule_exception_cancelled: "Cancelled an availability exception",
  schedule_exception_created: "Added an availability exception",
  service_offering_created: "Created service pricing",
  service_offering_resource_assigned: "Assigned a service resource",
  service_offering_resource_removed: "Removed a service resource",
  service_offering_status_changed: "Changed service availability",
  service_offering_updated: "Updated service pricing",
  service_promotion_created: "Created a service promotion",
  service_promotion_status_changed: "Changed a promotion status",
  service_promotion_updated: "Updated a service promotion",
  square_attribution_enforcement_changed:
    "Changed Square sales matching requirements",
  square_team_mappings_refreshed: "Refreshed Square sales matches",
  staff_created: "Created a team account",
  staff_resource_assigned: "Assigned a resource to a team member",
  staff_resource_unassigned: "Removed a resource from a team member",
  staff_status_changed: "Changed a team account status",
} as const satisfies Record<string, string>;

const AUDIT_DOMAIN_LABELS = {
  admin: "Administration",
  appointments: "Appointments",
  booking_setup: "Booking settings",
  bookings: "Appointments",
  calendar: "Calendar sync",
  marketing: "Marketing",
  offerings: "Services",
  schedules: "Availability",
  service_promotions: "Service promotions",
  square_attribution: "Square sales matching",
  staff: "Team",
} as const satisfies Record<string, string>;

const TIMEZONE_LABELS: Readonly<Record<string, string>> = {
  "America/Toronto": "Toronto time",
  UTC: "UTC",
};

export function getAdminRoleLabel(role: AdminRole): string {
  return ADMIN_ROLE_LABELS[role];
}

export function getAdminUserStatusPresentation(
  status: AdminUserStatus,
): AdminStatusPresentation {
  return ADMIN_USER_STATUS_PRESENTATIONS[status];
}

export function getAppointmentStatusPresentation(
  status: AppointmentStatus,
): AdminStatusPresentation {
  return APPOINTMENT_STATUS_PRESENTATIONS[status];
}

export function getAppointmentOriginLabel(origin: AppointmentOrigin): string {
  return APPOINTMENT_ORIGIN_LABELS[origin];
}

export function getAppointmentPaymentStatusPresentation(
  status: AppointmentPaymentStatus,
): AdminStatusPresentation {
  return APPOINTMENT_PAYMENT_STATUS_PRESENTATIONS[status];
}

export function getAppointmentCalendarSyncStatusPresentation(
  status: AppointmentCalendarSyncStatus,
): AdminStatusPresentation {
  return APPOINTMENT_CALENDAR_SYNC_STATUS_PRESENTATIONS[status];
}

export function getMarketingSourceLabel(
  source: MarketingContactSubmissionType | string,
): string {
  return hasOwn(MARKETING_SOURCE_LABELS, source)
    ? MARKETING_SOURCE_LABELS[source]
    : "Other source";
}

export function getMarketingSyncStatusPresentation(
  status: MarketingContactSyncJobStatus,
): AdminStatusPresentation {
  return MARKETING_SYNC_STATUS_PRESENTATIONS[status];
}

export function getAdminAuditOutcomePresentation(
  outcome: AdminAuditOutcome,
): AdminStatusPresentation {
  return AUDIT_OUTCOME_PRESENTATIONS[outcome];
}

export function getBookingResourceKindLabel(kind: BookingResourceKind): string {
  return BOOKING_RESOURCE_KIND_LABELS[kind];
}

export function getBookingOfferingResourceRoleLabel(
  role: BookingOfferingResourceRole,
): string {
  return BOOKING_OFFERING_RESOURCE_ROLE_LABELS[role];
}

export function getBookingConfigurationStatusPresentation(
  status: BookingConfigurationStatus,
): AdminStatusPresentation {
  return BOOKING_CONFIGURATION_STATUS_PRESENTATIONS[status];
}

export function getScheduleExceptionKindLabel(
  kind: BookingScheduleExceptionKind,
): string {
  return SCHEDULE_EXCEPTION_KIND_LABELS[kind];
}

export function getScheduleExceptionStatusPresentation(
  status: BookingScheduleExceptionStatus,
): AdminStatusPresentation {
  return SCHEDULE_EXCEPTION_STATUS_PRESENTATIONS[status];
}

export function getCalendarConnectionStatusPresentation(
  status: BookingCalendarConnectionStatus,
): AdminStatusPresentation {
  return CALENDAR_CONNECTION_STATUS_PRESENTATIONS[status];
}

export function getCalendarAssignmentStatusPresentation(
  status: BookingCalendarAssignmentStatus,
): AdminStatusPresentation {
  return CALENDAR_ASSIGNMENT_STATUS_PRESENTATIONS[status];
}

export function getSquareMappingStatusPresentation(
  status: SquareTeamMemberMappingStatus,
): AdminStatusPresentation {
  return SQUARE_MAPPING_STATUS_PRESENTATIONS[status];
}

export function getTrainingSchedulingStatusPresentation(
  status: TrainingEnrollmentSchedulingStatus,
): AdminStatusPresentation {
  return TRAINING_SCHEDULING_STATUS_PRESENTATIONS[status];
}

export function getCheckoutOrderStatusPresentation(
  status: CheckoutOrderStatus,
): AdminStatusPresentation {
  return CHECKOUT_ORDER_STATUS_PRESENTATIONS[status];
}

export function getCheckoutOrderPurposeLabel(
  purpose: CheckoutOrderPurpose,
): string {
  return CHECKOUT_ORDER_PURPOSE_LABELS[purpose];
}

export function getAppointmentHoldStatusPresentation(
  status: AppointmentHoldStatus,
): AdminStatusPresentation {
  return APPOINTMENT_HOLD_STATUS_PRESENTATIONS[status];
}

export function getCalendarFinalizationStatusPresentation(
  status: CalendarFinalizationStatus,
): AdminStatusPresentation {
  return CALENDAR_FINALIZATION_STATUS_PRESENTATIONS[status];
}

export function getAdminAuditActionLabel(action: string): string {
  return hasOwn(AUDIT_ACTION_LABELS, action)
    ? AUDIT_ACTION_LABELS[action]
    : "Administrative activity";
}

export function getAdminAuditDomainLabel(domain: string): string {
  return hasOwn(AUDIT_DOMAIN_LABELS, domain)
    ? AUDIT_DOMAIN_LABELS[domain]
    : "Administration";
}

export function getGoogleCalendarAccessRoleLabel(
  accessRole: string | null,
): string {
  switch (accessRole) {
    case "owner":
      return "Full calendar access";
    case "writer":
      return "Can add bookings";
    case "reader":
      return "Can view calendar details";
    case "freeBusyReader":
      return "Busy times only";
    case null:
      return "Access not available";
    default:
      return "Limited calendar access";
  }
}

export function getTimezoneLabel(timezone: string): string {
  const knownLabel = TIMEZONE_LABELS[timezone];
  if (knownLabel) return knownLabel;

  try {
    const timezonePart = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date("2026-01-15T12:00:00.000Z"))
      .find((part) => part.type === "timeZoneName");

    if (!timezonePart?.value) return "Local time";
    return /time$/i.test(timezonePart.value)
      ? timezonePart.value
      : `${timezonePart.value} time`;
  } catch {
    return "Local time";
  }
}

export function toContractorTerminology(value: string): string {
  return value.replace(/employees?/gi, (legacyTerm) => {
    const replacement =
      legacyTerm.toLowerCase() === "employees" ? "contractors" : "contractor";

    if (legacyTerm === legacyTerm.toUpperCase()) {
      return replacement.toUpperCase();
    }

    if (legacyTerm[0] === legacyTerm[0]?.toUpperCase()) {
      return `${replacement[0]?.toUpperCase()}${replacement.slice(1)}`;
    }

    return replacement;
  });
}

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  adminAuditOutcome,
  adminUserStatus,
  appointmentCalendarSyncStatus,
  appointmentHoldStatus,
  appointmentOrigin,
  appointmentPaymentStatus,
  appointmentStatus,
  bookingCalendarAssignmentStatus,
  bookingCalendarConnectionStatus,
  bookingConfigurationStatus,
  bookingOfferingResourceRole,
  bookingResourceKind,
  bookingScheduleExceptionKind,
  bookingScheduleExceptionStatus,
  calendarFinalizationStatus,
  checkoutOrderPurpose,
  checkoutOrderStatus,
  marketingContactSubmissionType,
  marketingContactSyncJobStatus,
  squareTeamMemberMappingStatus,
  trainingEnrollmentSchedulingStatus,
} from "@/lib/private-db/schema";

import {
  getAdminAuditActionLabel,
  getAdminAuditDomainLabel,
  getAdminAuditOutcomePresentation,
  getAdminRoleLabel,
  getAdminUserStatusPresentation,
  getAppointmentCalendarSyncStatusPresentation,
  getAppointmentHoldStatusPresentation,
  getAppointmentOriginLabel,
  getAppointmentPaymentStatusPresentation,
  getAppointmentStatusPresentation,
  getBookingConfigurationStatusPresentation,
  getBookingOfferingResourceRoleLabel,
  getBookingResourceKindLabel,
  getCalendarAssignmentStatusPresentation,
  getCalendarConnectionStatusPresentation,
  getCalendarFinalizationStatusPresentation,
  getCheckoutOrderPurposeLabel,
  getCheckoutOrderStatusPresentation,
  getGoogleCalendarAccessRoleLabel,
  getMarketingSourceLabel,
  getMarketingSyncStatusPresentation,
  getScheduleExceptionKindLabel,
  getScheduleExceptionStatusPresentation,
  getSquareMappingStatusPresentation,
  getTimezoneLabel,
  getTrainingSchedulingStatusPresentation,
  toContractorTerminology,
  type AdminStatusPresentation,
} from "./presentation";

test("admin role labels keep internal values out of rendered copy", () => {
  assert.equal(getAdminRoleLabel("owner"), "Owner");
  assert.equal(getAdminRoleLabel("admin"), "Administrator");
  assert.equal(getAdminRoleLabel("employee"), "Contractor");
});

test("appointment presentation maps every status to human copy", () => {
  assert.deepEqual(
    Object.fromEntries(
      appointmentStatus.enumValues.map((status) => [
        status,
        getAppointmentStatusPresentation(status),
      ]),
    ),
    {
      cancelled: { label: "Cancelled", tone: "neutral" },
      completed: { label: "Completed", tone: "success" },
      confirmed: { label: "Confirmed", tone: "success" },
      manual_followup: { label: "Follow-up needed", tone: "attention" },
      no_show: { label: "No-show", tone: "attention" },
      rebooking_pending: { label: "Rebooking needed", tone: "attention" },
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      appointmentOrigin.enumValues.map((origin) => [
        origin,
        getAppointmentOriginLabel(origin),
      ]),
    ),
    {
      admin: "Staff-created",
      imported: "Imported",
      online: "Online booking",
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      appointmentPaymentStatus.enumValues.map((status) => [
        status,
        getAppointmentPaymentStatusPresentation(status).label,
      ]),
    ),
    {
      not_required: "No payment required",
      paid: "Paid",
      partially_paid: "Partially paid",
      pending: "Payment pending",
      refund_required: "Refund review needed",
      refunded: "Refunded",
    },
  );
  assert.deepEqual(
    Object.fromEntries(
      appointmentCalendarSyncStatus.enumValues.map((status) => [
        status,
        getAppointmentCalendarSyncStatusPresentation(status).label,
      ]),
    ),
    {
      manual_followup: "Calendar needs attention",
      not_required: "No calendar event required",
      pending: "Sync pending",
      retryable_failed: "Retry scheduled",
      synced: "Added to calendar",
    },
  );
});

test("status presenters cover every durable enum without raw identifiers", () => {
  assertHumanPresentations(
    adminAuditOutcome.enumValues,
    getAdminAuditOutcomePresentation,
  );
  assertHumanPresentations(
    adminUserStatus.enumValues,
    getAdminUserStatusPresentation,
  );
  assertHumanPresentations(
    appointmentStatus.enumValues,
    getAppointmentStatusPresentation,
  );
  assertHumanPresentations(
    appointmentPaymentStatus.enumValues,
    getAppointmentPaymentStatusPresentation,
  );
  assertHumanPresentations(
    appointmentCalendarSyncStatus.enumValues,
    getAppointmentCalendarSyncStatusPresentation,
  );
  assertHumanPresentations(
    marketingContactSyncJobStatus.enumValues,
    getMarketingSyncStatusPresentation,
  );
  assertHumanPresentations(
    bookingConfigurationStatus.enumValues,
    getBookingConfigurationStatusPresentation,
  );
  assertHumanPresentations(
    bookingScheduleExceptionStatus.enumValues,
    getScheduleExceptionStatusPresentation,
  );
  assertHumanPresentations(
    bookingCalendarConnectionStatus.enumValues,
    getCalendarConnectionStatusPresentation,
  );
  assertHumanPresentations(
    bookingCalendarAssignmentStatus.enumValues,
    getCalendarAssignmentStatusPresentation,
  );
  assertHumanPresentations(
    squareTeamMemberMappingStatus.enumValues,
    getSquareMappingStatusPresentation,
  );
  assertHumanPresentations(
    trainingEnrollmentSchedulingStatus.enumValues,
    getTrainingSchedulingStatusPresentation,
  );
  assertHumanPresentations(
    checkoutOrderStatus.enumValues,
    getCheckoutOrderStatusPresentation,
  );
  assertHumanPresentations(
    appointmentHoldStatus.enumValues,
    getAppointmentHoldStatusPresentation,
  );
  assertHumanPresentations(
    calendarFinalizationStatus.enumValues,
    getCalendarFinalizationStatusPresentation,
  );
});

test("label maps cover sources, resources, scheduling, and order purposes", () => {
  assertHumanLabels(
    marketingContactSubmissionType.enumValues,
    getMarketingSourceLabel,
  );
  assertHumanLabels(
    bookingResourceKind.enumValues,
    getBookingResourceKindLabel,
  );
  assertHumanLabels(
    bookingOfferingResourceRole.enumValues,
    getBookingOfferingResourceRoleLabel,
  );
  assertHumanLabels(
    bookingScheduleExceptionKind.enumValues,
    getScheduleExceptionKindLabel,
  );
  assertHumanLabels(
    checkoutOrderPurpose.enumValues,
    getCheckoutOrderPurposeLabel,
  );
  assert.equal(getMarketingSourceLabel("legacy_import"), "Other source");
});

test("calendar access roles and timezones use operator-facing labels", () => {
  assert.equal(
    getGoogleCalendarAccessRoleLabel("owner"),
    "Full calendar access",
  );
  assert.equal(getGoogleCalendarAccessRoleLabel("writer"), "Can add bookings");
  assert.equal(
    getGoogleCalendarAccessRoleLabel("freeBusyReader"),
    "Busy times only",
  );
  assert.equal(
    getGoogleCalendarAccessRoleLabel("unexpected"),
    "Limited calendar access",
  );
  assert.equal(getTimezoneLabel("America/Toronto"), "Toronto time");
  assert.equal(getTimezoneLabel("invalid/timezone"), "Local time");
});

test("audit labels hide raw action and domain identifiers", () => {
  assert.equal(
    getAdminAuditActionLabel("staff_resource_assigned"),
    "Assigned a resource to a team member",
  );
  assert.equal(
    getAdminAuditActionLabel("unknown_future_action"),
    "Administrative activity",
  );
  assert.equal(
    getAdminAuditDomainLabel("square_attribution"),
    "Square sales matching",
  );
  assert.equal(getAdminAuditDomainLabel("unknown_domain"), "Administration");
  assert.deepEqual(getAdminAuditOutcomePresentation("denied"), {
    label: "Denied",
    tone: "attention",
  });
});

test("legacy employee terminology is replaced across visible text and identifiers", () => {
  const cases = [
    ["Employee", "Contractor"],
    ["Employees", "Contractors"],
    ["employees", "contractors"],
    ["EMPLOYEE", "CONTRACTOR"],
    ["EMPLOYEES", "CONTRACTORS"],
    ["Employee's calendar", "Contractor's calendar"],
    ["employee-owned calendar", "contractor-owned calendar"],
    [
      "employee_calendar_connection_created",
      "contractor_calendar_connection_created",
    ],
    ["No terminology change", "No terminology change"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(toContractorTerminology(input), expected);
  }
});

function assertHumanPresentations<T extends string>(
  values: readonly T[],
  present: (value: T) => AdminStatusPresentation,
) {
  for (const value of values) {
    const presentation = present(value);
    assert.ok(presentation.label.length > 0);
    assert.doesNotMatch(presentation.label, /_/);
    assert.notEqual(presentation.label, value);
    assert.ok(["attention", "neutral", "success"].includes(presentation.tone));
  }
}

function assertHumanLabels<T extends string>(
  values: readonly T[],
  getLabel: (value: T) => string,
) {
  for (const value of values) {
    const label = getLabel(value);
    assert.ok(label.length > 0);
    assert.doesNotMatch(label, /_/);
    assert.notEqual(label, value);
  }
}

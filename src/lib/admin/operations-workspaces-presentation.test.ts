import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_WORKSPACE_PAGE_SIZE,
  ADMIN_WORKSPACE_SEARCH_LIMIT,
  getAdminWorkspacePagination,
  getBookingIssuePresentation,
  getCheckoutPurposePresentation,
  getHumanTimezoneLabel,
  getInquiryContentPresentation,
  getProductConfirmationPresentation,
  getTrainingNotificationPresentation,
  getTrainingSchedulingPresentation,
  normalizeAdminWorkspaceSearch,
  readSnapshotLabel,
} from "./operations-workspaces-presentation";

test("workspace search and pagination stay bounded", () => {
  assert.equal(normalizeAdminWorkspaceSearch("  ava  "), "ava");
  assert.equal(
    normalizeAdminWorkspaceSearch("x".repeat(200)).length,
    ADMIN_WORKSPACE_SEARCH_LIMIT,
  );
  assert.deepEqual(getAdminWorkspacePagination(99, 41), {
    offset: 40,
    page: 3,
    pageCount: 3,
    pageSize: ADMIN_WORKSPACE_PAGE_SIZE,
  });
  assert.equal(getAdminWorkspacePagination(-2, 0).page, 1);
});

test("product confirmation uses delivery evidence without inventing fulfillment state", () => {
  assert.deepEqual(
    getProductConfirmationPresentation({
      lastError: "provider-internal-error",
      sentAt: null,
      status: "paid",
    }),
    {
      description: "The customer order confirmation could not be delivered.",
      label: "Delivery needs attention",
      tone: "attention",
    },
  );
  assert.equal(
    getProductConfirmationPresentation({
      lastError: null,
      sentAt: null,
      status: "pending",
    }).label,
    "Starts after payment",
  );
  assert.equal(
    getProductConfirmationPresentation({
      lastError: null,
      sentAt: new Date("2026-07-20T12:00:00.000Z"),
      status: "refunded",
    }).label,
    "Confirmation sent",
  );
});

test("training scheduling labels only states supported by enrollment records", () => {
  const now = new Date("2026-07-29T18:00:00.000Z");

  assert.equal(
    getTrainingSchedulingPresentation({
      enrollmentStatus: null,
      hasEnrollment: false,
      now,
      orderStatus: "paid",
      providerStatus: null,
      tokenExpiresAt: null,
      tokenUsedAt: null,
    }).label,
    "Enrollment setup needs attention",
  );

  const scheduled = getTrainingSchedulingPresentation({
    enrollmentStatus: "scheduled",
    hasEnrollment: true,
    now,
    orderStatus: "paid",
    providerStatus: null,
    tokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
    tokenUsedAt: new Date("2026-07-28T00:00:00.000Z"),
  });
  assert.equal(scheduled.label, "Scheduling recorded");
  assert.match(scheduled.description ?? "", /details are not stored/i);

  assert.equal(
    getTrainingSchedulingPresentation({
      enrollmentStatus: "scheduled",
      hasEnrollment: true,
      now,
      orderStatus: "refunded",
      providerStatus: null,
      tokenExpiresAt: null,
      tokenUsedAt: new Date("2026-07-28T00:00:00.000Z"),
    }).label,
    "Scheduling recorded",
  );
  assert.equal(
    getTrainingNotificationPresentation({
      hasEnrollment: true,
      lastError: null,
      orderStatus: "refunded",
      staffAlertedAt: new Date("2026-07-20T12:00:00.000Z"),
      studentEmailSentAt: new Date("2026-07-20T12:00:00.000Z"),
    }).label,
    "Notifications sent",
  );
});

test("booking issue labels describe review evidence and do not expose raw codes", () => {
  const issue = getBookingIssuePresentation({
    appointmentId: null,
    finalizationStatus: "refund_required",
    hasCustomerEmailFailure: false,
    hasPaymentEvidence: true,
    holdStatus: "refund_required",
  });

  assert.deepEqual(issue, {
    description:
      "Payment evidence requires manual refund or cancellation verification. No refund action is available here.",
    label: "Refund review needed",
    tone: "attention",
  });
  assert.doesNotMatch(JSON.stringify(issue), /refund_required/);

  assert.match(
    getBookingIssuePresentation({
      appointmentId: null,
      finalizationStatus: "refund_required",
      hasCustomerEmailFailure: false,
      hasPaymentEvidence: false,
      holdStatus: "refund_required",
    }).description ?? "",
    /capture is not verified/i,
  );
});

test("checkout purposes use business labels", () => {
  assert.deepEqual(getCheckoutPurposePresentation("product"), {
    label: "Product order",
    shortLabel: "Product",
  });
  assert.deepEqual(
    getCheckoutPurposePresentation("appointment_custom_partial"),
    {
      label: "Appointment partial payment",
      shortLabel: "Partial payment",
    },
  );
});

test("inquiry presentation allowlists customer-facing payload fields", () => {
  const inquiry = getInquiryContentPresentation({
    payload: {
      internalDocumentId: "secret-id",
      location: "Toronto",
      programSlug: "internal-slug",
      programTitle: "Classic Lash Training",
      submissionKey: "private-key",
    },
    submissionType: "training_contact",
  });

  assert.deepEqual(inquiry, {
    detailLines: ["Location: Toronto"],
    message: null,
    messageTruncated: false,
    redacted: false,
    subject: "Classic Lash Training",
  });
  assert.doesNotMatch(
    JSON.stringify(inquiry),
    /internalDocumentId|internal-slug|private-key|submissionKey/,
  );
});

test("inquiry messages are bounded and retained redactions stay explicit", () => {
  const longMessage = getInquiryContentPresentation({
    payload: { message: "x".repeat(4_010) },
    submissionType: "general_inquiry",
  });
  assert.equal(longMessage.messageTruncated, true);
  assert.equal(longMessage.message?.length, 4_001);

  assert.equal(
    getInquiryContentPresentation({
      payload: { redacted: true, secret: "do-not-render" },
      submissionType: "general_inquiry",
    }).redacted,
    true,
  );
});

test("snapshot and timezone labels avoid internal values in normal presentation", () => {
  assert.equal(
    readSnapshotLabel(
      { displayTitle: "Volume refill", offeringId: "internal-id" },
      ["displayTitle"],
      "Service unavailable",
    ),
    "Volume refill",
  );
  assert.equal(getHumanTimezoneLabel("America/Toronto"), "Toronto time");
  assert.equal(
    getHumanTimezoneLabel("America/Los_Angeles"),
    "Los Angeles time",
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  adminAuditLogs,
  adminAuditOutcome,
  adminRole,
  adminUserResources,
  adminUsers,
  adminUserStatus,
  appointmentCalendarEvents,
  appointmentCalendarSyncStatus,
  appointmentEvents,
  appointmentHolds,
  appointmentHoldStatus,
  appointments,
  appointmentStatus,
  bookingBusinessSettings,
  bookingCalendarConnections,
  bookingConfigurationStatus,
  bookingNoShowChargeAttempts,
  bookingNoShowChargeRecords,
  bookingOfferingCopyProvenance,
  bookingPaymentAttempts,
  bookingPolicyAcceptances,
  bookingProviders,
  bookingResourceCalendarAssignments,
  bookingResourceReservations,
  bookingResourceScheduleExceptions,
  bookingResourceSchedules,
  bookingResources,
  bookingSavedPaymentMethods,
  bookingServices,
  bookingServiceOfferingAddOns,
  bookingServiceOfferingResources,
  bookingServiceOfferings,
  bookingServicePromotionCodes,
  bookingServicePromotionOfferings,
  bookingSquareCustomers,
  calendarFinalizationStatus,
  checkoutOrders,
  checkoutPaymentEvents,
  checkoutOrderPurpose,
  fulfillmentDataQuarantine,
  fulfillmentProviderCertifications,
  fulfillmentRiskAlertOutbox,
  marketingConsentEvents,
  marketingContactSyncJobs,
  noShowChargeStatus,
  orderPaymentObligations,
  paymentEventProcessingStatus,
  paymentProvider,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productShipmentJobs,
  productShipmentReturnObservations,
  productShipments,
  productShippingCases,
  savedPaymentMethodStatus,
  shippingCalendarVersions,
  squareTeamMemberMappingStatus,
} from "./schema";

function getIndexNames(
  table:
    | typeof appointmentHolds
    | typeof appointments
    | typeof appointmentCalendarEvents
    | typeof adminUsers
    | typeof adminUserResources
    | typeof adminAuditLogs
    | typeof bookingResources
    | typeof bookingProviders
    | typeof bookingCalendarConnections
    | typeof bookingResourceCalendarAssignments
    | typeof bookingResourceReservations
    | typeof bookingServiceOfferings
    | typeof bookingServicePromotionCodes
    | typeof bookingServicePromotionOfferings
    | typeof bookingPaymentAttempts
    | typeof bookingNoShowChargeRecords
    | typeof checkoutOrders
    | typeof checkoutPaymentEvents
    | typeof marketingContactSyncJobs,
): string[] {
  const names: string[] = [];

  for (const index of getTableConfig(table).indexes) {
    if (typeof index.config.name === "string") {
      names.push(index.config.name);
    }
  }

  return names.sort();
}

test("appointment hold status enum matches booking lifecycle states", () => {
  assert.deepEqual(appointmentHoldStatus.enumValues, [
    "held",
    "payment_pending",
    "paid_pending_booking",
    "booked",
    "expired",
    "payment_failed",
    "booking_failed",
    "manual_followup",
    "paid_unbookable_rebooking_pending",
    "manual_rebooked",
    "refund_required",
    "refunded",
    "released",
  ]);
});

test("checkout order purpose enum includes custom partial appointment payments", () => {
  assert.deepEqual(checkoutOrderPurpose.enumValues, [
    "product",
    "training",
    "appointment_deposit",
    "appointment_full",
    "appointment_custom_partial",
  ]);
});

test("payment provider enum keeps Helcim compatibility and adds Square", () => {
  assert.deepEqual(paymentProvider.enumValues, ["helcim", "square"]);
});

test("calendar finalization status enum supports rebooking and refund states", () => {
  assert.deepEqual(calendarFinalizationStatus.enumValues, [
    "not_required",
    "pending",
    "paid_calendar_pending",
    "booked",
    "paid_unbookable_rebooking_pending",
    "manual_rebooked",
    "refund_required",
    "refunded",
    "failed",
    "manual_review",
  ]);
});

test("payment event processing status enum supports idempotent webhook handling", () => {
  assert.deepEqual(paymentEventProcessingStatus.enumValues, [
    "received",
    "processed",
    "duplicate",
    "ignored",
    "failed",
    "review_required",
    "retryable_failed",
  ]);
});

test("checkout orders schema exposes provider and calendar finalization fields", () => {
  const columnNames = Object.keys(checkoutOrders);

  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("providerCheckoutId"));
  assert.ok(columnNames.includes("providerOrderId"));
  assert.ok(columnNames.includes("providerPaymentId"));
  assert.ok(columnNames.includes("providerStatus"));
  assert.ok(columnNames.includes("providerMetadata"));
  assert.ok(columnNames.includes("squarePaymentLinkId"));
  assert.ok(columnNames.includes("squarePaymentLinkUrl"));
  assert.ok(columnNames.includes("squareLocationId"));
  assert.ok(columnNames.includes("squareTipAmountCents"));
  assert.ok(columnNames.includes("calendarFinalizationStatus"));
  assert.ok(columnNames.includes("calendarEventId"));
  assert.ok(columnNames.includes("finalizedAt"));
  assert.ok(columnNames.includes("shippingAddress"));
});

test("Square checkout orders can be represented without Helcim invoice identifiers", () => {
  const squareOrder: typeof checkoutOrders.$inferInsert = {
    amountCents: 5000,
    checkoutTokenHash: "square-checkout-token-hash",
    currency: "CAD",
    customerEmail: "client@example.com",
    customerName: "Client Example",
    lineItems: [],
    orderId: "lh-square-order",
    paymentProvider: "square",
    secretTokenCiphertext: "encrypted-square-secret",
    squareLocationId: "LOC123",
    squarePaymentLinkId: "plink_123",
    squarePaymentLinkUrl: "https://square.link/u/example",
    status: "pending",
  };

  assert.equal(squareOrder.paymentProvider, "square");
});

test("checkout payment events schema exposes provider event dedupe fields", () => {
  const columnNames = Object.keys(checkoutPaymentEvents);

  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("providerEventId"));
  assert.ok(columnNames.includes("providerCheckoutId"));
  assert.ok(columnNames.includes("providerOrderId"));
  assert.ok(columnNames.includes("providerPaymentId"));
  assert.ok(columnNames.includes("providerStatus"));
  assert.ok(columnNames.includes("payloadHash"));
  assert.ok(columnNames.includes("payloadSanitized"));
  assert.ok(columnNames.includes("processingStatus"));
  assert.ok(columnNames.includes("processedAt"));
});

test("appointment holds schema exposes required lifecycle and reconciliation fields", () => {
  const columnNames = Object.keys(appointmentHolds);

  assert.ok(columnNames.includes("id"));
  assert.ok(columnNames.includes("publicReference"));
  assert.ok(columnNames.includes("offeringId"));
  assert.ok(columnNames.includes("offeringSnapshot"));
  assert.ok(columnNames.includes("bookingType"));
  assert.ok(columnNames.includes("customerSnapshot"));
  assert.ok(columnNames.includes("selectedStart"));
  assert.ok(columnNames.includes("selectedEnd"));
  assert.ok(columnNames.includes("timezone"));
  assert.ok(columnNames.includes("status"));
  assert.ok(columnNames.includes("expiresAt"));
  assert.ok(columnNames.includes("checkoutOrderId"));
  assert.ok(columnNames.includes("checkoutOrderPublicId"));
  assert.ok(columnNames.includes("paymentProvider"));
  assert.ok(columnNames.includes("squarePaymentLinkId"));
  assert.ok(columnNames.includes("squarePaymentLinkUrl"));
  assert.ok(columnNames.includes("squareCheckoutId"));
  assert.ok(columnNames.includes("squarePaymentId"));
  assert.ok(columnNames.includes("squareOrderId"));
  assert.ok(columnNames.includes("googleEventId"));
  assert.ok(columnNames.includes("finalizationStatus"));
  assert.ok(columnNames.includes("finalizationReason"));
  assert.ok(columnNames.includes("manualReviewStatus"));
  assert.ok(columnNames.includes("manualReviewReason"));
  assert.ok(columnNames.includes("failureReason"));
  assert.ok(columnNames.includes("failureMetadata"));
  assert.ok(columnNames.includes("reconciliationMetadata"));
  assert.ok(columnNames.includes("releasedAt"));
  assert.ok(columnNames.includes("paidAt"));
  assert.ok(columnNames.includes("bookedAt"));
  assert.ok(columnNames.includes("expiredAt"));
  assert.ok(columnNames.includes("paymentFailedAt"));
  assert.ok(columnNames.includes("bookingFailedAt"));
  assert.ok(columnNames.includes("manualFollowupAt"));
  assert.ok(columnNames.includes("createdAt"));
  assert.ok(columnNames.includes("updatedAt"));
});

test("provider-aware unique indexes guard duplicate event and calendar correlation", () => {
  assert.deepEqual(getIndexNames(checkoutPaymentEvents), [
    "checkout_payment_events_idempotency_key_idx",
    "checkout_payment_events_provider_event_idx",
  ]);

  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_calendar_event_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_square_correlation_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_checkout_order_public_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_google_event_id_idx",
    ),
  );
});

test("Square provider indexes guard duplicate checkout, order, and payment IDs", () => {
  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_provider_checkout_idx",
    ),
  );
  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_provider_order_idx",
    ),
  );
  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_provider_payment_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_square_payment_link_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_square_checkout_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_square_payment_id_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_square_order_id_idx",
    ),
  );
});

test("appointment holds expose opaque payment session handoff reference", () => {
  const schemaSource = readFileSync(
    new URL("./schema.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    schemaSource,
    /paymentSessionReference:\s*text\("payment_session_reference"\)\.notNull\(\)/,
  );
  assert.match(
    schemaSource,
    /uniqueIndex\("appointment_holds_payment_session_reference_idx"\)\.on\(\s*table\.paymentSessionReference,?\s*\)/,
  );
});

test("rebooking-first hold state can be represented before Calendar correlation", () => {
  const rebookingState =
    "paid_unbookable_rebooking_pending" satisfies (typeof appointmentHoldStatus.enumValues)[number];
  const finalizationState =
    "paid_unbookable_rebooking_pending" satisfies (typeof calendarFinalizationStatus.enumValues)[number];

  assert.equal(rebookingState, "paid_unbookable_rebooking_pending");
  assert.equal(finalizationState, "paid_unbookable_rebooking_pending");
  assert.ok(Object.keys(appointmentHolds).includes("googleEventId"));
});

test("saved payment method status enum supports active, replaced, disabled, and failure states", () => {
  assert.ok(savedPaymentMethodStatus.enumValues.includes("active"));
  assert.ok(savedPaymentMethodStatus.enumValues.includes("disabled"));
});

test("no-show charge status enum supports ready and charge_failed states", () => {
  assert.ok(noShowChargeStatus.enumValues.includes("ready"));
  assert.ok(noShowChargeStatus.enumValues.includes("charge_failed"));
});

test("saved cards, policy acceptance, and no-show tables are exported", () => {
  assert.ok(bookingSquareCustomers);
  assert.ok(bookingSavedPaymentMethods);
  assert.ok(bookingPolicyAcceptances);
  assert.ok(bookingNoShowChargeRecords);
  assert.ok(bookingNoShowChargeAttempts);
});

test("appointment holds schema exposes card-on-file and no-show correlation fields", () => {
  const columnNames = Object.keys(appointmentHolds);

  assert.ok(columnNames.includes("savedPaymentMethodId"));
  assert.ok(columnNames.includes("policyAcceptanceId"));
  assert.ok(columnNames.includes("noShowChargeRecordId"));
  assert.ok(columnNames.includes("squareCustomerId"));
  assert.ok(columnNames.includes("squareCardId"));
  assert.ok(columnNames.includes("cardOnFileStatus"));
  assert.ok(columnNames.includes("noShowInvoiceId"));
  assert.ok(columnNames.includes("noShowInvoiceOrderId"));
  assert.ok(columnNames.includes("noShowInvoiceStatus"));
});

test("appointment hold policy and no-show links are foreign-key backed", () => {
  const foreignKeyNames = getTableConfig(appointmentHolds)
    .foreignKeys.map((foreignKey) => foreignKey.getName())
    .sort();

  assert.ok(
    foreignKeyNames.includes(
      "appointment_holds_policy_acceptance_id_booking_policy_acceptances_id_fk",
    ),
    "policy acceptance foreign key is configured",
  );
  assert.ok(
    foreignKeyNames.includes(
      "appointment_holds_no_show_charge_record_id_booking_no_show_charge_records_id_fk",
    ),
    "no-show charge record foreign key is configured",
  );
});

test("checkout payment events schema can correlate to a no-show charge record", () => {
  assert.ok(
    Object.keys(checkoutPaymentEvents).includes("noShowChargeRecordId"),
  );
});

test("no-show charge records index square order id for delayed invoice webhook correlation", () => {
  assert.ok(
    getIndexNames(bookingNoShowChargeRecords).includes(
      "booking_no_show_charge_records_square_order_id_idx",
    ),
  );
});

test("no-show charge records expose admin audit fields", () => {
  assert.ok(bookingNoShowChargeRecords.adminActionAt);
  assert.ok(bookingNoShowChargeRecords.adminOperatorId);
  assert.ok(bookingNoShowChargeRecords.adminReason);
  assert.ok(bookingNoShowChargeRecords.adminEligibilityCheckedAt);
});

test("appointment holds schema does not define raw card numbers, CVV, tokens, or secrets", () => {
  const columnNameText = Object.keys(appointmentHolds).join(" ").toLowerCase();

  assert.equal(columnNameText.includes("cardnumber"), false);
  assert.equal(columnNameText.includes("cvv"), false);
  assert.equal(columnNameText.includes("cvc"), false);
  assert.equal(columnNameText.includes("pan"), false);
  assert.equal(columnNameText.includes("token"), false);
  assert.equal(columnNameText.includes("secret"), false);
});

test("marketing consent events preserve evidence when submissions are deleted", () => {
  const consentEventForeignKeys = getTableConfig(
    marketingConsentEvents,
  ).foreignKeys;
  const submissionForeignKey = consentEventForeignKeys.find(
    (foreignKey) =>
      foreignKey.getName() ===
      "marketing_consent_events_submission_id_marketing_contact_submissions_id_fk",
  );

  assert.equal(marketingConsentEvents.submissionId.notNull, false);
  assert.equal(submissionForeignKey?.onDelete, "set null");
});

test("payment reconciliation indexes support paid Square appointment order scans", () => {
  const migrationSql = readFileSync(
    new URL("../../../drizzle/0017_big_hulk.sql", import.meta.url),
    "utf8",
  );

  assert.ok(
    getIndexNames(checkoutOrders).includes(
      "checkout_orders_paid_square_appointment_not_booked_idx",
    ),
  );
  assert.ok(
    getIndexNames(appointmentHolds).includes(
      "appointment_holds_square_cof_checkout_order_id_idx",
    ),
  );
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS "checkout_orders_paid_square_appointment_not_booked_idx" ON "checkout_orders" USING btree \("paid_at","id","order_id"\)/,
  );
  assert.match(
    migrationSql,
    /"checkout_orders"\."status" = 'paid' AND "checkout_orders"\."payment_provider" = 'square'/,
  );
  assert.match(
    migrationSql,
    /"checkout_orders"\."purpose" IN \('appointment_deposit', 'appointment_full', 'appointment_custom_partial'\)/,
  );
  assert.match(
    migrationSql,
    /"checkout_orders"\."calendar_finalization_status" NOT IN \('not_required', 'booked', 'manual_rebooked'\)/,
  );
  assert.match(
    migrationSql,
    /CREATE INDEX IF NOT EXISTS "appointment_holds_square_cof_checkout_order_id_idx" ON "appointment_holds" USING btree \("checkout_order_id","id"\)/,
  );
  assert.match(
    migrationSql,
    /"appointment_holds"\."card_on_file_status" IS NOT NULL/,
  );
});

test("marketing contact sync jobs enforce idempotent consent outbox entries", () => {
  const indexes = getIndexNames(marketingContactSyncJobs);

  assert.ok(indexes.includes("marketing_contact_sync_jobs_submission_id_idx"));
  assert.ok(
    indexes.includes("marketing_contact_sync_jobs_consent_event_id_idx"),
  );
  assert.ok(
    indexes.includes("marketing_contact_sync_jobs_status_next_run_at_idx"),
  );
});

test("admin roles support owner, admin, and resource-scoped employee access", () => {
  assert.deepEqual(adminRole.enumValues, ["owner", "admin", "employee"]);
  assert.deepEqual(adminUserStatus.enumValues, ["active", "disabled"]);
  assert.deepEqual(adminAuditOutcome.enumValues, [
    "success",
    "denied",
    "failure",
  ]);

  assert.deepEqual(
    [
      "providerUserId",
      "email",
      "emailNormalized",
      "displayName",
      "role",
      "status",
      "lastSignedInAt",
    ].every((column) => Object.keys(adminUsers).includes(column)),
    true,
  );
  assert.ok(Object.keys(adminUserResources).includes("bookingResourceId"));
  assert.ok(
    getIndexNames(adminUserResources).includes(
      "admin_user_resources_user_resource_idx",
    ),
  );
});

test("admin audit logs store hashed request evidence without raw network fields", () => {
  const columns = Object.keys(adminAuditLogs);

  for (const column of [
    "actorAdminUserId",
    "actorRole",
    "action",
    "domain",
    "outcome",
    "targetType",
    "targetId",
    "correlationId",
    "ipHash",
    "userAgentHash",
    "metadata",
  ]) {
    assert.ok(columns.includes(column));
  }

  assert.equal(columns.includes("ipAddress"), false);
  assert.equal(columns.includes("userAgent"), false);
});

test("booking configuration schema separates resources, providers, services, and offerings", () => {
  assert.deepEqual(bookingConfigurationStatus.enumValues, [
    "draft",
    "active",
    "disabled",
    "archived",
  ]);

  for (const table of [
    bookingResources,
    bookingProviders,
    bookingServices,
    bookingServiceOfferings,
    bookingServiceOfferingAddOns,
    bookingServiceOfferingResources,
    bookingServicePromotionCodes,
    bookingServicePromotionOfferings,
    bookingBusinessSettings,
  ]) {
    assert.ok(table);
  }

  assert.ok(Object.keys(bookingProviders).includes("primaryResourceId"));
  assert.ok(Object.keys(bookingServices).includes("ownerProviderId"));
  assert.ok(Object.keys(bookingServiceOfferings).includes("providerId"));
  assert.ok(Object.keys(bookingServiceOfferings).includes("publicTitle"));
  assert.ok(Object.keys(bookingServiceOfferings).includes("publicSummary"));
  assert.deepEqual(bookingOfferingCopyProvenance.enumValues, [
    "legacy",
    "admin",
  ]);
  assert.equal(bookingServiceOfferings.publicTitleProvenance.default, "legacy");
  assert.equal(
    bookingServiceOfferings.publicSummaryProvenance.default,
    "legacy",
  );
  assert.ok(
    Object.keys(bookingServicePromotionCodes).includes(
      "sourceSanityDocumentId",
    ),
  );
  assert.ok(
    Object.keys(bookingServiceOfferings).includes("bufferBeforeMinutes"),
  );
  assert.ok(
    Object.keys(bookingServiceOfferings).includes("bufferAfterMinutes"),
  );
  assert.ok(
    getIndexNames(bookingServiceOfferings).includes(
      "booking_service_offerings_active_service_provider_idx",
    ),
  );
  assert.equal(bookingBusinessSettings.intakeQuestions.notNull, true);
  assert.equal(bookingBusinessSettings.marketingOptInLabel.notNull, true);
  assert.equal(bookingServicePromotionCodes.code.notNull, true);
  assert.equal(bookingServicePromotionCodes.discountValue.notNull, true);
  assert.ok(
    getIndexNames(bookingServicePromotionCodes).includes(
      "booking_service_promotion_codes_code_idx",
    ),
  );
  assert.ok(
    getIndexNames(bookingServicePromotionCodes).includes(
      "booking_service_promotion_codes_sanity_document_idx",
    ),
  );
  assert.ok(
    getIndexNames(bookingServicePromotionOfferings).includes(
      "booking_service_promotion_offerings_pair_idx",
    ),
  );
});

test("booking service identity is unique within each provider", () => {
  const indexes = new Map(
    getTableConfig(bookingServices).indexes.map((index) => [
      index.config.name,
      {
        columns: index.config.columns.map((column) =>
          "name" in column ? column.name : null,
        ),
        unique: index.config.unique,
      },
    ]),
  );

  assert.deepEqual(indexes.get("booking_services_service_key_idx"), {
    columns: ["owner_provider_id", "service_key"],
    unique: true,
  });
  assert.deepEqual(indexes.get("booking_services_sanity_document_idx"), {
    columns: ["owner_provider_id", "sanity_document_id"],
    unique: true,
  });
  assert.deepEqual(indexes.get("booking_services_public_slug_idx"), {
    columns: ["owner_provider_id", "public_slug"],
    unique: true,
  });
});

test("offering copy provenance migration leaves generated copy legacy-owned", () => {
  const migrationSql = readFileSync(
    new URL("../../../drizzle/0028_lucky_lady_ursula.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migrationSql,
    /CREATE TYPE "public"\."booking_offering_copy_provenance" AS ENUM\('legacy', 'admin'\)/,
  );
  assert.doesNotMatch(migrationSql, /admin_audit_logs/);
  assert.doesNotMatch(migrationSql, /\bUPDATE\b/);
});

test("resource schedules support recurring windows and absolute exceptions", () => {
  for (const column of [
    "resourceId",
    "weekday",
    "startsAt",
    "endsAt",
    "timezone",
    "effectiveFrom",
    "effectiveUntil",
  ]) {
    assert.ok(Object.keys(bookingResourceSchedules).includes(column));
  }

  for (const column of [
    "resourceId",
    "kind",
    "status",
    "startsAt",
    "endsAt",
    "timezone",
  ]) {
    assert.ok(Object.keys(bookingResourceScheduleExceptions).includes(column));
  }
});

test("calendar connections keep credentials private and assignments select one write calendar", () => {
  const connectionColumns = Object.keys(bookingCalendarConnections);
  const assignmentChecks = getTableConfig(
    bookingResourceCalendarAssignments,
  ).checks.map((check) => check.name);

  assert.ok(connectionColumns.includes("credentialCiphertext"));
  assert.ok(connectionColumns.includes("credentialSecretRef"));
  assert.equal(connectionColumns.includes("refreshToken"), false);
  assert.ok(
    getIndexNames(bookingResourceCalendarAssignments).includes(
      "booking_resource_calendar_assignments_write_idx",
    ),
  );
  assert.ok(
    assignmentChecks.includes(
      "booking_resource_calendar_assignments_has_role_check",
    ),
  );
});

test("offering add-ons enforce positive price and nonnegative duration", () => {
  const checkNames = getTableConfig(bookingServiceOfferingAddOns).checks.map(
    (check) => check.name,
  );

  assert.ok(
    checkNames.includes("booking_service_offering_add_ons_price_check"),
  );
  assert.ok(
    checkNames.includes("booking_service_offering_add_ons_duration_check"),
  );
});

test("appointment holds preserve V1 fields and add nullable V2 routing fields", () => {
  const columns = Object.keys(appointmentHolds);
  const checkNames = getTableConfig(appointmentHolds).checks.map(
    (check) => check.name,
  );

  for (const column of [
    "bookingModelVersion",
    "serviceOfferingId",
    "providerId",
    "primaryResourceId",
    "providerSnapshot",
    "configurationVersion",
    "occupiedStart",
    "occupiedEnd",
    "calendarAssignmentId",
    "googleCalendarId",
    "providerBookingEmailSentAt",
    "providerBookingEmailClaimedUntil",
    "providerBookingEmailLastError",
  ]) {
    assert.ok(columns.includes(column));
  }

  assert.ok(columns.includes("offeringId"));
  assert.ok(columns.includes("googleEventId"));
  assert.equal(appointmentHolds.serviceOfferingId.notNull, false);
  assert.equal(appointmentHolds.primaryResourceId.notNull, false);
  assert.ok(
    checkNames.includes("appointment_holds_booking_model_version_check"),
  );
  assert.ok(checkNames.includes("appointment_holds_booking_model_v2_check"));
});

test("durable appointments own operational, payment, and calendar-sync state", () => {
  assert.deepEqual(appointmentStatus.enumValues, [
    "confirmed",
    "cancelled",
    "completed",
    "no_show",
    "rebooking_pending",
    "manual_followup",
  ]);
  assert.deepEqual(appointmentCalendarSyncStatus.enumValues, [
    "not_required",
    "pending",
    "synced",
    "retryable_failed",
    "manual_followup",
  ]);

  for (const column of [
    "sourceHoldId",
    "serviceOfferingId",
    "providerId",
    "primaryResourceId",
    "customerEmailNormalized",
    "selectedStart",
    "selectedEnd",
    "occupiedStart",
    "occupiedEnd",
    "paymentStatus",
    "calendarSyncStatus",
  ]) {
    assert.ok(Object.keys(appointments).includes(column));
  }

  assert.ok(
    getIndexNames(appointments).includes("appointments_source_hold_idx"),
  );
  assert.ok(appointmentEvents);
});

test("calendar event identity is scoped to its assignment", () => {
  assert.ok(
    getIndexNames(appointmentCalendarEvents).includes(
      "appointment_calendar_events_assignment_event_idx",
    ),
  );
  assert.ok(
    Object.keys(appointmentCalendarEvents).includes("providerCalendarId"),
  );
});

test("resource reservations expose one unified occupancy ledger", () => {
  const columns = Object.keys(bookingResourceReservations);

  for (const column of [
    "resourceId",
    "holdId",
    "appointmentId",
    "scheduleExceptionId",
    "kind",
    "state",
    "occupiedStart",
    "occupiedEnd",
    "expiresAt",
  ]) {
    assert.ok(columns.includes(column));
  }

  assert.ok(
    getIndexNames(bookingResourceReservations).includes(
      "booking_resource_reservations_active_lookup_idx",
    ),
  );
});

test("booking payment attempts support payment saga correlation", () => {
  const columns = Object.keys(bookingPaymentAttempts);

  for (const column of [
    "holdId",
    "appointmentId",
    "checkoutOrderId",
    "operation",
    "status",
    "paymentProvider",
    "idempotencyKey",
    "providerPaymentId",
    "squareTeamMemberId",
    "amountCents",
  ]) {
    assert.ok(columns.includes(column));
  }

  assert.ok(
    getIndexNames(bookingPaymentAttempts).includes(
      "booking_payment_attempts_idempotency_idx",
    ),
  );
});

test("Square team attribution fields are nullable and migration-safe", () => {
  assert.deepEqual(squareTeamMemberMappingStatus.enumValues, [
    "active",
    "inactive",
    "missing",
  ]);

  for (const column of [
    "squareTeamMemberId",
    "squareTeamMemberDisplayLabel",
    "squareTeamMemberStatus",
    "squareTeamMemberVerifiedAt",
  ]) {
    assert.ok(Object.keys(bookingProviders).includes(column));
  }
  assert.equal(bookingProviders.squareTeamMemberId.notNull, false);
  assert.ok(
    getIndexNames(bookingProviders).includes(
      "booking_providers_square_team_member_idx",
    ),
  );
  assert.equal(
    bookingBusinessSettings.requireSquareTeamAttribution.notNull,
    true,
  );
  assert.equal(
    bookingBusinessSettings.requireSquareTeamAttribution.default,
    false,
  );
});

test("calendar credential ownership and immutable attribution snapshots are stored", () => {
  assert.ok(
    Object.keys(bookingCalendarConnections).includes(
      "credentialOwnerAdminUserId",
    ),
  );
  assert.equal(
    bookingCalendarConnections.credentialOwnerAdminUserId.notNull,
    false,
  );
  assert.ok(Object.keys(appointmentHolds).includes("squareTeamMemberId"));
  assert.ok(Object.keys(appointments).includes("squareTeamMemberId"));

  const migrationSql = readFileSync(
    new URL(
      "../../../drizzle/0021_grey_professor_monster.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migrationSql,
    /require_square_team_attribution" boolean DEFAULT false NOT NULL/,
  );
  assert.match(migrationSql, /credential_owner_admin_user_id" uuid/);
});

test("policy and no-show evidence can link to durable appointments", () => {
  assert.ok(Object.keys(bookingPolicyAcceptances).includes("appointmentId"));
  assert.ok(Object.keys(bookingNoShowChargeRecords).includes("appointmentId"));

  const policyForeignKeys = getTableConfig(
    bookingPolicyAcceptances,
  ).foreignKeys.map((foreignKey) => foreignKey.getName());
  const noShowForeignKeys = getTableConfig(
    bookingNoShowChargeRecords,
  ).foreignKeys.map((foreignKey) => foreignKey.getName());

  assert.ok(
    policyForeignKeys.includes(
      "booking_policy_acceptances_appointment_id_appointments_id_fk",
    ),
  );
  assert.ok(
    noShowForeignKeys.includes(
      "booking_no_show_charge_records_appointment_id_appointments_id_fk",
    ),
  );
});

test("intake-location migration creates no manufactured attestation", () => {
  const migrationSql = readFileSync(
    new URL("../../../drizzle/0041_illegal_pestilence.sql", import.meta.url),
    "utf8",
  );
  assert.match(migrationSql, /chitchats_intake_location_attestations/);
  assert.doesNotMatch(
    migrationSql,
    /INSERT\s+INTO\s+"?chitchats_intake_location_attestations"?/i,
  );
});

test("product fulfillment identity indexes exclude compatibility quarantine", () => {
  const obligationIndex = getTableConfig(orderPaymentObligations).indexes.find(
    (index) =>
      index.config.name === "order_payment_obligations_one_primary_idx",
  );
  const caseIndex = getTableConfig(productShippingCases).indexes.find(
    (index) => index.config.name === "product_shipping_cases_one_active_idx",
  );
  const refundIndex = getTableConfig(productOrderRefunds).indexes.find(
    (index) =>
      index.config.name === "product_order_refunds_provider_refund_id_idx",
  );

  for (const index of [obligationIndex, caseIndex, refundIndex]) {
    assert.ok(index?.config.unique);
    assert.ok(index.config.where);
  }
  assert.ok(Object.keys(fulfillmentDataQuarantine).includes("redactedAt"));
  assert.ok(
    Object.keys(productOrderRefunds).includes("fulfillmentQuarantinedAt"),
  );
});

test("shipping cases expose a checked optimistic-concurrency version", () => {
  const config = getTableConfig(productShippingCases);
  assert.ok(Object.keys(productShippingCases).includes("stateVersion"));
  assert.ok(
    config.checks.some(
      (constraint) =>
        constraint.name === "product_shipping_cases_state_version_check",
    ),
  );
});

test("readiness evidence tables expose immutable version foundations", () => {
  assert.ok(Object.keys(shippingCalendarVersions).includes("closureDates"));
  assert.ok(
    Object.keys(fulfillmentProviderCertifications).includes("contractSnapshot"),
  );
  assert.ok(
    Object.keys(productShipments).includes("usShippingContractSnapshot"),
  );
  assert.ok(Object.keys(fulfillmentRiskAlertOutbox).includes("redactionDueAt"));

  const providerChecks = getTableConfig(
    fulfillmentProviderCertifications,
  ).checks.map((constraint) => constraint.name);
  assert.ok(
    providerChecks.includes(
      "fulfillment_provider_certifications_us_contract_snapshot_check",
    ),
  );
  assert.ok(
    providerChecks.includes(
      "fulfillment_provider_certifications_helcim_contract_snapshot_check",
    ),
  );
});

test("provider certification identity permits revoked history but only one active scope", () => {
  const config = getTableConfig(fulfillmentProviderCertifications);
  const activeScopeIndex = config.indexes.find(
    (index) =>
      index.config.name ===
      "fulfillment_provider_certifications_one_active_scope_idx",
  );

  assert.ok(activeScopeIndex?.config.unique);
  assert.ok(activeScopeIndex.config.where);
  assert.deepEqual(
    activeScopeIndex.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ),
    ["provider", "environment", "scope"],
  );
  assert.ok(
    !config.indexes.some(
      (index) =>
        index.config.name ===
        "fulfillment_provider_certifications_identity_idx",
    ),
  );

  const migrationSql = readFileSync(
    new URL("../../../drizzle/0058_worthless_shriek.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migrationSql,
    /DROP INDEX "fulfillment_provider_certifications_identity_idx"/,
  );
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX "fulfillment_provider_certifications_one_active_scope_idx"[\s\S]*\("provider","environment","scope"\)[\s\S]*WHERE[\s\S]*"revoked_at" IS NULL/,
  );
  assert.match(migrationSql, /duplicate_active_provider_certification_scope/);
  assert.match(migrationSql, /HAVING count\(\*\) > 1/);
  assert.match(
    migrationSql,
    /SET "revoked_at" = GREATEST\(now\(\), certification\."certified_at"\)/,
  );
  assert.doesNotMatch(migrationSql, /to_jsonb\s*\(/i);
  assert.doesNotMatch(
    migrationSql,
    /customer_(?:name|email)|shipping_address|evidence_reference|certified_by_owner_name/i,
  );
});

test("operations actions use complete evidence groups and versioned return observations", () => {
  const expectedChecks = [
    [
      productOrderCustomerDecisions,
      "product_order_customer_decisions_legal_follow_up_evidence_check",
    ],
    [productOrderRefunds, "product_order_refunds_manual_review_evidence_check"],
    [
      productShipmentJobs,
      "product_shipment_jobs_reconciliation_evidence_check",
    ],
    [
      productShipmentReturnObservations,
      "product_shipment_returns_admin_resolution_check",
    ],
    [
      productShipmentReturnObservations,
      "product_shipment_returns_state_version_check",
    ],
    [productShipments, "product_shipments_manual_review_evidence_check"],
  ] as const;

  for (const [table, checkName] of expectedChecks) {
    assert.ok(
      getTableConfig(table).checks.some(
        (constraint) => constraint.name === checkName,
      ),
      `${checkName} should be enforced`,
    );
  }
  assert.ok(
    Object.keys(productShipmentReturnObservations).includes("stateVersion"),
  );
  assert.ok(
    Object.keys(productShipmentReturnObservations).includes(
      "resolvedStateVersion",
    ),
  );

  const migrationSql = readFileSync(
    new URL("../../../drizzle/0059_eminent_praxagora.sql", import.meta.url),
    "utf8",
  );
  for (const [, checkName] of expectedChecks) {
    assert.match(migrationSql, new RegExp(checkName));
  }
  assert.match(
    migrationSql,
    /ADD COLUMN "state_version" integer DEFAULT 1 NOT NULL/,
  );
  assert.match(migrationSql, /ADD COLUMN "resolved_state_version" integer/);
  assert.doesNotMatch(migrationSql, /^(?:UPDATE|DELETE|INSERT)\s/im);
});

test("0060 closes nullable operational-evidence checks without rewriting 0059", () => {
  const migrationSql = readFileSync(
    new URL("../../../drizzle/0060_clever_magma.sql", import.meta.url),
    "utf8",
  );
  const requiredNonNullColumns = [
    "legal_follow_up_evidence_reference",
    "legal_follow_up_rationale",
    "legal_follow_up_by_admin_user_id",
    "legal_follow_up_step_up_authenticated_at",
    "legal_follow_up_recorded_at",
    "manual_review_evidence_reference",
    "manual_review_rationale",
    "manual_review_by_admin_user_id",
    "manual_review_step_up_authenticated_at",
    "manual_review_recorded_at",
    "reconciliation_evidence_reference",
    "reconciliation_rationale",
    "reconciliation_requested_by_admin_user_id",
    "reconciliation_step_up_authenticated_at",
    "reconciliation_requested_at",
    "admin_resolution_action",
    "admin_resolution_evidence_reference",
    "admin_resolution_rationale",
    "resolved_by_admin_user_id",
    "resolution_step_up_authenticated_at",
    "resolved_at",
    "resolved_state_version",
    "manual_review_acknowledged_at",
  ];

  for (const column of requiredNonNullColumns) {
    assert.match(
      migrationSql,
      new RegExp(`"${column}" IS NOT NULL`),
      `${column} must be required in the complete evidence branch`,
    );
  }
  assert.match(
    migrationSql,
    /legacy_primary_obligation_without_authoritative_transaction/,
  );
  assert.match(
    migrationSql,
    /transaction\."provider_transaction_id" = CASE[\s\S]*orders\."helcim_transaction_id"[\s\S]*orders\."provider_payment_id"/,
  );
  assert.doesNotMatch(migrationSql, /INSERT INTO "order_payment_transactions"/);
});

test("day-395 verification covers every redacted 0059 operational evidence field", () => {
  const retentionSource = readFileSync(
    new URL("./shipping-retention.ts", import.meta.url),
    "utf8",
  );
  const absoluteVerifier = retentionSource.slice(
    retentionSource.indexOf("const absoluteViolations"),
    retentionSource.indexOf("if (Number(absoluteViolations"),
  );
  const requiredColumns = [
    "legal_follow_up_evidence_reference",
    "legal_follow_up_rationale",
    "legal_follow_up_by_admin_user_id",
    "legal_follow_up_step_up_authenticated_at",
    "legal_follow_up_recorded_at",
    "manual_review_evidence_reference",
    "manual_review_rationale",
    "manual_review_by_admin_user_id",
    "manual_review_step_up_authenticated_at",
    "manual_review_recorded_at",
    "reconciliation_evidence_reference",
    "reconciliation_rationale",
    "reconciliation_requested_by_admin_user_id",
    "reconciliation_step_up_authenticated_at",
    "reconciliation_requested_at",
    "admin_resolution_action",
    "admin_resolution_evidence_reference",
    "admin_resolution_rationale",
    "resolved_by_admin_user_id",
    "resolution_step_up_authenticated_at",
    "resolved_at",
    "resolved_state_version",
  ];

  for (const column of requiredColumns) {
    assert.match(absoluteVerifier, new RegExp(`\\b${column}\\b`));
  }
});

test("0061 removes legacy Helcim reconciliation text outside retention-managed records", () => {
  const migrationSql = readFileSync(
    new URL(
      "../../../drizzle/0061_helcim_reconciliation_retention.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migrationSql, /payment_obligation\.initialization\.%/);
  assert.match(migrationSql, /legacyReconciliationEvidenceRedacted/);
  assert.match(
    migrationSql,
    /initialization_last_error" = NULL[\s\S]*redacted_at" IS NOT NULL/,
  );
  const retentionSource = readFileSync(
    new URL("./shipping-retention.ts", import.meta.url),
    "utf8",
  );
  assert.match(retentionSource, /initializationLastError: null/);
  assert.match(retentionSource, /initialization_last_error is not null/);
});

test("compatibility migrations preserve duplicate provider identity and history", () => {
  // The duplicate-provider quarantine rebuilds, the obligation quarantine
  // rebuild, and the legacy-evidence redaction markers were consolidated into
  // 0050_long_scrambler.sql (they never shipped as standalone 0035/0041
  // migrations). Scope each group to the exact fulfillment_data_quarantine
  // statements it guards so the assertions below still target only their
  // intended SQL and are not tripped by unrelated statements in the same file.
  const compatibilityMigrationStatements = readFileSync(
    new URL("../../../drizzle/0050_long_scrambler.sql", import.meta.url),
    "utf8",
  ).split("--> statement-breakpoint");
  const quarantineSql = compatibilityMigrationStatements
    .filter(
      (statement) =>
        /UPDATE "fulfillment_data_quarantine"/.test(statement) &&
        /"entity_type" = '(?:checkout_order|product_shipping_case|product_order_refund)'/.test(
          statement,
        ),
    )
    .join("\n");
  const obligationSql = compatibilityMigrationStatements
    .filter(
      (statement) =>
        /UPDATE "fulfillment_data_quarantine"/.test(statement) &&
        /"entity_type" = 'order_payment_obligation'/.test(statement),
    )
    .join("\n");

  assert.match(quarantineSql, /duplicate_helcim_transaction_id/);
  assert.match(quarantineSql, /duplicate_active_case_scope/);
  assert.match(quarantineSql, /duplicate_provider_refund_id/);
  assert.doesNotMatch(quarantineSql, /to_jsonb\((?:o|c|r)\)/);
  assert.equal((quarantineSql.match(/jsonb_build_object\(/g) ?? []).length, 3);
  assert.doesNotMatch(
    quarantineSql,
    /customer_name|customer_email|shipping_address|checkout_token_hash|secret_token_ciphertext|refund_origin_ip_ciphertext|\bc\."cause"|evidence_checklist|\br\."reason"|last_error_code/,
  );
  assert.doesNotMatch(
    quarantineSql,
    /SET[\s\S]{0,300}"(?:helcim_transaction_id|provider_refund_id|status)"\s*=/,
  );
  assert.doesNotMatch(obligationSql, /to_jsonb\((?:obligation|orders)\)/);
  assert.doesNotMatch(
    obligationSql,
    /'checkout_token_hash'|'secret_token_ciphertext'|'disclosure_snapshot'|'customer_name'|'customer_email'|'shipping_address'|'line_items'/,
  );
  const deadlineSql = compatibilityMigrationStatements.join(
    "--> statement-breakpoint",
  );
  assert.match(
    deadlineSql,
    /legacy_evidence_redacted[\s\S]*duplicate_helcim_transaction_id/,
  );
  assert.match(deadlineSql, /duplicate_active_case_scope/);
  assert.match(deadlineSql, /duplicate_provider_refund_id/);
  assert.match(deadlineSql, /duplicate_primary_obligation/);
  assert.doesNotMatch(
    obligationSql,
    /"quarantine_reason" = 'duplicate_primary_obligation',[\s\S]{0,100}"status"\s*=/,
  );
});

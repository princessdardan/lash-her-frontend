import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const checkoutOrderStatus = pgEnum("checkout_order_status", [
  "pending",
  "paid",
  "verification_failed",
  "cancelled",
  "refunded",
]);

export const checkoutOrderPurpose = pgEnum("checkout_order_purpose", [
  "product",
  "training",
  "appointment_deposit",
  "appointment_full",
  "appointment_custom_partial",
]);

export const paymentProvider = pgEnum("payment_provider", ["helcim", "square"]);

export const calendarFinalizationStatus = pgEnum(
  "calendar_finalization_status",
  [
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
  ],
);

export const paymentEventProcessingStatus = pgEnum(
  "payment_event_processing_status",
  ["received", "processed", "duplicate", "ignored", "failed"],
);

export const trainingEnrollmentPurchaseKind = pgEnum(
  "training_enrollment_purchase_kind",
  ["full"],
);

export const trainingEnrollmentSchedulingStatus = pgEnum(
  "training_enrollment_scheduling_status",
  ["pending", "scheduled", "expired", "manual_followup"],
);

export const appointmentHoldStatus = pgEnum("appointment_hold_status", [
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

export const marketingContactSubmissionType = pgEnum(
  "marketing_contact_submission_type",
  [
    "general_inquiry",
    "training_contact",
    "contact_popup",
    "booking_marketing_choice",
    "sanity_backfill",
  ],
);

export const marketingConsentEventType = pgEnum(
  "marketing_consent_event_type",
  ["opt_in", "no_opt_in", "unsubscribe", "backfill_consent"],
);

export const savedPaymentMethodStatus = pgEnum("saved_payment_method_status", [
  "active",
  "replaced",
  "disabled",
  "deleted",
  "charge_failed",
]);

export const noShowChargeStatus = pgEnum("no_show_charge_status", [
  "draft",
  "ready",
  "provider_draft_created",
  "admin_review",
  "charge_pending",
  "charged",
  "charge_failed",
  "voided",
  "expired",
  "manual_followup",
]);

export interface CheckoutOrderLineItemSnapshot {
  productId: string;
  variantId?: string;
  sku: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  originalUnitPriceCents?: number;
  manualDiscountCents?: number;
  promotionCode?: string;
  promotionDiscountCents?: number;
  totalCents: number;
  originalTotalCents?: number;
}

export interface CheckoutOrderShippingAddressSnapshot {
  line1: string;
  line2?: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export type CheckoutOrderStatus =
  (typeof checkoutOrderStatus.enumValues)[number];
export type CheckoutOrderPurpose =
  (typeof checkoutOrderPurpose.enumValues)[number];
export type PaymentProvider = (typeof paymentProvider.enumValues)[number];
export type CalendarFinalizationStatus =
  (typeof calendarFinalizationStatus.enumValues)[number];
export type PaymentEventProcessingStatus =
  (typeof paymentEventProcessingStatus.enumValues)[number];

export interface TrainingEnrollmentProgramSnapshot {
  id: string;
  title: string;
  slug?: string;
}

export interface TrainingEnrollmentProductSnapshot {
  id: string;
  title: string;
  sku: string;
  priceCents: number;
  currency: string;
}

export type TrainingEnrollmentPurchaseKind =
  (typeof trainingEnrollmentPurchaseKind.enumValues)[number];
export type TrainingEnrollmentSchedulingStatus =
  (typeof trainingEnrollmentSchedulingStatus.enumValues)[number];
export type AppointmentHoldStatus =
  (typeof appointmentHoldStatus.enumValues)[number];
export type MarketingContactSubmissionType =
  (typeof marketingContactSubmissionType.enumValues)[number];
export type MarketingConsentEventType =
  (typeof marketingConsentEventType.enumValues)[number];
export type SavedPaymentMethodStatus =
  (typeof savedPaymentMethodStatus.enumValues)[number];
export type NoShowChargeStatus = (typeof noShowChargeStatus.enumValues)[number];

export interface AppointmentHoldOfferingSnapshot {
  [key: string]: unknown;
}

export interface AppointmentHoldCustomerSnapshot {
  email: string;
  name: string;
  phone: string;
}

export interface AppointmentHoldMetadata {
  [key: string]: unknown;
}

export interface CheckoutProviderMetadata {
  [key: string]: unknown;
}

export interface CheckoutPaymentEventPayload {
  [key: string]: unknown;
}

export interface MarketingContactSubmissionPayload {
  [key: string]: unknown;
}

export interface MarketingConsentEventMetadata {
  [key: string]: unknown;
}

export interface BookingNoShowProviderMetadata {
  [key: string]: unknown;
}

export const checkoutOrders = pgTable(
  "checkout_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: text("order_id").notNull().unique(),
    purpose: checkoutOrderPurpose("purpose").notNull().default("product"),
    status: checkoutOrderStatus("status").notNull().default("pending"),
    checkoutTokenHash: text("checkout_token_hash").notNull().unique(),
    secretTokenCiphertext: text("secret_token_ciphertext").notNull(),
    helcimInvoiceId: integer("helcim_invoice_id"),
    helcimInvoiceNumber: text("helcim_invoice_number"),
    helcimTransactionId: text("helcim_transaction_id"),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("helcim"),
    providerCheckoutId: text("provider_checkout_id"),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    providerStatus: text("provider_status"),
    providerMetadata:
      jsonb("provider_metadata").$type<CheckoutProviderMetadata>(),
    squarePaymentLinkId: text("square_payment_link_id"),
    squarePaymentLinkUrl: text("square_payment_link_url"),
    squareLocationId: text("square_location_id"),
    squareTipAmountCents: integer("square_tip_amount_cents"),
    calendarFinalizationStatus: calendarFinalizationStatus(
      "calendar_finalization_status",
    )
      .notNull()
      .default("not_required"),
    calendarEventId: text("calendar_event_id"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    productConfirmationEmailSentAt: timestamp(
      "product_confirmation_email_sent_at",
      { withTimezone: true },
    ),
    productConfirmationEmailClaimedUntil: timestamp(
      "product_confirmation_email_claimed_until",
      { withTimezone: true },
    ),
    productConfirmationEmailLastError: text(
      "product_confirmation_email_last_error",
    ),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    shippingAddress:
      jsonb("shipping_address").$type<CheckoutOrderShippingAddressSnapshot>(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    lineItems: jsonb("line_items")
      .$type<CheckoutOrderLineItemSnapshot[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("checkout_orders_checkout_token_hash_idx").on(
      table.checkoutTokenHash,
    ),
    uniqueIndex("checkout_orders_provider_checkout_idx").on(
      table.paymentProvider,
      table.providerCheckoutId,
    ),
    uniqueIndex("checkout_orders_provider_order_idx").on(
      table.paymentProvider,
      table.providerOrderId,
    ),
    uniqueIndex("checkout_orders_provider_payment_idx").on(
      table.paymentProvider,
      table.providerPaymentId,
    ),
    uniqueIndex("checkout_orders_calendar_event_id_idx").on(
      table.calendarEventId,
    ),
    index("checkout_orders_square_correlation_id_idx")
      .using("btree", sql`(${table.providerMetadata}->>'correlationId')`)
      .where(
        sql`${table.paymentProvider} = 'square' AND ${table.providerMetadata}->>'correlationId' IS NOT NULL`,
      ),
  ],
);

export const checkoutPaymentEvents = pgTable(
  "checkout_payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => checkoutOrders.id, {
      onDelete: "cascade",
    }),
    noShowChargeRecordId: uuid("no_show_charge_record_id").references(
      () => bookingNoShowChargeRecords.id,
      { onDelete: "set null" },
    ),
    eventType: text("event_type").notNull(),
    helcimTransactionId: text("helcim_transaction_id"),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("helcim"),
    providerEventId: text("provider_event_id"),
    providerCheckoutId: text("provider_checkout_id"),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    status: text("status"),
    providerStatus: text("provider_status"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    message: text("message"),
    idempotencyKey: text("idempotency_key").unique(),
    payloadHash: text("payload_hash"),
    payloadRedacted: jsonb("payload_redacted").$type<Record<string, unknown>>(),
    payloadSanitized:
      jsonb("payload_sanitized").$type<CheckoutPaymentEventPayload>(),
    processingStatus: paymentEventProcessingStatus("processing_status")
      .notNull()
      .default("received"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("checkout_payment_events_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    uniqueIndex("checkout_payment_events_provider_event_idx").on(
      table.paymentProvider,
      table.providerEventId,
    ),
  ],
);

export const trainingEnrollments = pgTable(
  "training_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    checkoutOrderId: uuid("checkout_order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "cascade" }),
    programSnapshot: jsonb("program_snapshot")
      .$type<TrainingEnrollmentProgramSnapshot>()
      .notNull(),
    productSnapshot: jsonb("product_snapshot")
      .$type<TrainingEnrollmentProductSnapshot>()
      .notNull(),
    checkoutEmail: text("checkout_email").notNull(),
    purchaseKind: trainingEnrollmentPurchaseKind("purchase_kind")
      .notNull()
      .default("full"),
    schedulingStatus: trainingEnrollmentSchedulingStatus("scheduling_status")
      .notNull()
      .default("pending"),
    schedulingTokenHash: text("scheduling_token_hash").unique(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenUsedAt: timestamp("token_used_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    studentPaymentEmailSentAt: timestamp("student_payment_email_sent_at", {
      withTimezone: true,
    }),
    trainingEmailClaimedUntil: timestamp("training_email_claimed_until", {
      withTimezone: true,
    }),
    trainingEmailLastError: text("training_email_last_error"),
    staffAlertedAt: timestamp("staff_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("training_enrollments_checkout_order_id_idx").on(
      table.checkoutOrderId,
    ),
    uniqueIndex("training_enrollments_scheduling_token_hash_idx").on(
      table.schedulingTokenHash,
    ),
  ],
);

export const appointmentHolds = pgTable(
  "appointment_holds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicReference: text("public_reference").notNull(),
    paymentSessionReference: text("payment_session_reference").notNull(),
    checkoutOrderId: uuid("checkout_order_id").references(
      () => checkoutOrders.id,
      { onDelete: "set null" },
    ),
    checkoutOrderPublicId: text("checkout_order_public_id"),
    offeringId: text("offering_id").notNull(),
    offeringSnapshot: jsonb("offering_snapshot")
      .$type<AppointmentHoldOfferingSnapshot>()
      .notNull(),
    bookingType: text("booking_type").notNull(),
    customerSnapshot: jsonb("customer_snapshot")
      .$type<AppointmentHoldCustomerSnapshot>()
      .notNull(),
    selectedStart: timestamp("selected_start", {
      withTimezone: true,
    }).notNull(),
    selectedEnd: timestamp("selected_end", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    status: appointmentHoldStatus("status").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    helcimInvoiceId: integer("helcim_invoice_id"),
    helcimInvoiceNumber: text("helcim_invoice_number"),
    helcimTransactionId: text("helcim_transaction_id"),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("helcim"),
    squarePaymentLinkId: text("square_payment_link_id"),
    squarePaymentLinkUrl: text("square_payment_link_url"),
    squareCheckoutId: text("square_checkout_id"),
    squarePaymentId: text("square_payment_id"),
    squareOrderId: text("square_order_id"),
    googleEventId: text("google_event_id"),
    finalizationStatus: calendarFinalizationStatus("finalization_status")
      .notNull()
      .default("pending"),
    finalizationReason: text("finalization_reason"),
    manualReviewStatus: text("manual_review_status"),
    manualReviewReason: text("manual_review_reason"),
    failureReason: text("failure_reason"),
    failureMetadata: jsonb("failure_metadata").$type<AppointmentHoldMetadata>(),
    reconciliationMetadata: jsonb(
      "reconciliation_metadata",
    ).$type<AppointmentHoldMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    bookingConfirmationEmailSentAt: timestamp(
      "booking_confirmation_email_sent_at",
      { withTimezone: true },
    ),
    bookingConfirmationEmailClaimedUntil: timestamp(
      "booking_confirmation_email_claimed_until",
      { withTimezone: true },
    ),
    bookingConfirmationEmailLastError: text(
      "booking_confirmation_email_last_error",
    ),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    paymentFailedAt: timestamp("payment_failed_at", { withTimezone: true }),
    bookingFailedAt: timestamp("booking_failed_at", { withTimezone: true }),
    manualFollowupAt: timestamp("manual_followup_at", { withTimezone: true }),
    savedPaymentMethodId: uuid("saved_payment_method_id").references(
      () => bookingSavedPaymentMethods.id,
      { onDelete: "set null" },
    ),
    policyAcceptanceId: uuid("policy_acceptance_id").references(
      (): AnyPgColumn => bookingPolicyAcceptances.id,
      { onDelete: "set null" },
    ),
    noShowChargeRecordId: uuid("no_show_charge_record_id").references(
      (): AnyPgColumn => bookingNoShowChargeRecords.id,
      { onDelete: "set null" },
    ),
    squareCustomerId: text("square_customer_id"),
    squareCardId: text("square_card_id"),
    cardOnFileStatus: text("card_on_file_status"),
    noShowInvoiceId: text("no_show_invoice_id"),
    noShowInvoiceOrderId: text("no_show_invoice_order_id"),
    noShowInvoiceStatus: text("no_show_invoice_status"),
  },
  (table) => [
    uniqueIndex("appointment_holds_public_reference_idx").on(
      table.publicReference,
    ),
    uniqueIndex("appointment_holds_payment_session_reference_idx").on(
      table.paymentSessionReference,
    ),
    uniqueIndex("appointment_holds_checkout_order_id_idx").on(
      table.checkoutOrderId,
    ),
    index("appointment_holds_checkout_order_public_id_idx").on(
      table.checkoutOrderPublicId,
    ),
    uniqueIndex("appointment_holds_square_payment_link_id_idx").on(
      table.squarePaymentLinkId,
    ),
    uniqueIndex("appointment_holds_square_checkout_id_idx").on(
      table.squareCheckoutId,
    ),
    uniqueIndex("appointment_holds_square_payment_id_idx").on(
      table.squarePaymentId,
    ),
    uniqueIndex("appointment_holds_square_order_id_idx").on(
      table.squareOrderId,
    ),
    uniqueIndex("appointment_holds_google_event_id_idx").on(
      table.googleEventId,
    ),
    index("appointment_holds_slot_conflict_idx").on(
      table.offeringId,
      table.selectedStart,
      table.selectedEnd,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const marketingContacts = pgTable(
  "marketing_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull().unique(),
    name: text("name"),
    phone: text("phone"),
    instagram: text("instagram"),
    source: text("source").notNull(),
    consentText: text("consent_text"),
    firstConsentedAt: timestamp("first_consented_at", {
      withTimezone: true,
    }).notNull(),
    lastConsentedAt: timestamp("last_consented_at", {
      withTimezone: true,
    }).notNull(),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("marketing_contacts_email_normalized_idx").on(
      table.emailNormalized,
    ),
  ],
);

export const marketingContactSubmissions = pgTable(
  "marketing_contact_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionType: marketingContactSubmissionType("submission_type").notNull(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    name: text("name"),
    phone: text("phone"),
    instagram: text("instagram"),
    source: text("source").notNull(),
    sourcePath: text("source_path"),
    sourceSystem: text("source_system").notNull().default("website"),
    sourceDocumentType: text("source_document_type"),
    sourceDocumentId: text("source_document_id"),
    consentChoice: text("consent_choice").notNull(),
    consentText: text("consent_text"),
    payload: jsonb("payload")
      .$type<MarketingContactSubmissionPayload>()
      .notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("marketing_contact_submissions_source_document_idx").on(
      table.sourceSystem,
      table.sourceDocumentType,
      table.sourceDocumentId,
    ),
  ],
);

export const marketingConsentEvents = pgTable("marketing_consent_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => marketingContacts.id, {
    onDelete: "set null",
  }),
  submissionId: uuid("submission_id").references(
    () => marketingContactSubmissions.id,
    { onDelete: "set null" },
  ),
  eventType: marketingConsentEventType("event_type").notNull(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  source: text("source").notNull(),
  consentText: text("consent_text"),
  metadata: jsonb("metadata").$type<MarketingConsentEventMetadata>(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const bookingSquareCustomers = pgTable(
  "booking_square_customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    emailNormalized: text("email_normalized").notNull(),
    customerName: text("customer_name").notNull(),
    phoneNormalized: text("phone_normalized"),
    squareCustomerId: text("square_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("booking_square_customers_square_customer_id_idx").on(
      table.squareCustomerId,
    ),
    uniqueIndex("booking_square_customers_email_normalized_idx").on(
      table.emailNormalized,
    ),
  ],
);

export const bookingSavedPaymentMethods = pgTable(
  "booking_saved_payment_methods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => bookingSquareCustomers.id, { onDelete: "cascade" }),
    squareCardId: text("square_card_id").notNull(),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    billingPostalCode: text("billing_postal_code"),
    status: savedPaymentMethodStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("booking_saved_payment_methods_square_card_id_idx").on(
      table.squareCardId,
    ),
    index("booking_saved_payment_methods_customer_id_idx").on(table.customerId),
  ],
);

export const bookingPolicyAcceptances = pgTable(
  "booking_policy_acceptances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    holdId: uuid("hold_id")
      .notNull()
      .references((): AnyPgColumn => appointmentHolds.id, {
        onDelete: "cascade",
      }),
    policyType: text("policy_type").notNull(),
    policyVersion: text("policy_version"),
    policyTextHash: text("policy_text_hash"),
    policyDocumentId: text("policy_document_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    maxChargeCents: integer("max_charge_cents"),
    currency: text("currency").notNull().default("CAD"),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    customerEmail: text("customer_email"),
    customerName: text("customer_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_policy_acceptances_hold_id_idx").on(table.holdId),
    index("booking_policy_acceptances_accepted_at_idx").on(table.acceptedAt),
  ],
);

export const bookingNoShowChargeRecords = pgTable(
  "booking_no_show_charge_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    holdId: uuid("hold_id")
      .notNull()
      .references((): AnyPgColumn => appointmentHolds.id, {
        onDelete: "cascade",
      }),
    savedPaymentMethodId: uuid("saved_payment_method_id").references(
      () => bookingSavedPaymentMethods.id,
      { onDelete: "set null" },
    ),
    policyAcceptanceId: uuid("policy_acceptance_id").references(
      () => bookingPolicyAcceptances.id,
      { onDelete: "set null" },
    ),
    squareCustomerId: text("square_customer_id"),
    squareCardId: text("square_card_id"),
    maxChargeCents: integer("max_charge_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    squareInvoiceId: text("square_invoice_id"),
    squareOrderId: text("square_order_id"),
    squarePaymentId: text("square_payment_id"),
    status: noShowChargeStatus("status").notNull().default("draft"),
    providerStatus: text("provider_status"),
    providerFailureReason: text("provider_failure_reason"),
    providerMetadata:
      jsonb("provider_metadata").$type<BookingNoShowProviderMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    adminActionAt: timestamp("admin_action_at", { withTimezone: true }),
    adminOperatorId: text("admin_operator_id"),
    adminReason: text("admin_reason"),
    adminEligibilityCheckedAt: timestamp("admin_eligibility_checked_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("booking_no_show_charge_records_hold_id_idx").on(table.holdId),
    uniqueIndex("booking_no_show_charge_records_square_invoice_id_idx").on(
      table.squareInvoiceId,
    ),
    uniqueIndex("booking_no_show_charge_records_square_payment_id_idx").on(
      table.squarePaymentId,
    ),
    index("booking_no_show_charge_records_square_order_id_idx").on(
      table.squareOrderId,
    ),
    index("booking_no_show_charge_records_status_idx").on(table.status),
  ],
);

export const bookingNoShowChargeAttempts = pgTable(
  "booking_no_show_charge_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    noShowChargeRecordId: uuid("no_show_charge_record_id")
      .notNull()
      .references(() => bookingNoShowChargeRecords.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    status: text("status"),
    squarePaymentId: text("square_payment_id"),
    squareInvoiceId: text("square_invoice_id"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("booking_no_show_charge_attempts_idempotency_key_idx").on(
      table.idempotencyKey,
    ),
    uniqueIndex("booking_no_show_charge_attempts_square_payment_id_idx").on(
      table.squarePaymentId,
    ),
    index("booking_no_show_charge_attempts_record_id_idx").on(
      table.noShowChargeRecordId,
    ),
  ],
);

import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { BookingQuestion } from "@/lib/booking/types";

export const checkoutOrderStatus = pgEnum("checkout_order_status", [
  "pending",
  "paid",
  "verification_failed",
  "cancelled",
  "refunded",
]);

export const checkoutInitializationStatus = pgEnum(
  "checkout_initialization_status",
  ["initializing", "ready", "failed"],
);

export const productShipmentStatus = pgEnum("product_shipment_status", [
  "quote_pending",
  "quoted",
  "quote_unknown",
  "payment_pending",
  "ready_for_staff",
  "purchase_pending",
  "label_ready",
  "accepted",
  "in_transit",
  "delivered",
  "exception",
  "refund_pending",
  "voided",
  "abandoned",
  "manual_review",
]);

export const productShipmentJobStatus = pgEnum("product_shipment_job_status", [
  "queued",
  "processing",
  "succeeded",
  "retryable_failed",
  "dead_letter",
]);

export const productShipmentJobType = pgEnum("product_shipment_job_type", [
  "create",
  "quote_refresh",
  "purchase",
  "delete",
  "tracking",
  "refund",
  "cleanup",
  "replacement_prepare",
  "address_replace",
  "notification",
]);

export const paymentRiskStatus = pgEnum("payment_risk_status", [
  "not_required",
  "pending",
  "cleared",
  "review_required",
]);

export const orderPaymentObligationPurpose = pgEnum(
  "order_payment_obligation_purpose",
  ["primary", "manual_shipping", "address_increase"],
);

export const orderPaymentObligationStatus = pgEnum(
  "order_payment_obligation_status",
  [
    "pending",
    "paid",
    "expired",
    "superseded",
    "cancelled",
    "refunded",
    "manual_review",
  ],
);

export const productOrderAdjustmentDirection = pgEnum(
  "product_order_adjustment_direction",
  ["charge", "refund"],
);

export const productOrderAdjustmentComponent = pgEnum(
  "product_order_adjustment_component",
  ["merchandise", "tax", "outbound_shipping"],
);

export const productOrderAdjustmentStatus = pgEnum(
  "product_order_adjustment_status",
  [
    "pending",
    "reserved",
    "processing",
    "succeeded",
    "failed",
    "outcome_unknown",
    "manual_review",
    "cancelled",
  ],
);

export const checkoutFulfillmentMode = pgEnum("checkout_fulfillment_mode", [
  "automated_shipping",
  "manual_pickup",
  "manual_shipping",
]);

export const productShipmentPurpose = pgEnum("product_shipment_purpose", [
  "original",
  "replacement",
  "reshipment",
]);

export const shippingPolicyDuty = pgEnum("shipping_policy_duty", [
  "business_owner",
  "operations_lead",
  "finance_owner",
  "payment_fraud_owner",
  "privacy_owner",
  "security_owner",
]);

export const shippingCalendarExceptionKind = pgEnum(
  "shipping_calendar_exception_kind",
  ["ontario_holiday", "branch_closure"],
);

export const productShippingCaseType = pgEnum("product_shipping_case_type", [
  "postage_failure",
  "delay",
  "loss",
  "damage",
  "refused",
  "unclaimed",
  "return_to_sender",
  "claim",
]);

export const productShippingCaseStatus = pgEnum(
  "product_shipping_case_status",
  [
    "open",
    "waiting_customer",
    "waiting_provider",
    "remedy_pending",
    "resolved",
    "cancelled",
  ],
);

export const productOrderRefundStatus = pgEnum("product_order_refund_status", [
  "queued",
  "processing",
  "succeeded",
  "failed",
  "outcome_unknown",
  "manual_review",
]);

export const productOrderCustomerDecisionStatus = pgEnum(
  "product_order_customer_decision_status",
  ["pending", "selected", "expired", "revoked"],
);

export const productOrderAddressChangeStatus = pgEnum(
  "product_order_address_change_status",
  [
    "pending_customer",
    "submitted",
    "risk_review",
    "approved",
    "applied",
    "rejected",
    "expired",
    "revoked",
  ],
);

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
  [
    "received",
    "processed",
    "duplicate",
    "ignored",
    "failed",
    "review_required",
    "retryable_failed",
  ],
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

export const marketingContactSyncJobStatus = pgEnum(
  "marketing_contact_sync_job_status",
  [
    "queued",
    "processing",
    "succeeded",
    "retryable_failed",
    "dead_letter",
    "skipped_unconfigured",
  ],
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

export const adminRole = pgEnum("admin_role", ["owner", "admin", "employee"]);

export const adminUserStatus = pgEnum("admin_user_status", [
  "active",
  "disabled",
]);

export const adminAuditOutcome = pgEnum("admin_audit_outcome", [
  "success",
  "denied",
  "failure",
]);

export const bookingResourceKind = pgEnum("booking_resource_kind", [
  "provider",
  "room",
  "equipment",
]);

export const bookingConfigurationStatus = pgEnum(
  "booking_configuration_status",
  ["draft", "active", "disabled", "archived"],
);

export const bookingOfferingResourceRole = pgEnum(
  "booking_offering_resource_role",
  ["provider", "room", "equipment"],
);

export const bookingOfferingCopyProvenance = pgEnum(
  "booking_offering_copy_provenance",
  ["legacy", "admin"],
);

export const bookingScheduleExceptionKind = pgEnum(
  "booking_schedule_exception_kind",
  ["available", "unavailable"],
);

export const bookingScheduleExceptionStatus = pgEnum(
  "booking_schedule_exception_status",
  ["active", "cancelled"],
);

export const bookingCalendarProvider = pgEnum("booking_calendar_provider", [
  "google",
]);

export const bookingCalendarConnectionStatus = pgEnum(
  "booking_calendar_connection_status",
  ["active", "reconnect_required", "revoked", "disabled"],
);

export const bookingCalendarAssignmentStatus = pgEnum(
  "booking_calendar_assignment_status",
  ["active", "disabled"],
);

export const squareTeamMemberMappingStatus = pgEnum(
  "square_team_member_mapping_status",
  ["active", "inactive", "missing"],
);

export const appointmentStatus = pgEnum("appointment_status", [
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
  "rebooking_pending",
  "manual_followup",
]);

export const appointmentOrigin = pgEnum("appointment_origin", [
  "online",
  "admin",
  "imported",
]);

export const appointmentPaymentStatus = pgEnum("appointment_payment_status", [
  "not_required",
  "pending",
  "partially_paid",
  "paid",
  "refund_required",
  "refunded",
]);

export const appointmentCalendarSyncStatus = pgEnum(
  "appointment_calendar_sync_status",
  ["not_required", "pending", "synced", "retryable_failed", "manual_followup"],
);

export const bookingReservationKind = pgEnum("booking_reservation_kind", [
  "hold",
  "appointment",
  "block",
]);

export const bookingReservationState = pgEnum("booking_reservation_state", [
  "active",
  "released",
]);

export const bookingPaymentAttemptStatus = pgEnum(
  "booking_payment_attempt_status",
  ["pending", "authorized", "captured", "failed", "cancelled", "refunded"],
);

export interface CheckoutOrderLineItemSnapshot {
  productId: string;
  variantId?: string;
  sku: string;
  description: string;
  productTitle?: string;
  variantTitle?: string;
  selectedOptions?: Array<{ label: string; value: string }>;
  fulfillmentMode?: "automated" | "manual";
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
  countryCode?: "CA" | "US";
  phone?: string;
}

export interface UsImportDisclosureSnapshot {
  terms: "DDU";
  version: string;
  text: string;
  presentedAt: string;
}

export interface ProductShipmentPackageSnapshot {
  profileId: string;
  profileSlug: string;
  packageType: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  tareWeightGrams: number;
  totalWeightGrams: number;
}

export interface ProductShipmentDestinationSnapshot extends CheckoutOrderShippingAddressSnapshot {
  name?: string;
  email?: string;
  phone?: string;
}

export interface ProductShipmentCustomsLineSnapshot {
  productId: string;
  variantId?: string;
  sku: string;
  description: string;
  quantity: number;
  unitValueCents: number;
  unitWeightGrams: number;
  countryOfOrigin: string;
  hsTariffCode?: string;
  manufacturerName?: string;
  manufacturerAddress?: string;
  manufacturerCity?: string;
  manufacturerProvinceCode?: string;
  manufacturerPostalCode?: string;
  manufacturerCountryCode?: string;
}

export interface ProductShipmentRateSnapshot {
  id: string;
  postageType: string;
  title: string;
  carrier?: string;
  deliveryEstimate?: string;
  deliveryMaxBusinessDays?: number;
  estimatedDeliveryAt?: string;
  signatureAvailable: boolean;
  signatureRequired: boolean;
  paymentAmountCents: number;
  insuranceFeeCents: number;
  insured: boolean;
  tracked: boolean;
  raw: Record<string, unknown>;
}

export interface FulfillmentProviderCertificationContractSnapshot {
  importTerms: "DDU";
  disclosure: {
    version: string;
    text: string;
  };
  allowedServiceCodes: string[];
  trackedRequired: true;
  insuredRequired: true;
  tariffMetadataSchema: {
    version: string;
    additionalTariffDetails: "required_when_applicable";
    fields: ["steel", "copper", "aluminum"];
  };
  fdaRequirements: {
    version: string;
    mode: "required_when_applicable";
  };
  effectiveFrom: string;
  effectiveUntil: string;
  evidenceReference: string;
  version: string;
}

export interface ProductTaxPolicyApprovalSnapshot {
  version: string;
  coverage: Record<string, boolean>;
  ownerName: string;
  approvedByAdminUserId: string;
  approvalStepUpAuthenticatedAt: string;
  evidenceReference: string;
  approvalEvidenceHash: string;
  approvalEvidenceVersion: string;
  approvalAction: "approve_product_tax_policy";
  approvedAt: string;
  effectiveAt: string;
}

export type ShippingRiskClassification = "low" | "high";
export type PaymentRiskStatus = (typeof paymentRiskStatus.enumValues)[number];
export type ProductShipmentPurpose =
  (typeof productShipmentPurpose.enumValues)[number];
export type ShippingPolicyDuty = (typeof shippingPolicyDuty.enumValues)[number];
export type ProductShippingCaseType =
  (typeof productShippingCaseType.enumValues)[number];
export type ProductShippingCaseStatus =
  (typeof productShippingCaseStatus.enumValues)[number];

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
export type MarketingContactSyncJobStatus =
  (typeof marketingContactSyncJobStatus.enumValues)[number];
export type SavedPaymentMethodStatus =
  (typeof savedPaymentMethodStatus.enumValues)[number];
export type NoShowChargeStatus = (typeof noShowChargeStatus.enumValues)[number];
export type AdminRole = (typeof adminRole.enumValues)[number];
export type AdminUserStatus = (typeof adminUserStatus.enumValues)[number];
export type AdminAuditOutcome = (typeof adminAuditOutcome.enumValues)[number];
export type BookingResourceKind =
  (typeof bookingResourceKind.enumValues)[number];
export type BookingConfigurationStatus =
  (typeof bookingConfigurationStatus.enumValues)[number];
export type BookingOfferingResourceRole =
  (typeof bookingOfferingResourceRole.enumValues)[number];
export type BookingScheduleExceptionKind =
  (typeof bookingScheduleExceptionKind.enumValues)[number];
export type BookingScheduleExceptionStatus =
  (typeof bookingScheduleExceptionStatus.enumValues)[number];
export type BookingCalendarProvider =
  (typeof bookingCalendarProvider.enumValues)[number];
export type BookingCalendarConnectionStatus =
  (typeof bookingCalendarConnectionStatus.enumValues)[number];
export type BookingCalendarAssignmentStatus =
  (typeof bookingCalendarAssignmentStatus.enumValues)[number];
export type SquareTeamMemberMappingStatus =
  (typeof squareTeamMemberMappingStatus.enumValues)[number];
export type AppointmentStatus = (typeof appointmentStatus.enumValues)[number];
export type AppointmentOrigin = (typeof appointmentOrigin.enumValues)[number];
export type AppointmentPaymentStatus =
  (typeof appointmentPaymentStatus.enumValues)[number];
export type AppointmentCalendarSyncStatus =
  (typeof appointmentCalendarSyncStatus.enumValues)[number];
export type BookingReservationKind =
  (typeof bookingReservationKind.enumValues)[number];
export type BookingReservationState =
  (typeof bookingReservationState.enumValues)[number];
export type BookingPaymentAttemptStatus =
  (typeof bookingPaymentAttemptStatus.enumValues)[number];

export interface AppointmentHoldOfferingSnapshot {
  [key: string]: unknown;
}

export interface AppointmentHoldProviderSnapshot {
  [key: string]: unknown;
}

export interface BookingServiceOfferingSnapshot {
  [key: string]: unknown;
}

export interface BookingProviderSnapshot {
  [key: string]: unknown;
}

export interface AppointmentIntakeSnapshot {
  [key: string]: unknown;
}

export interface AppointmentEventMetadata {
  [key: string]: unknown;
}

export interface BookingPaymentAttemptMetadata {
  [key: string]: unknown;
}

export interface AdminAuditMetadata {
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

export interface SquarePaymentRefundPayload {
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

export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerUserId: text("provider_user_id").notNull(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    displayName: text("display_name"),
    role: adminRole("role").notNull(),
    status: adminUserStatus("status").notNull().default("active"),
    lastSignedInAt: timestamp("last_signed_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_users_provider_user_id_idx").on(table.providerUserId),
    uniqueIndex("admin_users_email_normalized_idx").on(table.emailNormalized),
  ],
);

export const adminStepUpProofs = pgTable(
  "admin_step_up_proofs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    nonceHash: text("nonce_hash").notNull().unique(),
    actorAdminUserId: uuid("actor_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    target: text("target").notNull(),
    authenticatedAt: timestamp("authenticated_at", {
      withTimezone: true,
    }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_step_up_proofs_actor_expiry_idx").on(
      table.actorAdminUserId,
      table.expiresAt,
    ),
    check(
      "admin_step_up_proofs_expiry_check",
      sql`${table.expiresAt} > ${table.authenticatedAt} AND ${table.expiresAt} <= ${table.authenticatedAt} + interval '5 minutes'`,
    ),
  ],
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorAdminUserId: uuid("actor_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    actorRole: adminRole("actor_role").notNull(),
    action: text("action").notNull(),
    domain: text("domain").notNull(),
    outcome: adminAuditOutcome("outcome").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    reason: text("reason"),
    correlationId: text("correlation_id"),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    metadata: jsonb("metadata").$type<AdminAuditMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_audit_logs_actor_created_idx").on(
      table.actorAdminUserId,
      table.createdAt,
    ),
    index("admin_audit_logs_domain_created_idx").on(
      table.domain,
      table.createdAt,
    ),
    index("admin_audit_logs_target_created_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  ],
);

export const bookingResources = pgTable(
  "booking_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceKey: text("resource_key").notNull(),
    name: text("name").notNull(),
    kind: bookingResourceKind("kind").notNull(),
    timezone: text("timezone").notNull(),
    status: bookingConfigurationStatus("status").notNull().default("draft"),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_resources_resource_key_idx").on(table.resourceKey),
    index("booking_resources_status_kind_idx").on(table.status, table.kind),
  ],
);

export const adminUserResources = pgTable(
  "admin_user_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    bookingResourceId: uuid("booking_resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("admin_user_resources_user_resource_idx").on(
      table.adminUserId,
      table.bookingResourceId,
    ),
    index("admin_user_resources_resource_user_idx").on(
      table.bookingResourceId,
      table.adminUserId,
    ),
  ],
);

export const bookingProviders = pgTable(
  "booking_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerKey: text("provider_key").notNull(),
    displayName: text("display_name").notNull(),
    primaryResourceId: uuid("primary_resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    sanityDocumentId: text("sanity_document_id"),
    publicSlug: text("public_slug"),
    status: bookingConfigurationStatus("status").notNull().default("draft"),
    squareTeamMemberId: text("square_team_member_id"),
    squareTeamMemberDisplayLabel: text("square_team_member_display_label"),
    squareTeamMemberStatus: squareTeamMemberMappingStatus(
      "square_team_member_status",
    ),
    squareTeamMemberVerifiedAt: timestamp("square_team_member_verified_at", {
      withTimezone: true,
    }),
    displayOrder: integer("display_order").notNull().default(0),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_providers_provider_key_idx").on(table.providerKey),
    uniqueIndex("booking_providers_primary_resource_idx").on(
      table.primaryResourceId,
    ),
    uniqueIndex("booking_providers_sanity_document_idx").on(
      table.sanityDocumentId,
    ),
    uniqueIndex("booking_providers_public_slug_idx").on(table.publicSlug),
    uniqueIndex("booking_providers_square_team_member_idx").on(
      table.squareTeamMemberId,
    ),
    index("booking_providers_status_display_idx").on(
      table.status,
      table.displayOrder,
    ),
  ],
);

export const bookingServices = pgTable(
  "booking_services",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serviceKey: text("service_key").notNull(),
    displayTitle: text("display_title").notNull(),
    ownerProviderId: uuid("owner_provider_id").references(
      () => bookingProviders.id,
      { onDelete: "set null" },
    ),
    sanityDocumentId: text("sanity_document_id"),
    publicSlug: text("public_slug"),
    status: bookingConfigurationStatus("status").notNull().default("draft"),
    displayOrder: integer("display_order").notNull().default(0),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_services_service_key_idx").on(
      table.ownerProviderId,
      table.serviceKey,
    ),
    uniqueIndex("booking_services_sanity_document_idx").on(
      table.ownerProviderId,
      table.sanityDocumentId,
    ),
    uniqueIndex("booking_services_public_slug_idx").on(
      table.ownerProviderId,
      table.publicSlug,
    ),
    index("booking_services_owner_provider_idx").on(table.ownerProviderId),
    index("booking_services_status_display_idx").on(
      table.status,
      table.displayOrder,
    ),
  ],
);

export const bookingServiceOfferings = pgTable(
  "booking_service_offerings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offeringKey: text("offering_key").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => bookingServices.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => bookingProviders.id, { onDelete: "restrict" }),
    primaryResourceId: uuid("primary_resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    status: bookingConfigurationStatus("status").notNull().default("draft"),
    bookingType: text("booking_type")
      .notNull()
      .default("in-person-appointment"),
    durationMinutes: integer("duration_minutes").notNull(),
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    fullPriceCents: integer("full_price_cents").notNull(),
    depositAmountCents: integer("deposit_amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    publicTitle: text("public_title"),
    publicTitleProvenance: bookingOfferingCopyProvenance(
      "public_title_provenance",
    )
      .notNull()
      .default("legacy"),
    publicSummary: text("public_summary"),
    publicSummaryProvenance: bookingOfferingCopyProvenance(
      "public_summary_provenance",
    )
      .notNull()
      .default("legacy"),
    minimumLeadTimeHours: integer("minimum_lead_time_hours"),
    bookingHorizonDays: integer("booking_horizon_days"),
    displayOrder: integer("display_order").notNull().default(0),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_service_offerings_offering_key_idx").on(
      table.offeringKey,
    ),
    index("booking_service_offerings_service_provider_idx").on(
      table.serviceId,
      table.providerId,
      table.status,
    ),
    uniqueIndex("booking_service_offerings_active_service_provider_idx")
      .on(table.serviceId, table.providerId)
      .where(sql`${table.status} = 'active'`),
    index("booking_service_offerings_resource_status_idx").on(
      table.primaryResourceId,
      table.status,
    ),
    check(
      "booking_service_offerings_duration_check",
      sql`${table.durationMinutes} > 0 AND ${table.slotIntervalMinutes} > 0`,
    ),
    check(
      "booking_service_offerings_buffer_check",
      sql`${table.bufferBeforeMinutes} >= 0 AND ${table.bufferAfterMinutes} >= 0`,
    ),
    check(
      "booking_service_offerings_price_check",
      sql`${table.fullPriceCents} > 0 AND ${table.depositAmountCents} > 0 AND ${table.depositAmountCents} < ${table.fullPriceCents}`,
    ),
    check(
      "booking_service_offerings_effective_range_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveFrom} IS NULL OR ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
  ],
);

export const bookingServicePromotionCodes = pgTable(
  "booking_service_promotion_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    internalTitle: text("internal_title").notNull(),
    discountType: text("discount_type").notNull(),
    discountValue: integer("discount_value").notNull(),
    status: bookingConfigurationStatus("status").notNull().default("draft"),
    sourceSanityDocumentId: text("source_sanity_document_id"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_service_promotion_codes_code_idx").on(table.code),
    uniqueIndex("booking_service_promotion_codes_sanity_document_idx").on(
      table.sourceSanityDocumentId,
    ),
    index("booking_service_promotion_codes_status_window_idx").on(
      table.status,
      table.effectiveFrom,
      table.effectiveUntil,
    ),
    check(
      "booking_service_promotion_codes_code_check",
      sql`${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'`,
    ),
    check(
      "booking_service_promotion_codes_discount_type_check",
      sql`${table.discountType} IN ('percentage', 'fixed')`,
    ),
    check(
      "booking_service_promotion_codes_discount_value_check",
      sql`${table.discountValue} > 0 AND (${table.discountType} <> 'percentage' OR ${table.discountValue} <= 10000)`,
    ),
    check(
      "booking_service_promotion_codes_effective_range_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveFrom} IS NULL OR ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
  ],
);

export const bookingServicePromotionOfferings = pgTable(
  "booking_service_promotion_offerings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    promotionCodeId: uuid("promotion_code_id")
      .notNull()
      .references(() => bookingServicePromotionCodes.id, {
        onDelete: "cascade",
      }),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => bookingServiceOfferings.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_service_promotion_offerings_pair_idx").on(
      table.promotionCodeId,
      table.offeringId,
    ),
    index("booking_service_promotion_offerings_offering_idx").on(
      table.offeringId,
      table.promotionCodeId,
    ),
  ],
);

export const bookingServiceOfferingAddOns = pgTable(
  "booking_service_offering_add_ons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => bookingServiceOfferings.id, { onDelete: "cascade" }),
    addOnKey: text("add_on_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    durationDeltaMinutes: integer("duration_delta_minutes")
      .notNull()
      .default(0),
    status: bookingConfigurationStatus("status").notNull().default("active"),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_service_offering_add_ons_key_idx").on(
      table.offeringId,
      table.addOnKey,
    ),
    index("booking_service_offering_add_ons_display_idx").on(
      table.offeringId,
      table.status,
      table.displayOrder,
    ),
    check(
      "booking_service_offering_add_ons_price_check",
      sql`${table.priceCents} > 0`,
    ),
    check(
      "booking_service_offering_add_ons_duration_check",
      sql`${table.durationDeltaMinutes} >= 0`,
    ),
  ],
);

export const bookingServiceOfferingResources = pgTable(
  "booking_service_offering_resources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offeringId: uuid("offering_id")
      .notNull()
      .references(() => bookingServiceOfferings.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    role: bookingOfferingResourceRole("role").notNull(),
    isRequired: boolean("is_required").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_service_offering_resources_pair_idx").on(
      table.offeringId,
      table.resourceId,
    ),
    index("booking_service_offering_resources_resource_idx").on(
      table.resourceId,
      table.offeringId,
    ),
  ],
);

export const bookingBusinessSettings = pgTable(
  "booking_business_settings",
  {
    singletonKey: text("singleton_key").primaryKey().default("default"),
    timezone: text("timezone").notNull().default("America/Toronto"),
    bookingHorizonDays: integer("booking_horizon_days").notNull().default(30),
    minimumLeadTimeHours: integer("minimum_lead_time_hours")
      .notNull()
      .default(24),
    slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(15),
    defaultBufferBeforeMinutes: integer("default_buffer_before_minutes")
      .notNull()
      .default(15),
    defaultBufferAfterMinutes: integer("default_buffer_after_minutes")
      .notNull()
      .default(15),
    requireSquareTeamAttribution: boolean("require_square_team_attribution")
      .notNull()
      .default(false),
    intakeQuestions: jsonb("intake_questions")
      .$type<BookingQuestion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    marketingOptInLabel: text("marketing_opt_in_label")
      .notNull()
      .default(
        "I agree to receive occasional updates from Lash Her by Nataliea.",
      ),
    version: integer("version").notNull().default(1),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "booking_business_settings_singleton_check",
      sql`${table.singletonKey} = 'default'`,
    ),
    check(
      "booking_business_settings_values_check",
      sql`${table.bookingHorizonDays} > 0 AND ${table.minimumLeadTimeHours} >= 0 AND ${table.slotIntervalMinutes} > 0 AND ${table.defaultBufferBeforeMinutes} >= 0 AND ${table.defaultBufferAfterMinutes} >= 0`,
    ),
  ],
);

export const bookingResourceSchedules = pgTable(
  "booking_resource_schedules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    weekday: smallint("weekday").notNull(),
    startsAt: time("starts_at").notNull(),
    endsAt: time("ends_at").notNull(),
    timezone: text("timezone").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveUntil: date("effective_until"),
    status: bookingConfigurationStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("booking_resource_schedules_lookup_idx").on(
      table.resourceId,
      table.weekday,
      table.status,
      table.effectiveFrom,
      table.effectiveUntil,
    ),
    check(
      "booking_resource_schedules_weekday_check",
      sql`${table.weekday} BETWEEN 1 AND 7`,
    ),
    check(
      "booking_resource_schedules_time_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      "booking_resource_schedules_effective_range_check",
      sql`${table.effectiveUntil} IS NULL OR ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
  ],
);

export const bookingResourceScheduleExceptions = pgTable(
  "booking_resource_schedule_exceptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    kind: bookingScheduleExceptionKind("kind").notNull(),
    status: bookingScheduleExceptionStatus("status")
      .notNull()
      .default("active"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    reasonCode: text("reason_code"),
    note: text("note"),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    updatedByAdminUserId: uuid("updated_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("booking_resource_schedule_exceptions_lookup_idx").on(
      table.resourceId,
      table.status,
      table.startsAt,
      table.endsAt,
    ),
    check(
      "booking_resource_schedule_exceptions_range_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
  ],
);

export const bookingCalendarConnections = pgTable(
  "booking_calendar_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: bookingCalendarProvider("provider").notNull().default("google"),
    providerAccountId: text("provider_account_id"),
    accountEmail: text("account_email"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialSecretRef: text("credential_secret_ref"),
    scopes: jsonb("scopes").$type<string[]>(),
    status: bookingCalendarConnectionStatus("status")
      .notNull()
      .default("reconnect_required"),
    connectedByAdminUserId: uuid("connected_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    credentialOwnerAdminUserId: uuid(
      "credential_owner_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "restrict" }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_calendar_connections_provider_account_idx").on(
      table.provider,
      table.providerAccountId,
    ),
    index("booking_calendar_connections_status_idx").on(table.status),
    index("booking_calendar_connections_credential_owner_idx").on(
      table.credentialOwnerAdminUserId,
      table.status,
    ),
    check(
      "booking_calendar_connections_active_credential_check",
      sql`${table.status} <> 'active' OR num_nonnulls(${table.credentialCiphertext}, ${table.credentialSecretRef}) = 1`,
    ),
  ],
);

export const bookingResourceCalendarAssignments = pgTable(
  "booking_resource_calendar_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    calendarConnectionId: uuid("calendar_connection_id")
      .notNull()
      .references(() => bookingCalendarConnections.id, {
        onDelete: "restrict",
      }),
    providerCalendarId: text("provider_calendar_id").notNull(),
    calendarLabel: text("calendar_label"),
    contributesBusy: boolean("contributes_busy").notNull().default(true),
    acceptsBookings: boolean("accepts_bookings").notNull().default(false),
    status: bookingCalendarAssignmentStatus("status")
      .notNull()
      .default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_resource_calendar_assignments_calendar_idx").on(
      table.resourceId,
      table.calendarConnectionId,
      table.providerCalendarId,
    ),
    uniqueIndex("booking_resource_calendar_assignments_write_idx")
      .on(table.resourceId)
      .where(
        sql`${table.status} = 'active' AND ${table.acceptsBookings} = true`,
      ),
    index("booking_resource_calendar_assignments_busy_idx").on(
      table.resourceId,
      table.status,
      table.contributesBusy,
    ),
    check(
      "booking_resource_calendar_assignments_role_check",
      sql`${table.contributesBusy} = true OR ${table.acceptsBookings} = false`,
    ),
    check(
      "booking_resource_calendar_assignments_has_role_check",
      sql`${table.contributesBusy} = true OR ${table.acceptsBookings} = true`,
    ),
  ],
);

export const checkoutOrders = pgTable(
  "checkout_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: text("order_id").notNull().unique(),
    purpose: checkoutOrderPurpose("purpose").notNull().default("product"),
    status: checkoutOrderStatus("status").notNull().default("pending"),
    initializationStatus: checkoutInitializationStatus("initialization_status")
      .notNull()
      .default("ready"),
    initializationError: text("initialization_error"),
    checkoutTokenHash: text("checkout_token_hash").unique(),
    secretTokenCiphertext: text("secret_token_ciphertext"),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("square"),
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
    merchandiseAmountCents: integer("merchandise_amount_cents"),
    shippingAmountCents: integer("shipping_amount_cents").notNull().default(0),
    taxAmountCents: integer("tax_amount_cents").notNull().default(0),
    promotionCode: text("promotion_code"),
    promotionDiscountCents: integer("promotion_discount_cents")
      .notNull()
      .default(0),
    manualDiscountCents: integer("manual_discount_cents").notNull().default(0),
    currency: text("currency").notNull().default("CAD"),
    lineItems: jsonb("line_items")
      .$type<CheckoutOrderLineItemSnapshot[]>()
      .notNull(),
    refundOriginIpCiphertext: text("refund_origin_ip_ciphertext"),
    atRiskValueCents: integer("at_risk_value_cents"),
    fraudClassification: text("fraud_classification")
      .$type<ShippingRiskClassification>()
      .notNull()
      .default("low"),
    paymentRiskStatus: paymentRiskStatus("payment_risk_status")
      .notNull()
      .default("not_required"),
    paymentRiskAssessedAt: timestamp("payment_risk_assessed_at", {
      withTimezone: true,
    }),
    paymentRiskSource: text("payment_risk_source"),
    fraudRiskReasons: jsonb("fraud_risk_reasons")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fulfillmentClearedAt: timestamp("fulfillment_cleared_at", {
      withTimezone: true,
    }),
    fraudClearedAt: timestamp("fraud_cleared_at", { withTimezone: true }),
    shippingPolicyVersion: text("shipping_policy_version"),
    taxPolicyVersion: text("tax_policy_version"),
    dduNoticeVersion: text("ddu_notice_version"),
    fulfillmentMode: checkoutFulfillmentMode("fulfillment_mode"),
    manualFulfillmentStatus: text("manual_fulfillment_status"),
    cancellationPolicyVersion: text("cancellation_policy_version"),
    cancellationPolicyAcceptedAt: timestamp("cancellation_policy_accepted_at", {
      withTimezone: true,
    }),
    cancellationPolicySnapshot: jsonb("cancellation_policy_snapshot").$type<
      Record<string, unknown>
    >(),
    termsVersion: text("terms_version"),
    termsAcceptedAt: timestamp("terms_accepted_at", {
      withTimezone: true,
    }),
    termsSnapshot: jsonb("terms_snapshot").$type<Record<string, unknown>>(),
    dduNoticePresentedAt: timestamp("ddu_notice_presented_at", {
      withTimezone: true,
    }),
    dduNoticeAcceptedAt: timestamp("ddu_notice_accepted_at", {
      withTimezone: true,
    }),
    usImportDisclosureSnapshot: jsonb(
      "us_import_disclosure_snapshot",
    ).$type<UsImportDisclosureSnapshot>(),
    activeFulfillmentShipmentId: uuid(
      "active_fulfillment_shipment_id",
    ).references((): AnyPgColumn => productShipments.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    privacyTerminalAt: timestamp("privacy_terminal_at", {
      withTimezone: true,
    }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    fulfillmentQuarantinedAt: timestamp("fulfillment_quarantined_at", {
      withTimezone: true,
    }),
    fulfillmentQuarantineReason: text("fulfillment_quarantine_reason"),
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
    index("checkout_orders_paid_square_appointment_not_booked_idx")
      .using("btree", table.paidAt, table.id, table.orderId)
      .where(
        sql`${table.status} = 'paid' AND ${table.paymentProvider} = 'square' AND ${table.purpose} IN ('appointment_deposit', 'appointment_full', 'appointment_custom_partial') AND ${table.calendarFinalizationStatus} NOT IN ('not_required', 'booked', 'manual_rebooked')`,
      ),
    check(
      "checkout_orders_commercial_components_nonnegative_check",
      sql`${table.shippingAmountCents} >= 0 AND ${table.taxAmountCents} >= 0 AND ${table.promotionDiscountCents} >= 0 AND ${table.manualDiscountCents} >= 0`,
    ),
    check(
      "checkout_orders_manual_fulfillment_status_check",
      sql`${table.manualFulfillmentStatus} IS NULL OR ${table.manualFulfillmentStatus} IN ('payment_pending', 'paid_pending_dispatch', 'dispatched', 'cancelled')`,
    ),
  ],
);

export const productStockMovementKind = pgEnum("product_stock_movement_kind", [
  "reserve",
  "commit",
  "release",
  "restock",
  "return",
]);

/**
 * Authoritative product inventory. Keyed by Sanity identity: `productId` is the
 * published product `_id` and `variantKey` is the derived variant `_key`
 * (`derived_v1_…`), or NULL for a product with no options. `onHand` is physical
 * units; `reserved` is units held by in-flight (pending) product orders, so
 * available-to-sell is `onHand - reserved`. A product/variant with no row here
 * is untracked (treated as unlimited) — the catalog is not blocked until staff
 * opt an item in by authoring a Sanity stock quantity. `sanitySeedQuantity`
 * records the last Sanity set-point applied so the sync only resets `onHand`
 * when the authored number actually changes.
 */
export const productStock = pgTable(
  "product_stock",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: text("product_id").notNull(),
    variantKey: text("variant_key"),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    sanitySeedQuantity: integer("sanity_seed_quantity"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // NULL is distinct in a plain unique index, so split the variant and
    // no-variant rows into two partial unique indexes to keep both unique.
    uniqueIndex("product_stock_product_variant_idx")
      .on(table.productId, table.variantKey)
      .where(sql`${table.variantKey} IS NOT NULL`),
    uniqueIndex("product_stock_product_no_variant_idx")
      .on(table.productId)
      .where(sql`${table.variantKey} IS NULL`),
    // Covers the bulk `product_id IN (...)` read (cart preview, storefront
    // badges, admin inventory); the two partial unique indexes above only serve
    // the single-row (product_id, variant_key) lookups.
    index("product_stock_product_id_idx").on(table.productId),
    // `reserved <= onHand` is a true invariant: reserve only increments reserved
    // under an `onHand - reserved >= qty` guard, commit/release move both/only
    // reserved down, and the Sanity restock sync clamps `onHand` to never fall
    // below `reserved`. Enforcing it here turns any future violation into a loud
    // failure instead of silently stranding a reservation.
    check(
      "product_stock_nonnegative_check",
      sql`${table.onHand} >= 0 AND ${table.reserved} >= 0 AND ${table.reserved} <= ${table.onHand}`,
    ),
  ],
);

/**
 * Insert-only ledger of stock changes for one tracked stock row. The partial
 * unique index on `(orderId, productStockId, kind)` (order-scoped rows only)
 * makes commit and release exactly-once under webhook replay or a repeated
 * failure signal. Restocks carry a NULL `orderId` and are not deduped. Rows are
 * never updated, only inserted; they are removed (via `ON DELETE CASCADE`) when
 * their stock row is untracked, which only happens with zero units reserved, so
 * no in-flight order loses the reserve record it depends on.
 */
export const productStockMovements = pgTable(
  "product_stock_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productStockId: uuid("product_stock_id")
      .notNull()
      .references(() => productStock.id, { onDelete: "cascade" }),
    orderId: text("order_id"),
    kind: productStockMovementKind("kind").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_stock_movements_order_kind_idx")
      .on(table.orderId, table.productStockId, table.kind)
      .where(sql`${table.orderId} IS NOT NULL`),
    index("product_stock_movements_stock_idx").on(table.productStockId),
    check(
      "product_stock_movements_quantity_positive_check",
      sql`${table.quantity} > 0`,
    ),
  ],
);

export const shippingPackageProfiles = pgTable(
  "shipping_package_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    rank: integer("rank").notNull(),
    packageType: text("package_type").notNull(),
    lengthCm: integer("length_cm").notNull(),
    widthCm: integer("width_cm").notNull(),
    heightCm: integer("height_cm").notNull(),
    tareWeightGrams: integer("tare_weight_grams").notNull(),
    maxWeightGrams: integer("max_weight_grams").notNull(),
    acceptsRigid: boolean("accepts_rigid").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByAdminUserId: uuid("reviewed_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    reviewStepUpAuthenticatedAt: timestamp("review_step_up_authenticated_at", {
      withTimezone: true,
    }),
    evidenceReference: text("evidence_reference"),
    reviewEvidenceHash: text("review_evidence_hash"),
    reviewEvidenceVersion: text("review_evidence_version"),
    reviewAction: text("review_action"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shipping_package_profiles_enabled_rank_idx").on(
      table.enabled,
      table.rank,
    ),
    check(
      "shipping_package_profiles_dimensions_check",
      sql`${table.lengthCm} > 0 AND ${table.widthCm} > 0 AND ${table.heightCm} > 0`,
    ),
    check(
      "shipping_package_profiles_capacity_check",
      sql`${table.maxWeightGrams} > 0 AND ${table.tareWeightGrams} >= 0`,
    ),
    check(
      "shipping_package_profiles_enabled_evidence_check",
      sql`${table.enabled} = false OR (${table.reviewedAt} IS NOT NULL AND ${table.reviewedByAdminUserId} IS NOT NULL AND ${table.reviewStepUpAuthenticatedAt} IS NOT NULL AND ${table.reviewStepUpAuthenticatedAt} <= ${table.reviewedAt} AND ${table.reviewStepUpAuthenticatedAt} >= ${table.reviewedAt} - interval '5 minutes' AND length(trim(${table.evidenceReference})) > 0 AND ${table.reviewEvidenceHash} ~ '^[0-9a-f]{64}$' AND length(trim(${table.reviewEvidenceVersion})) > 0 AND ${table.reviewAction} = 'approve_shipping_package_profile')`,
    ),
  ],
);

export const shippingCalendarVersions = pgTable(
  "shipping_calendar_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: text("version").notNull().unique(),
    status: text("status").notNull().default("draft"),
    timezone: text("timezone").notNull().default("America/Toronto"),
    coverageStartsOn: date("coverage_starts_on").notNull(),
    coverageEndsOn: date("coverage_ends_on").notNull(),
    closureDates: jsonb("closure_dates")
      .$type<Array<{ date: string; kind: string; label: string }>>()
      .notNull(),
    evidenceReference: text("evidence_reference"),
    attestedByAdminUserId: uuid("attested_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("shipping_calendar_versions_one_effective_idx")
      .on(table.status)
      .where(sql`${table.status} = 'effective'`),
    check(
      "shipping_calendar_versions_status_check",
      sql`${table.status} IN ('draft', 'effective', 'superseded')`,
    ),
    check(
      "shipping_calendar_versions_coverage_check",
      sql`${table.coverageEndsOn} >= ${table.coverageStartsOn}`,
    ),
    check(
      "shipping_calendar_versions_effective_evidence_check",
      sql`${table.status} <> 'effective' OR (${table.effectiveAt} IS NOT NULL AND ${table.attestedAt} IS NOT NULL AND ${table.attestedByAdminUserId} IS NOT NULL AND length(trim(${table.evidenceReference})) > 0 AND ${table.supersededAt} IS NULL)`,
    ),
  ],
);

export const productShipments = pgTable(
  "product_shipments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => checkoutOrders.id, {
      onDelete: "set null",
    }),
    sequence: integer("sequence").notNull().default(0),
    purpose: productShipmentPurpose("purpose").notNull().default("original"),
    supersedesShipmentId: uuid("supersedes_shipment_id").references(
      (): AnyPgColumn => productShipments.id,
      { onDelete: "set null" },
    ),
    publicReference: text("public_reference").notNull().unique(),
    quoteTokenHash: text("quote_token_hash").notNull().unique(),
    quoteFingerprint: text("quote_fingerprint").notNull(),
    provider: text("provider").notNull().default("chitchats"),
    providerShipmentId: text("provider_shipment_id").unique(),
    providerStatus: text("provider_status"),
    status: productShipmentStatus("status").notNull().default("quote_pending"),
    stateVersion: integer("state_version").notNull().default(1),
    providerEventAt: timestamp("provider_event_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    destination: jsonb("destination")
      .$type<ProductShipmentDestinationSnapshot>()
      .notNull(),
    packageSnapshot: jsonb("package_snapshot")
      .$type<ProductShipmentPackageSnapshot>()
      .notNull(),
    customsLines: jsonb("customs_lines")
      .$type<ProductShipmentCustomsLineSnapshot[]>()
      .notNull(),
    rates: jsonb("rates").$type<ProductShipmentRateSnapshot[]>().notNull(),
    selectedRateId: text("selected_rate_id"),
    selectedPostageType: text("selected_postage_type"),
    quotedShippingCents: integer("quoted_shipping_cents"),
    actualPostageCents: integer("actual_postage_cents"),
    actualInsuranceCents: integer("actual_insurance_cents"),
    actualPurchaseTotalCents: integer("actual_purchase_total_cents"),
    purchaseVarianceCents: integer("purchase_variance_cents"),
    providerCostCurrency: text("provider_cost_currency")
      .notNull()
      .default("CAD"),
    actualDeliveryFeeCents: integer("actual_delivery_fee_cents"),
    actualTariffFeeCents: integer("actual_tariff_fee_cents"),
    actualFdaPriorNotificationFeeCents: integer(
      "actual_fda_prior_notification_fee_cents",
    ),
    actualFederalTaxCents: integer("actual_federal_tax_cents"),
    actualProvincialTaxCents: integer("actual_provincial_tax_cents"),
    trackingNumber: text("tracking_number"),
    trackingUrl: text("tracking_url"),
    rawShipment: jsonb("raw_shipment").$type<Record<string, unknown>>(),
    quoteExpiresAt: timestamp("quote_expires_at", {
      withTimezone: true,
    }).notNull(),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    providerShipDateAt: timestamp("provider_ship_date_at", {
      withTimezone: true,
    }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    originalHandoffDeadlineAt: timestamp("original_handoff_deadline_at", {
      withTimezone: true,
    }),
    autoRefundDeadlineAt: timestamp("auto_refund_deadline_at", {
      withTimezone: true,
    }),
    calendarVersionId: uuid("calendar_version_id").references(
      () => shippingCalendarVersions.id,
      { onDelete: "restrict" },
    ),
    usShippingContractSnapshot: jsonb(
      "us_shipping_contract_snapshot",
    ).$type<FulfillmentProviderCertificationContractSnapshot>(),
    deadlinePolicySnapshot: jsonb("deadline_policy_snapshot").$type<
      Record<string, unknown>
    >(),
    manualReviewAcknowledgedAt: timestamp("manual_review_acknowledged_at", {
      withTimezone: true,
    }),
    manualReviewEvidenceReference: text("manual_review_evidence_reference"),
    manualReviewRationale: text("manual_review_rationale"),
    manualReviewByAdminUserId: uuid(
      "manual_review_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    manualReviewStepUpAuthenticatedAt: timestamp(
      "manual_review_step_up_authenticated_at",
      { withTimezone: true },
    ),
    manualReviewStartedAt: timestamp("manual_review_started_at", {
      withTimezone: true,
    }),
    manualReviewAlertedAt: timestamp("manual_review_alerted_at", {
      withTimezone: true,
    }),
    manualReviewEscalatedAt: timestamp("manual_review_escalated_at", {
      withTimezone: true,
    }),
    customerNotifiedAt: timestamp("customer_notified_at", {
      withTimezone: true,
    }),
    latestEstimatedDeliveryAt: timestamp("latest_estimated_delivery_at", {
      withTimezone: true,
    }),
    deliveryMaxBusinessDays: integer("delivery_max_business_days"),
    lastCarrierMovementAt: timestamp("last_carrier_movement_at", {
      withTimezone: true,
    }),
    signatureRequired: boolean("signature_required").notNull().default(false),
    signatureRequested: boolean("signature_requested").notNull().default(false),
    privacyTerminalAt: timestamp("privacy_terminal_at", {
      withTimezone: true,
    }),
    acceptedEmailSentAt: timestamp("accepted_email_sent_at", {
      withTimezone: true,
    }),
    exceptionEmailSentAt: timestamp("exception_email_sent_at", {
      withTimezone: true,
    }),
    deliveredEmailSentAt: timestamp("delivered_email_sent_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
  },
  (table) => [
    uniqueIndex("product_shipments_order_sequence_idx").on(
      table.orderId,
      table.sequence,
    ),
    index("product_shipments_quote_fingerprint_idx").on(
      table.quoteFingerprint,
      table.quoteExpiresAt,
    ),
    index("product_shipments_poll_idx").on(table.status, table.updatedAt),
    check(
      "product_shipments_actual_costs_nonnegative_check",
      sql`coalesce(${table.actualPurchaseTotalCents}, 0) >= 0
        AND coalesce(${table.actualPostageCents}, 0) >= 0
        AND coalesce(${table.actualInsuranceCents}, 0) >= 0
        AND coalesce(${table.actualDeliveryFeeCents}, 0) >= 0
        AND coalesce(${table.actualTariffFeeCents}, 0) >= 0
        AND coalesce(${table.actualFdaPriorNotificationFeeCents}, 0) >= 0
        AND coalesce(${table.actualFederalTaxCents}, 0) >= 0
        AND coalesce(${table.actualProvincialTaxCents}, 0) >= 0`,
    ),
    check(
      "product_shipments_manual_review_evidence_check",
      sql`(
        ${table.manualReviewEvidenceReference} IS NULL
        AND ${table.manualReviewRationale} IS NULL
        AND ${table.manualReviewByAdminUserId} IS NULL
        AND ${table.manualReviewStepUpAuthenticatedAt} IS NULL
      ) OR (
        ${table.manualReviewEvidenceReference} IS NOT NULL
        AND ${table.manualReviewRationale} IS NOT NULL
        AND ${table.manualReviewByAdminUserId} IS NOT NULL
        AND ${table.manualReviewStepUpAuthenticatedAt} IS NOT NULL
        AND ${table.manualReviewAcknowledgedAt} IS NOT NULL
        AND length(trim(${table.manualReviewEvidenceReference})) >= 6
        AND length(trim(${table.manualReviewRationale})) >= 10
        AND ${table.manualReviewStepUpAuthenticatedAt} <= ${table.manualReviewAcknowledgedAt}
        AND ${table.manualReviewStepUpAuthenticatedAt} >= ${table.manualReviewAcknowledgedAt} - interval '5 minutes'
      )`,
    ),
  ],
);

export const productShipmentEvents = pgTable(
  "product_shipment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => productShipments.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull().unique(),
    providerStatus: text("provider_status"),
    normalizedStatus: productShipmentStatus("normalized_status").notNull(),
    description: text("description"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_shipment_events_shipment_occurred_idx").on(
      table.shipmentId,
      table.occurredAt,
    ),
  ],
);

export const productShipmentJobs = pgTable(
  "product_shipment_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => productShipments.id, { onDelete: "cascade" }),
    type: productShipmentJobType("type").notNull(),
    status: productShipmentJobStatus("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    stateVersion: integer("state_version").notNull().default(1),
    operationPayloadHash: text("operation_payload_hash"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    outcomeCode: text("outcome_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    outcomeUnknown: boolean("outcome_unknown").notNull().default(false),
    reconciliationEvidenceReference: text("reconciliation_evidence_reference"),
    reconciliationRationale: text("reconciliation_rationale"),
    reconciliationRequestedByAdminUserId: uuid(
      "reconciliation_requested_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    reconciliationStepUpAuthenticatedAt: timestamp(
      "reconciliation_step_up_authenticated_at",
      { withTimezone: true },
    ),
    reconciliationRequestedAt: timestamp("reconciliation_requested_at", {
      withTimezone: true,
    }),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_shipment_jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "product_shipment_jobs_reconciliation_evidence_check",
      sql`(
        ${table.reconciliationEvidenceReference} IS NULL
        AND ${table.reconciliationRationale} IS NULL
        AND ${table.reconciliationRequestedByAdminUserId} IS NULL
        AND ${table.reconciliationStepUpAuthenticatedAt} IS NULL
        AND ${table.reconciliationRequestedAt} IS NULL
      ) OR (
        ${table.reconciliationEvidenceReference} IS NOT NULL
        AND ${table.reconciliationRationale} IS NOT NULL
        AND ${table.reconciliationRequestedByAdminUserId} IS NOT NULL
        AND ${table.reconciliationStepUpAuthenticatedAt} IS NOT NULL
        AND ${table.reconciliationRequestedAt} IS NOT NULL
        AND length(trim(${table.reconciliationEvidenceReference})) >= 6
        AND length(trim(${table.reconciliationRationale})) >= 10
        AND ${table.reconciliationStepUpAuthenticatedAt} <= ${table.reconciliationRequestedAt}
        AND ${table.reconciliationStepUpAuthenticatedAt} >= ${table.reconciliationRequestedAt} - interval '5 minutes'
      )`,
    ),
  ],
);

export const shippingPolicySettings = pgTable(
  "shipping_policy_settings",
  {
    singletonKey: text("singleton_key").primaryKey().default("default"),
    timezone: text("timezone").notNull().default("America/Toronto"),
    orderCutoff: time("order_cutoff").notNull().default("14:00:00"),
    coverageStartsAt: time("coverage_starts_at").notNull().default("09:00:00"),
    coverageEndsAt: time("coverage_ends_at").notNull().default("17:00:00"),
    beforeCutoffHandoffBusinessDays: integer(
      "before_cutoff_handoff_business_days",
    )
      .notNull()
      .default(1),
    afterCutoffHandoffBusinessDays: integer(
      "after_cutoff_handoff_business_days",
    )
      .notNull()
      .default(2),
    autoRefundBusinessDays: integer("auto_refund_business_days")
      .notNull()
      .default(2),
    manualReviewAlertCoverageHours: integer(
      "manual_review_alert_coverage_hours",
    )
      .notNull()
      .default(2),
    manualReviewEscalationCoverageHours: integer(
      "manual_review_escalation_coverage_hours",
    )
      .notNull()
      .default(4),
    signatureThresholdCents: integer("signature_threshold_cents")
      .notNull()
      .default(50000),
    addressReviewThresholdCents: integer("address_review_threshold_cents")
      .notNull()
      .default(15000),
    fundingReloadThresholdCents: integer("funding_reload_threshold_cents")
      .notNull()
      .default(2500),
    fundingReloadAmountCents: integer("funding_reload_amount_cents")
      .notNull()
      .default(10000),
    fundingMaximumBalanceCents: integer("funding_maximum_balance_cents")
      .notNull()
      .default(50000),
    fundingRollingDayLimitCents: integer("funding_rolling_day_limit_cents")
      .notNull()
      .default(75000),
    fundingMonthlyLimitCents: integer("funding_monthly_limit_cents")
      .notNull()
      .default(150000),
    fundingEmergencyTopUpCents: integer("funding_emergency_top_up_cents")
      .notNull()
      .default(25000),
    pilotStartedAt: timestamp("pilot_started_at", { withTimezone: true }),
    policyVersion: text("policy_version").notNull().default("2026-08-13"),
    forwarderPatterns: jsonb("forwarder_patterns")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "shipping_policy_settings_singleton_check",
      sql`${table.singletonKey} = 'default'`,
    ),
    check(
      "shipping_policy_settings_coverage_check",
      sql`${table.coverageEndsAt} > ${table.coverageStartsAt}`,
    ),
    check(
      "shipping_policy_settings_limits_check",
      sql`${table.signatureThresholdCents} > 0 AND ${table.addressReviewThresholdCents} > 0 AND ${table.fundingReloadThresholdCents} > 0 AND ${table.fundingReloadAmountCents} > 0 AND ${table.fundingMaximumBalanceCents} > 0`,
    ),
  ],
);

export const shippingCalendarExceptions = pgTable(
  "shipping_calendar_exceptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    exceptionDate: date("exception_date").notNull(),
    kind: shippingCalendarExceptionKind("kind").notNull(),
    label: text("label").notNull(),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("shipping_calendar_exceptions_date_kind_idx").on(
      table.exceptionDate,
      table.kind,
    ),
  ],
);

export const productShippingCases = pgTable(
  "product_shipping_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    shipmentId: uuid("shipment_id").references(() => productShipments.id, {
      onDelete: "set null",
    }),
    sourceShipmentId: uuid("source_shipment_id").references(
      () => productShipments.id,
      { onDelete: "set null" },
    ),
    remedyShipmentId: uuid("remedy_shipment_id").references(
      () => productShipments.id,
      { onDelete: "set null" },
    ),
    type: productShippingCaseType("type").notNull(),
    status: productShippingCaseStatus("status").notNull().default("open"),
    stateVersion: integer("state_version").notNull().default(1),
    cause: text("cause"),
    providerClaimReference: text("provider_claim_reference"),
    evidenceChecklist: jsonb("evidence_checklist")
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }),
    carrierDeadlineAt: timestamp("carrier_deadline_at", { withTimezone: true }),
    customerUpdateDueAt: timestamp("customer_update_due_at", {
      withTimezone: true,
    }),
    remedyDeadlineAt: timestamp("remedy_deadline_at", { withTimezone: true }),
    remedyChoice: text("remedy_choice"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    fulfillmentQuarantinedAt: timestamp("fulfillment_quarantined_at", {
      withTimezone: true,
    }),
    fulfillmentQuarantineReason: text("fulfillment_quarantine_reason"),
  },
  (table) => [
    index("product_shipping_cases_queue_idx").on(
      table.status,
      table.customerUpdateDueAt,
      table.carrierDeadlineAt,
    ),
    index("product_shipping_cases_order_idx").on(
      table.orderId,
      table.createdAt,
    ),
    check(
      "product_shipping_cases_state_version_check",
      sql`${table.stateVersion} >= 1`,
    ),
    uniqueIndex("product_shipping_cases_one_active_idx")
      .on(
        table.orderId,
        sql`coalesce(${table.shipmentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        table.type,
      )
      .where(
        sql`${table.status} IN ('open', 'waiting_customer', 'waiting_provider', 'remedy_pending') AND ${table.fulfillmentQuarantinedAt} IS NULL`,
      ),
  ],
);

export const orderPaymentObligations = pgTable(
  "order_payment_obligations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    purpose: orderPaymentObligationPurpose("purpose").notNull(),
    status: orderPaymentObligationStatus("status").notNull().default("pending"),
    merchandiseAmountCents: integer("merchandise_amount_cents")
      .notNull()
      .default(0),
    shippingAmountCents: integer("shipping_amount_cents").notNull().default(0),
    taxAmountCents: integer("tax_amount_cents").notNull().default(0),
    totalAmountCents: integer("total_amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("square"),
    providerCheckoutId: text("provider_checkout_id"),
    checkoutTokenHash: text("checkout_token_hash"),
    secretTokenCiphertext: text("secret_token_ciphertext"),
    initializationStatus: checkoutInitializationStatus("initialization_status")
      .notNull()
      .default("initializing"),
    initializationStateVersion: integer("initialization_state_version")
      .notNull()
      .default(1),
    initializationLeaseOwner: text("initialization_lease_owner"),
    initializationLeaseExpiresAt: timestamp("initialization_lease_expires_at", {
      withTimezone: true,
    }),
    initializationAttemptCount: integer("initialization_attempt_count")
      .notNull()
      .default(0),
    initializationNextAttemptAt: timestamp("initialization_next_attempt_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    initializationOutcome: text("initialization_outcome"),
    initializationLastError: text("initialization_last_error"),
    initializationPayloadHash: text("initialization_payload_hash"),
    sourceWorkflow: text("source_workflow").notNull(),
    sourceReferenceId: uuid("source_reference_id"),
    disclosureSnapshot: jsonb("disclosure_snapshot").$type<
      Record<string, unknown>
    >(),
    taxPolicyVersion: text("tax_policy_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    quoteVersion: integer("quote_version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    quarantineReason: text("quarantine_reason"),
  },
  (table) => [
    index("order_payment_obligations_order_idx").on(
      table.orderId,
      table.createdAt,
    ),
    uniqueIndex("order_payment_obligations_one_primary_idx")
      .on(table.orderId)
      .where(
        sql`${table.purpose} = 'primary' AND ${table.quarantinedAt} IS NULL`,
      ),
    uniqueIndex("order_payment_obligations_provider_checkout_idx")
      .on(table.paymentProvider, table.providerCheckoutId)
      .where(
        sql`${table.providerCheckoutId} IS NOT NULL AND ${table.quarantinedAt} IS NULL`,
      ),
    uniqueIndex("order_payment_obligations_checkout_token_idx")
      .on(table.checkoutTokenHash)
      .where(
        sql`${table.checkoutTokenHash} IS NOT NULL AND ${table.quarantinedAt} IS NULL`,
      ),
    check(
      "order_payment_obligations_components_check",
      sql`${table.merchandiseAmountCents} >= 0 AND ${table.shippingAmountCents} >= 0 AND ${table.taxAmountCents} >= 0 AND ${table.totalAmountCents} = ${table.merchandiseAmountCents} + ${table.shippingAmountCents} + ${table.taxAmountCents}`,
    ),
    check(
      "order_payment_obligations_quarantine_check",
      sql`(${table.quarantinedAt} IS NULL AND ${table.quarantineReason} IS NULL) OR (${table.quarantinedAt} IS NOT NULL AND length(trim(${table.quarantineReason})) > 0)`,
    ),
  ],
);

export const orderPaymentTransactions = pgTable(
  "order_payment_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => orderPaymentObligations.id, { onDelete: "restrict" }),
    provider: paymentProvider("provider").notNull().default("square"),
    providerTransactionId: text("provider_transaction_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    originatingIpCiphertext: text("originating_ip_ciphertext"),
    providerType: text("provider_type").notNull(),
    providerStatus: text("provider_status").notNull(),
    avsCode: text("avs_code"),
    cvvCode: text("cvv_code"),
    riskStatus: paymentRiskStatus("risk_status").notNull().default("pending"),
    riskReasonCodes: jsonb("risk_reason_codes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("order_payment_transactions_provider_id_idx").on(
      table.provider,
      table.providerTransactionId,
    ),
    index("order_payment_transactions_obligation_idx").on(table.obligationId),
    check(
      "order_payment_transactions_amount_check",
      sql`${table.amountCents} > 0`,
    ),
  ],
);

export const productOrderAdjustments = pgTable(
  "product_order_adjustments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    direction: productOrderAdjustmentDirection("direction").notNull(),
    component: productOrderAdjustmentComponent("component").notNull(),
    reason: text("reason").notNull(),
    sourceShipmentId: uuid("source_shipment_id").references(
      () => productShipments.id,
      { onDelete: "set null" },
    ),
    sourceCaseId: uuid("source_case_id").references(
      () => productShippingCases.id,
      { onDelete: "set null" },
    ),
    sourceAddressRequestId: uuid("source_address_request_id"),
    amountCents: integer("amount_cents").notNull(),
    status: productOrderAdjustmentStatus("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_order_adjustments_order_idx").on(
      table.orderId,
      table.createdAt,
    ),
    check(
      "product_order_adjustments_amount_check",
      sql`${table.amountCents} > 0`,
    ),
  ],
);

export const productPaymentRiskIncidents = pgTable(
  "product_payment_risk_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => orderPaymentTransactions.id,
      { onDelete: "set null" },
    ),
    incidentKey: text("incident_key").notNull().unique(),
    status: paymentRiskStatus("status").notNull().default("review_required"),
    reasonCodes: jsonb("reason_codes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    providerEvidence:
      jsonb("provider_evidence").$type<Record<string, unknown>>(),
    policyVersion: text("policy_version").notNull(),
    ownerAdminUserId: uuid("owner_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    stepUpAuthenticatedAt: timestamp("step_up_authenticated_at", {
      withTimezone: true,
    }),
    coolingOffUntil: timestamp("cooling_off_until", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rationale: text("rationale"),
    outcome: text("outcome"),
    stateVersion: integer("state_version").notNull().default(1),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
  },
  (table) => [
    index("product_payment_risk_incidents_queue_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const fulfillmentOwnerActions = pgTable(
  "fulfillment_owner_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    action: text("action").notNull(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    policyVersion: text("policy_version").notNull(),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    stepUpAuthenticatedAt: timestamp("step_up_authenticated_at", {
      withTimezone: true,
    }).notNull(),
    coolingOffUntil: timestamp("cooling_off_until", {
      withTimezone: true,
    }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("fulfillment_owner_actions_target_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
    check(
      "fulfillment_owner_actions_rationale_check",
      sql`length(trim(${table.rationale})) >= 10`,
    ),
  ],
);

export const productManualFulfillmentEvents = pgTable(
  "product_manual_fulfillment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    actorAdminUserId: uuid("actor_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    rationale: text("rationale").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
  },
  (table) => [
    index("product_manual_fulfillment_events_order_idx").on(
      table.orderId,
      table.occurredAt,
    ),
    check(
      "product_manual_fulfillment_events_status_check",
      sql`${table.status} IN ('payment_pending', 'paid_pending_dispatch', 'dispatched', 'cancelled')`,
    ),
    check(
      "product_manual_fulfillment_events_method_check",
      sql`${table.method} IN ('manual_shipping', 'pickup_handoff')`,
    ),
    check(
      "product_manual_fulfillment_events_rationale_check",
      sql`length(trim(${table.rationale})) >= 10`,
    ),
  ],
);

export const fulfillmentDataQuarantine = pgTable(
  "fulfillment_data_quarantine",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
  },
  (table) => [
    uniqueIndex("fulfillment_data_quarantine_identity_idx").on(
      table.entityType,
      table.entityId,
      table.reasonCode,
    ),
    index("fulfillment_data_quarantine_queue_idx").on(
      table.status,
      table.createdAt,
    ),
    check(
      "fulfillment_data_quarantine_status_check",
      sql`${table.status} IN ('open', 'resolved', 'dismissed')`,
    ),
  ],
);

export const productOrderRefunds = pgTable(
  "product_order_refunds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => productShippingCases.id, {
      onDelete: "set null",
    }),
    idempotencyKey: uuid("idempotency_key").notNull().unique(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    amountCents: integer("amount_cents").notNull(),
    originalTransactionId: text("original_transaction_id").notNull(),
    status: productOrderRefundStatus("status").notNull().default("queued"),
    providerRefundId: text("provider_refund_id"),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => orderPaymentTransactions.id,
      { onDelete: "restrict" },
    ),
    adjustmentId: uuid("adjustment_id").references(
      () => productOrderAdjustments.id,
      { onDelete: "restrict" },
    ),
    attemptCount: integer("attempt_count").notNull().default(0),
    stateVersion: integer("state_version").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    firstAttemptedAt: timestamp("first_attempted_at", { withTimezone: true }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    unknownOutcomeAt: timestamp("unknown_outcome_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    manualReviewEvidenceReference: text("manual_review_evidence_reference"),
    manualReviewRationale: text("manual_review_rationale"),
    manualReviewByAdminUserId: uuid(
      "manual_review_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    manualReviewStepUpAuthenticatedAt: timestamp(
      "manual_review_step_up_authenticated_at",
      { withTimezone: true },
    ),
    manualReviewRecordedAt: timestamp("manual_review_recorded_at", {
      withTimezone: true,
    }),
    requestedByAdminUserId: uuid("requested_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    automated: boolean("automated").notNull().default(false),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    fulfillmentQuarantinedAt: timestamp("fulfillment_quarantined_at", {
      withTimezone: true,
    }),
    fulfillmentQuarantineReason: text("fulfillment_quarantine_reason"),
  },
  (table) => [
    index("product_order_refunds_queue_idx").on(table.status, table.createdAt),
    index("product_order_refunds_order_idx").on(table.orderId, table.createdAt),
    uniqueIndex("product_order_refunds_provider_refund_id_idx")
      .on(table.providerRefundId)
      .where(
        sql`${table.providerRefundId} IS NOT NULL AND ${table.fulfillmentQuarantinedAt} IS NULL`,
      ),
    check("product_order_refunds_amount_check", sql`${table.amountCents} > 0`),
    check(
      "product_order_refunds_kind_check",
      sql`${table.kind} IN ('full', 'partial')`,
    ),
    check(
      "product_order_refunds_manual_review_evidence_check",
      sql`(
        ${table.manualReviewEvidenceReference} IS NULL
        AND ${table.manualReviewRationale} IS NULL
        AND ${table.manualReviewByAdminUserId} IS NULL
        AND ${table.manualReviewStepUpAuthenticatedAt} IS NULL
        AND ${table.manualReviewRecordedAt} IS NULL
      ) OR (
        ${table.manualReviewEvidenceReference} IS NOT NULL
        AND ${table.manualReviewRationale} IS NOT NULL
        AND ${table.manualReviewByAdminUserId} IS NOT NULL
        AND ${table.manualReviewStepUpAuthenticatedAt} IS NOT NULL
        AND ${table.manualReviewRecordedAt} IS NOT NULL
        AND length(trim(${table.manualReviewEvidenceReference})) >= 6
        AND length(trim(${table.manualReviewRationale})) >= 10
        AND ${table.manualReviewStepUpAuthenticatedAt} <= ${table.manualReviewRecordedAt}
        AND ${table.manualReviewStepUpAuthenticatedAt} >= ${table.manualReviewRecordedAt} - interval '5 minutes'
      )`,
    ),
  ],
);

export const productOrderCustomerDecisions = pgTable(
  "product_order_customer_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => productShippingCases.id, {
      onDelete: "set null",
    }),
    shipmentId: uuid("shipment_id").references(() => productShipments.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    scopeVersion: integer("scope_version").notNull().default(1),
    supersedesDecisionId: uuid("supersedes_decision_id").references(
      (): AnyPgColumn => productOrderCustomerDecisions.id,
      { onDelete: "set null" },
    ),
    proposedConditions: jsonb("proposed_conditions").$type<
      Record<string, unknown>
    >(),
    proposedConditionsHash: text("proposed_conditions_hash").notNull(),
    allowedOutcomes: jsonb("allowed_outcomes").$type<string[]>().notNull(),
    selectedOutcome: text("selected_outcome"),
    tokenHash: text("token_hash").notNull().unique(),
    status: productOrderCustomerDecisionStatus("status")
      .notNull()
      .default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
    selectedAt: timestamp("selected_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    waitUntil: timestamp("wait_until", { withTimezone: true }),
    stateVersion: integer("state_version").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseVersion: integer("lease_version").notNull().default(0),
    legalFollowUpEvidenceReference: text("legal_follow_up_evidence_reference"),
    legalFollowUpRationale: text("legal_follow_up_rationale"),
    legalFollowUpByAdminUserId: uuid(
      "legal_follow_up_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    legalFollowUpStepUpAuthenticatedAt: timestamp(
      "legal_follow_up_step_up_authenticated_at",
      { withTimezone: true },
    ),
    legalFollowUpRecordedAt: timestamp("legal_follow_up_recorded_at", {
      withTimezone: true,
    }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_order_customer_decisions_deadline_idx").on(
      table.status,
      table.expiresAt,
    ),
    index("product_order_customer_decisions_order_idx").on(
      table.orderId,
      table.createdAt,
    ),
    uniqueIndex("product_order_customer_decisions_scope_idx").on(
      table.orderId,
      table.scopeKey,
      table.scopeVersion,
    ),
    check(
      "product_order_customer_decisions_legal_follow_up_evidence_check",
      sql`(
        ${table.legalFollowUpEvidenceReference} IS NULL
        AND ${table.legalFollowUpRationale} IS NULL
        AND ${table.legalFollowUpByAdminUserId} IS NULL
        AND ${table.legalFollowUpStepUpAuthenticatedAt} IS NULL
        AND ${table.legalFollowUpRecordedAt} IS NULL
      ) OR (
        ${table.legalFollowUpEvidenceReference} IS NOT NULL
        AND ${table.legalFollowUpRationale} IS NOT NULL
        AND ${table.legalFollowUpByAdminUserId} IS NOT NULL
        AND ${table.legalFollowUpStepUpAuthenticatedAt} IS NOT NULL
        AND ${table.legalFollowUpRecordedAt} IS NOT NULL
        AND length(trim(${table.legalFollowUpEvidenceReference})) >= 6
        AND length(trim(${table.legalFollowUpRationale})) >= 10
        AND ${table.legalFollowUpStepUpAuthenticatedAt} <= ${table.legalFollowUpRecordedAt}
        AND ${table.legalFollowUpStepUpAuthenticatedAt} >= ${table.legalFollowUpRecordedAt} - interval '5 minutes'
      )`,
    ),
  ],
);

export const shippingCustomerLinkIssuances = pgTable(
  "shipping_customer_link_issuances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shipping_customer_link_issuances_order_idx").on(
      table.orderId,
      table.issuedAt,
    ),
    uniqueIndex("shipping_customer_link_issuances_target_idx").on(
      table.kind,
      table.targetId,
    ),
    check(
      "shipping_customer_link_issuances_kind_check",
      sql`${table.kind} IN ('address_change', 'customer_decision', 'supplemental_payment')`,
    ),
  ],
);

export const shippingPolicyJobs = pgTable(
  "shipping_policy_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    taskKey: text("task_key").notNull().unique(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    stateVersion: integer("state_version").notNull().default(1),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    outcomeCode: text("outcome_code"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("shipping_policy_jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "shipping_policy_jobs_type_check",
      sql`${table.type} IN ('deadlines', 'decisions', 'remedies', 'refunds', 'returns', 'claims', 'funding', 'calendar', 'privacy', 'notifications')`,
    ),
    check(
      "shipping_policy_jobs_status_check",
      sql`${table.status} IN ('queued', 'processing', 'succeeded', 'retryable_failure', 'manual_review')`,
    ),
  ],
);

export const productOrderTerminationWorkflows = pgTable(
  "product_order_termination_workflows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    policyVersion: text("policy_version").notNull(),
    status: text("status").notNull().default("scheduled"),
    noticeAt: timestamp("notice_at", { withTimezone: true }).notNull(),
    executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
    hardCapAt: timestamp("hard_cap_at", { withTimezone: true }).notNull(),
    stateVersion: integer("state_version").notNull().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    refundReservedAt: timestamp("refund_reserved_at", { withTimezone: true }),
    customerNoticeQueuedAt: timestamp("customer_notice_queued_at", {
      withTimezone: true,
    }),
    ownerNoticeQueuedAt: timestamp("owner_notice_queued_at", {
      withTimezone: true,
    }),
    operationallyTerminatedAt: timestamp("operationally_terminated_at", {
      withTimezone: true,
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    outcomeUnknownAt: timestamp("outcome_unknown_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_order_termination_workflows_order_idx").on(
      table.orderId,
    ),
    index("product_order_termination_workflows_due_idx").on(
      table.status,
      table.executeAt,
      table.leaseExpiresAt,
    ),
    index("product_order_termination_workflows_hard_cap_idx").on(
      table.hardCapAt,
      table.status,
    ),
    check(
      "product_order_termination_workflows_status_check",
      sql`${table.status} IN ('scheduled', 'processing', 'refund_pending', 'outcome_unknown', 'manual_review', 'completed', 'cancelled')`,
    ),
    check(
      "product_order_termination_workflows_deadline_check",
      sql`${table.noticeAt} < ${table.executeAt} AND ${table.executeAt} < ${table.hardCapAt}`,
    ),
    check(
      "product_order_termination_workflows_attempt_check",
      sql`${table.attemptCount} >= 0 AND ${table.stateVersion} >= 1`,
    ),
  ],
);

export const productOrderAddressChangeRequests = pgTable(
  "product_order_address_change_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    shipmentId: uuid("shipment_id").references(() => productShipments.id, {
      onDelete: "set null",
    }),
    status: productOrderAddressChangeStatus("status")
      .notNull()
      .default("pending_customer"),
    originalAddress: jsonb("original_address")
      .$type<CheckoutOrderShippingAddressSnapshot>()
      .notNull(),
    proposedAddress:
      jsonb("proposed_address").$type<CheckoutOrderShippingAddressSnapshot>(),
    riskFlags: jsonb("risk_flags")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    riskIncidentId: uuid("risk_incident_id").references(
      () => productPaymentRiskIncidents.id,
      { onDelete: "restrict" },
    ),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    firstApprovedByAdminUserId: uuid(
      "first_approved_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    firstApprovedAt: timestamp("first_approved_at", { withTimezone: true }),
    secondApprovedByAdminUserId: uuid(
      "second_approved_by_admin_user_id",
    ).references(() => adminUsers.id, { onDelete: "set null" }),
    secondApprovedAt: timestamp("second_approved_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    postageDifferenceCents: integer("postage_difference_cents"),
    providerReconciliation: jsonb("provider_reconciliation").$type<
      Record<string, unknown>
    >(),
    reconciliationState: text("reconciliation_state")
      .notNull()
      .default("not_started"),
    stateVersion: integer("state_version").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseVersion: integer("lease_version").notNull().default(0),
    attemptIdentity: text("attempt_identity"),
    expectedSourceShipmentId: uuid("expected_source_shipment_id").references(
      () => productShipments.id,
      { onDelete: "set null" },
    ),
    expectedSourceShipmentStateVersion: integer(
      "expected_source_shipment_state_version",
    ),
    preparedShipmentId: uuid("prepared_shipment_id").references(
      () => productShipments.id,
      { onDelete: "set null" },
    ),
    preparedShipmentStateVersion: integer("prepared_shipment_state_version"),
    oldPostageOutcome: text("old_postage_outcome"),
    supplementalObligationId: uuid("supplemental_obligation_id").references(
      () => orderPaymentObligations.id,
      { onDelete: "set null" },
    ),
    cleanupOutcome: text("cleanup_outcome"),
    adoptionOutcome: text("adoption_outcome"),
    callbackEvidenceReference: text("callback_evidence_reference"),
    customerCaused: boolean("customer_caused").notNull().default(false),
    offerExpiresAt: timestamp("offer_expires_at", { withTimezone: true }),
    phoneCallbackCompletedAt: timestamp("phone_callback_completed_at", {
      withTimezone: true,
    }),
    stepUpAuthenticatedAt: timestamp("step_up_authenticated_at", {
      withTimezone: true,
    }),
    coolingOffUntil: timestamp("cooling_off_until", { withTimezone: true }),
    ownerRationale: text("owner_rationale"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_order_address_changes_order_idx").on(
      table.orderId,
      table.createdAt,
    ),
    index("product_order_address_changes_deadline_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const productOrderRiskReviews = pgTable(
  "product_order_risk_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "restrict" }),
    reviewerAdminUserId: uuid("reviewer_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    reviewerWasBusinessOwner: boolean("reviewer_was_business_owner")
      .notNull()
      .default(false),
    incidentId: uuid("incident_id").references(
      () => productPaymentRiskIncidents.id,
      { onDelete: "restrict" },
    ),
    stepUpAuthenticatedAt: timestamp("step_up_authenticated_at", {
      withTimezone: true,
    }),
    coolingOffUntil: timestamp("cooling_off_until", { withTimezone: true }),
    providerEvidenceAvailable: boolean("provider_evidence_available")
      .notNull()
      .default(false),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    piiRedactionDueAt: timestamp("pii_redaction_due_at", {
      withTimezone: true,
    })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("product_order_risk_reviews_incident_action_idx").on(
      table.incidentId,
      table.decision,
    ),
    check(
      "product_order_risk_reviews_decision_check",
      sql`${table.decision} IN ('clear_false_positive', 'escalate')`,
    ),
    check(
      "product_order_risk_reviews_rationale_check",
      sql`length(trim(${table.rationale})) >= 10`,
    ),
  ],
);

export const fulfillmentPolicyVersions = pgTable(
  "fulfillment_policy_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: text("version").notNull().unique(),
    status: text("status").notNull().default("draft"),
    ownerName: text("owner_name").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    privacyLegalAttestedAt: timestamp("privacy_legal_attested_at", {
      withTimezone: true,
    }),
    securityAttestedAt: timestamp("security_attested_at", {
      withTimezone: true,
    }),
    operationsAttestedAt: timestamp("operations_attested_at", {
      withTimezone: true,
    }),
    attestationEvidenceReference: text("attestation_evidence_reference"),
    attestedByAdminUserId: uuid("attested_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("fulfillment_policy_versions_one_effective_idx")
      .on(table.status)
      .where(sql`${table.status} = 'effective'`),
    check(
      "fulfillment_policy_versions_status_check",
      sql`${table.status} IN ('draft', 'effective', 'superseded')`,
    ),
    check(
      "fulfillment_policy_versions_effective_evidence_check",
      sql`${table.status} <> 'effective' OR (${table.effectiveAt} IS NOT NULL AND ${table.privacyLegalAttestedAt} IS NOT NULL AND ${table.securityAttestedAt} IS NOT NULL AND ${table.operationsAttestedAt} IS NOT NULL AND ${table.attestedByAdminUserId} IS NOT NULL AND length(trim(${table.attestationEvidenceReference})) > 0 AND ${table.supersededAt} IS NULL)`,
    ),
  ],
);

export const fulfillmentProviderCertifications = pgTable(
  "fulfillment_provider_certifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    environment: text("environment").notNull(),
    scope: text("scope").notNull(),
    version: text("version").notNull(),
    evidenceReference: text("evidence_reference").notNull(),
    contractSnapshot:
      jsonb(
        "contract_snapshot",
      ).$type<FulfillmentProviderCertificationContractSnapshot>(),
    certifiedByOwnerName: text("certified_by_owner_name").notNull(),
    certifiedByAdminUserId: uuid("certified_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "restrict" },
    ),
    certificationStepUpAuthenticatedAt: timestamp(
      "certification_step_up_authenticated_at",
      { withTimezone: true },
    ),
    certificationEvidenceHash: text("certification_evidence_hash"),
    certificationEvidenceVersion: text("certification_evidence_version"),
    certificationAction: text("certification_action"),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("fulfillment_provider_certifications_one_active_scope_idx")
      .on(table.provider, table.environment, table.scope)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "fulfillment_provider_certifications_us_contract_snapshot_check",
      sql`${table.scope} <> 'us_shipping_contract' OR ${table.contractSnapshot} IS NOT NULL`,
    ),
    check(
      "fulfillment_provider_certifications_helcim_contract_snapshot_check",
      sql`${table.provider} <> 'helcim' OR ${table.scope} <> 'product_payments' OR ${table.revokedAt} IS NOT NULL OR ${table.contractSnapshot} IS NOT NULL`,
    ),
    check(
      "fulfillment_provider_certifications_active_owner_evidence_check",
      sql`${table.revokedAt} IS NOT NULL OR (${table.certifiedByAdminUserId} IS NOT NULL AND ${table.certificationStepUpAuthenticatedAt} IS NOT NULL AND ${table.certificationStepUpAuthenticatedAt} <= ${table.certifiedAt} AND ${table.certificationStepUpAuthenticatedAt} >= ${table.certifiedAt} - interval '5 minutes' AND ${table.certificationEvidenceHash} ~ '^[0-9a-f]{64}$' AND length(trim(${table.certificationEvidenceVersion})) > 0 AND ${table.certificationAction} = 'certify_fulfillment_provider')`,
    ),
  ],
);

export const productShipmentReturnObservations = pgTable(
  "product_shipment_return_observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerReturnId: text("provider_return_id").notNull().unique(),
    shipmentId: uuid("shipment_id").references(() => productShipments.id, {
      onDelete: "set null",
    }),
    providerShipmentId: text("provider_shipment_id"),
    matchStatus: text("match_status").notNull().default("unmatched"),
    caseId: uuid("case_id").references(() => productShippingCases.id, {
      onDelete: "set null",
    }),
    providerStatus: text("provider_status"),
    returnReason: text("return_reason"),
    resolution: text("resolution"),
    adminResolutionAction: text("admin_resolution_action"),
    adminResolutionEvidenceReference: text(
      "admin_resolution_evidence_reference",
    ),
    adminResolutionRationale: text("admin_resolution_rationale"),
    resolvedByAdminUserId: uuid("resolved_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    resolutionStepUpAuthenticatedAt: timestamp(
      "resolution_step_up_authenticated_at",
      { withTimezone: true },
    ),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedStateVersion: integer("resolved_state_version"),
    stateVersion: integer("state_version").notNull().default(1),
    rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    redactionDueAt: timestamp("redaction_due_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("product_shipment_returns_shipment_idx").on(
      table.shipmentId,
      table.observedAt,
    ),
    index("product_shipment_returns_unmatched_idx")
      .on(table.matchStatus, table.observedAt)
      .where(sql`${table.shipmentId} IS NULL`),
    check(
      "product_shipment_returns_match_status_check",
      sql`${table.matchStatus} IN ('unmatched', 'matched', 'manual_review')`,
    ),
    check(
      "product_shipment_returns_state_version_check",
      sql`${table.stateVersion} >= 1`,
    ),
    check(
      "product_shipment_returns_admin_resolution_check",
      sql`(
        ${table.adminResolutionAction} IS NULL
        AND ${table.adminResolutionEvidenceReference} IS NULL
        AND ${table.adminResolutionRationale} IS NULL
        AND ${table.resolvedByAdminUserId} IS NULL
        AND ${table.resolutionStepUpAuthenticatedAt} IS NULL
        AND ${table.resolvedAt} IS NULL
        AND ${table.resolvedStateVersion} IS NULL
      ) OR (
        ${table.adminResolutionAction} IS NOT NULL
        AND ${table.adminResolutionEvidenceReference} IS NOT NULL
        AND ${table.adminResolutionRationale} IS NOT NULL
        AND ${table.resolvedByAdminUserId} IS NOT NULL
        AND ${table.resolutionStepUpAuthenticatedAt} IS NOT NULL
        AND ${table.resolvedAt} IS NOT NULL
        AND ${table.resolvedStateVersion} IS NOT NULL
        AND ${table.adminResolutionAction} IN ('record_inspection', 'escalate_unmatched_return', 'confirm_linked_case')
        AND length(trim(${table.adminResolutionEvidenceReference})) >= 6
        AND length(trim(${table.adminResolutionRationale})) >= 10
        AND ${table.resolutionStepUpAuthenticatedAt} <= ${table.resolvedAt}
        AND ${table.resolutionStepUpAuthenticatedAt} >= ${table.resolvedAt} - interval '5 minutes'
        AND ${table.resolvedStateVersion} >= 2
        AND ${table.resolvedStateVersion} <= ${table.stateVersion}
      )`,
    ),
  ],
);

export const productReplacementInventoryAttestations = pgTable(
  "product_replacement_inventory_attestations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => productShippingCases.id, { onDelete: "restrict" }),
    productId: text("product_id").notNull(),
    variantId: text("variant_id"),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    attestedByAdminUserId: uuid("attested_by_admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("product_replacement_inventory_line_idx").on(
      table.caseId,
      table.productId,
      sql`coalesce(${table.variantId}, '')`,
      table.sku,
    ),
    check(
      "product_replacement_inventory_quantity_check",
      sql`${table.quantity} > 0`,
    ),
  ],
);

export const customerEmailOutbox = pgTable(
  "customer_email_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => checkoutOrders.id, {
      onDelete: "restrict",
    }),
    kind: text("kind").notNull(),
    recipientCiphertext: text("recipient_ciphertext").notNull(),
    templateDataCiphertext: text("template_data_ciphertext").notNull(),
    providerIdempotencyKey: text("provider_idempotency_key").notNull().unique(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    redactionDueAt: timestamp("redaction_due_at", {
      withTimezone: true,
    }).notNull(),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customer_email_outbox_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "customer_email_outbox_status_check",
      sql`${table.status} IN ('queued', 'sending', 'failed', 'dead_letter', 'sent')`,
    ),
    check(
      "customer_email_outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "customer_email_outbox_active_customer_order_link_check",
      sql`${table.kind} = 'shipping_policy_alert' OR ${table.orderId} IS NOT NULL OR ${table.redactedAt} IS NOT NULL`,
    ),
  ],
);

export const fulfillmentRiskAlertOutbox = pgTable(
  "fulfillment_risk_alert_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => productPaymentRiskIncidents.id, {
        onDelete: "restrict",
      }),
    incidentKey: text("incident_key").notNull(),
    recipientDuty: shippingPolicyDuty("recipient_duty")
      .notNull()
      .default("payment_fraud_owner"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    redactionDueAt: timestamp("redaction_due_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '365 days'`),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("fulfillment_risk_alert_outbox_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "fulfillment_risk_alert_outbox_status_check",
      sql`${table.status} IN ('queued', 'sending', 'sent', 'dead_letter')`,
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
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("square"),
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

export const squarePaymentRefundEvents = pgTable(
  "square_payment_refund_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    providerEventId: text("provider_event_id").notNull(),
    squareRefundId: text("square_refund_id").notNull(),
    squarePaymentId: text("square_payment_id").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    payloadSanitized:
      jsonb("payload_sanitized").$type<SquarePaymentRefundPayload>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("square_payment_refund_events_provider_event_idx").on(
      table.providerEventId,
    ),
    index("square_payment_refund_events_refund_occurred_idx").on(
      table.squareRefundId,
      table.occurredAt,
    ),
    index("square_payment_refund_events_payment_status_occurred_idx").on(
      table.squarePaymentId,
      table.status,
      table.occurredAt,
    ),
    check(
      "square_payment_refund_events_amount_check",
      sql`${table.amountCents} >= 0`,
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
    bookingModelVersion: integer("booking_model_version").notNull().default(1),
    serviceOfferingId: uuid("service_offering_id").references(
      () => bookingServiceOfferings.id,
      { onDelete: "set null" },
    ),
    providerId: uuid("provider_id").references(() => bookingProviders.id, {
      onDelete: "set null",
    }),
    primaryResourceId: uuid("primary_resource_id").references(
      () => bookingResources.id,
      { onDelete: "set null" },
    ),
    offeringSnapshot: jsonb("offering_snapshot")
      .$type<AppointmentHoldOfferingSnapshot>()
      .notNull(),
    providerSnapshot:
      jsonb("provider_snapshot").$type<AppointmentHoldProviderSnapshot>(),
    squareTeamMemberId: text("square_team_member_id"),
    configurationVersion: integer("configuration_version"),
    bookingType: text("booking_type").notNull(),
    customerSnapshot: jsonb("customer_snapshot")
      .$type<AppointmentHoldCustomerSnapshot>()
      .notNull(),
    selectedStart: timestamp("selected_start", {
      withTimezone: true,
    }).notNull(),
    selectedEnd: timestamp("selected_end", { withTimezone: true }).notNull(),
    occupiedStart: timestamp("occupied_start", { withTimezone: true }),
    occupiedEnd: timestamp("occupied_end", { withTimezone: true }),
    timezone: text("timezone").notNull(),
    status: appointmentHoldStatus("status").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    captureLeaseId: uuid("capture_lease_id"),
    captureLeaseExpiresAt: timestamp("capture_lease_expires_at", {
      withTimezone: true,
    }),
    paymentProvider: paymentProvider("payment_provider")
      .notNull()
      .default("square"),
    squarePaymentLinkId: text("square_payment_link_id"),
    squarePaymentLinkUrl: text("square_payment_link_url"),
    squareCheckoutId: text("square_checkout_id"),
    squarePaymentId: text("square_payment_id"),
    squareOrderId: text("square_order_id"),
    googleEventId: text("google_event_id"),
    calendarAssignmentId: uuid("calendar_assignment_id").references(
      () => bookingResourceCalendarAssignments.id,
      { onDelete: "set null" },
    ),
    googleCalendarId: text("google_calendar_id"),
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
    providerBookingEmailSentAt: timestamp("provider_booking_email_sent_at", {
      withTimezone: true,
    }),
    providerBookingEmailClaimedUntil: timestamp(
      "provider_booking_email_claimed_until",
      { withTimezone: true },
    ),
    providerBookingEmailLastError: text("provider_booking_email_last_error"),
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
    index("appointment_holds_resource_conflict_idx").on(
      table.primaryResourceId,
      table.occupiedStart,
      table.occupiedEnd,
      table.status,
      table.expiresAt,
    ),
    index("appointment_holds_capture_lease_idx").on(
      table.captureLeaseExpiresAt,
    ),
    index("appointment_holds_service_offering_idx").on(
      table.serviceOfferingId,
      table.selectedStart,
    ),
    index("appointment_holds_square_cof_checkout_order_id_idx")
      .on(table.checkoutOrderId, table.id)
      .where(
        sql`${table.paymentProvider} = 'square' AND ${table.cardOnFileStatus} IS NOT NULL AND ${table.squarePaymentLinkId} IS NULL`,
      ),
    check(
      "appointment_holds_booking_model_version_check",
      sql`${table.bookingModelVersion} IN (1, 2)`,
    ),
    check(
      "appointment_holds_booking_model_v2_check",
      sql`${table.bookingModelVersion} = 1 OR (${table.serviceOfferingId} IS NOT NULL AND ${table.providerId} IS NOT NULL AND ${table.primaryResourceId} IS NOT NULL AND ${table.providerSnapshot} IS NOT NULL AND ${table.occupiedStart} IS NOT NULL AND ${table.occupiedEnd} IS NOT NULL AND ${table.occupiedEnd} > ${table.occupiedStart} AND ${table.calendarAssignmentId} IS NOT NULL AND ${table.googleCalendarId} IS NOT NULL)`,
    ),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicReference: text("public_reference").notNull(),
    sourceHoldId: uuid("source_hold_id").references(() => appointmentHolds.id, {
      onDelete: "set null",
    }),
    sourceHoldPublicReference: text("source_hold_public_reference"),
    checkoutOrderId: uuid("checkout_order_id").references(
      () => checkoutOrders.id,
      { onDelete: "set null" },
    ),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => bookingServiceOfferings.id, { onDelete: "restrict" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => bookingProviders.id, { onDelete: "restrict" }),
    primaryResourceId: uuid("primary_resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    offeringSnapshot: jsonb("offering_snapshot")
      .$type<BookingServiceOfferingSnapshot>()
      .notNull(),
    providerSnapshot: jsonb("provider_snapshot")
      .$type<BookingProviderSnapshot>()
      .notNull(),
    squareTeamMemberId: text("square_team_member_id"),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerEmailNormalized: text("customer_email_normalized").notNull(),
    customerPhone: text("customer_phone"),
    intakeSnapshot: jsonb("intake_snapshot").$type<AppointmentIntakeSnapshot>(),
    selectedStart: timestamp("selected_start", {
      withTimezone: true,
    }).notNull(),
    selectedEnd: timestamp("selected_end", { withTimezone: true }).notNull(),
    occupiedStart: timestamp("occupied_start", {
      withTimezone: true,
    }).notNull(),
    occupiedEnd: timestamp("occupied_end", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    status: appointmentStatus("status").notNull().default("confirmed"),
    origin: appointmentOrigin("origin").notNull().default("online"),
    paymentStatus: appointmentPaymentStatus("payment_status")
      .notNull()
      .default("pending"),
    calendarSyncStatus: appointmentCalendarSyncStatus("calendar_sync_status")
      .notNull()
      .default("pending"),
    calendarSyncLastErrorCode: text("calendar_sync_last_error_code"),
    cancellationReason: text("cancellation_reason"),
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
    version: integer("version").notNull().default(1),
    createdByAdminUserId: uuid("created_by_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("appointments_public_reference_idx").on(table.publicReference),
    uniqueIndex("appointments_source_hold_idx").on(table.sourceHoldId),
    index("appointments_provider_start_idx").on(
      table.providerId,
      table.selectedStart,
    ),
    index("appointments_resource_start_idx").on(
      table.primaryResourceId,
      table.selectedStart,
    ),
    index("appointments_status_start_idx").on(
      table.status,
      table.selectedStart,
    ),
    index("appointments_customer_email_idx").on(
      table.customerEmailNormalized,
      table.createdAt,
    ),
    index("appointments_checkout_order_idx").on(table.checkoutOrderId),
    check(
      "appointments_selected_range_check",
      sql`${table.selectedEnd} > ${table.selectedStart}`,
    ),
    check(
      "appointments_occupied_range_check",
      sql`${table.occupiedEnd} > ${table.occupiedStart} AND ${table.occupiedStart} <= ${table.selectedStart} AND ${table.occupiedEnd} >= ${table.selectedEnd}`,
    ),
  ],
);

export const appointmentCalendarEvents = pgTable(
  "appointment_calendar_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    calendarAssignmentId: uuid("calendar_assignment_id")
      .notNull()
      .references(() => bookingResourceCalendarAssignments.id, {
        onDelete: "restrict",
      }),
    providerCalendarId: text("provider_calendar_id").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    providerEventEtag: text("provider_event_etag"),
    syncStatus: appointmentCalendarSyncStatus("sync_status")
      .notNull()
      .default("pending"),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("appointment_calendar_events_assignment_event_idx").on(
      table.calendarAssignmentId,
      table.providerEventId,
    ),
    uniqueIndex("appointment_calendar_events_active_appointment_idx")
      .on(table.appointmentId, table.calendarAssignmentId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("appointment_calendar_events_sync_status_idx").on(
      table.syncStatus,
      table.lastAttemptedAt,
    ),
  ],
);

export const appointmentEvents = pgTable(
  "appointment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    source: text("source").notNull(),
    actorAdminUserId: uuid("actor_admin_user_id").references(
      () => adminUsers.id,
      { onDelete: "set null" },
    ),
    previousStatus: appointmentStatus("previous_status"),
    nextStatus: appointmentStatus("next_status"),
    reason: text("reason"),
    metadata: jsonb("metadata").$type<AppointmentEventMetadata>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("appointment_events_appointment_created_idx").on(
      table.appointmentId,
      table.createdAt,
    ),
    index("appointment_events_type_created_idx").on(
      table.eventType,
      table.createdAt,
    ),
  ],
);

export const bookingResourceReservations = pgTable(
  "booking_resource_reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => bookingResources.id, { onDelete: "restrict" }),
    holdId: uuid("hold_id").references(() => appointmentHolds.id, {
      onDelete: "cascade",
    }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "cascade",
    }),
    scheduleExceptionId: uuid("schedule_exception_id").references(
      () => bookingResourceScheduleExceptions.id,
      { onDelete: "cascade" },
    ),
    kind: bookingReservationKind("kind").notNull(),
    state: bookingReservationState("state").notNull().default("active"),
    occupiedStart: timestamp("occupied_start", {
      withTimezone: true,
    }).notNull(),
    occupiedEnd: timestamp("occupied_end", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_resource_reservations_hold_idx").on(
      table.resourceId,
      table.holdId,
    ),
    uniqueIndex("booking_resource_reservations_appointment_idx").on(
      table.resourceId,
      table.appointmentId,
    ),
    uniqueIndex("booking_resource_reservations_exception_idx").on(
      table.resourceId,
      table.scheduleExceptionId,
    ),
    index("booking_resource_reservations_active_lookup_idx").on(
      table.resourceId,
      table.state,
      table.occupiedStart,
      table.occupiedEnd,
    ),
    index("booking_resource_reservations_expiry_idx").on(
      table.state,
      table.expiresAt,
    ),
    check(
      "booking_resource_reservations_parent_check",
      sql`num_nonnulls(${table.holdId}, ${table.appointmentId}, ${table.scheduleExceptionId}) = 1`,
    ),
    check(
      "booking_resource_reservations_kind_check",
      sql`(${table.kind} = 'hold' AND ${table.holdId} IS NOT NULL AND ${table.expiresAt} IS NOT NULL) OR (${table.kind} = 'appointment' AND ${table.appointmentId} IS NOT NULL) OR (${table.kind} = 'block' AND ${table.scheduleExceptionId} IS NOT NULL)`,
    ),
    check(
      "booking_resource_reservations_range_check",
      sql`${table.occupiedEnd} > ${table.occupiedStart}`,
    ),
  ],
);

export const bookingPaymentAttempts = pgTable(
  "booking_payment_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    holdId: uuid("hold_id").references(() => appointmentHolds.id, {
      onDelete: "set null",
    }),
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
    }),
    checkoutOrderId: uuid("checkout_order_id").references(
      () => checkoutOrders.id,
      { onDelete: "set null" },
    ),
    operation: text("operation").notNull(),
    status: bookingPaymentAttemptStatus("status").notNull().default("pending"),
    paymentProvider: paymentProvider("payment_provider").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerPaymentId: text("provider_payment_id"),
    providerOrderId: text("provider_order_id"),
    squareTeamMemberId: text("square_team_member_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    failureCode: text("failure_code"),
    providerMetadata:
      jsonb("provider_metadata").$type<BookingPaymentAttemptMetadata>(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("booking_payment_attempts_idempotency_idx").on(
      table.idempotencyKey,
    ),
    uniqueIndex("booking_payment_attempts_provider_payment_idx").on(
      table.paymentProvider,
      table.providerPaymentId,
    ),
    index("booking_payment_attempts_hold_created_idx").on(
      table.holdId,
      table.createdAt,
    ),
    index("booking_payment_attempts_appointment_created_idx").on(
      table.appointmentId,
      table.createdAt,
    ),
    index("booking_payment_attempts_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    check(
      "booking_payment_attempts_amount_check",
      sql`${table.amountCents} >= 0`,
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

export interface MarketingContactSyncJobPayload {
  consentText?: string;
  consentedAt: string;
  email: string;
  instagram?: string;
  name?: string;
  phone?: string;
  source: string;
  sourcePath?: string;
  contactId?: string;
  submissionId?: string;
  consentEventId?: string;
}

export const marketingContactSyncJobs = pgTable(
  "marketing_contact_sync_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    contactId: uuid("contact_id").references(() => marketingContacts.id, {
      onDelete: "set null",
    }),
    submissionId: uuid("submission_id").references(
      () => marketingContactSubmissions.id,
      { onDelete: "set null" },
    ),
    consentEventId: uuid("consent_event_id").references(
      () => marketingConsentEvents.id,
      { onDelete: "set null" },
    ),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    source: text("source").notNull(),
    payload: jsonb("payload").$type<MarketingContactSyncJobPayload>().notNull(),
    status: marketingContactSyncJobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextRunAt: timestamp("next_run_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorContext:
      jsonb("last_error_context").$type<Record<string, unknown>>(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("marketing_contact_sync_jobs_status_next_run_at_idx").on(
      table.status,
      table.nextRunAt,
    ),
    index("marketing_contact_sync_jobs_email_normalized_idx").on(
      table.emailNormalized,
    ),
    index("marketing_contact_sync_jobs_created_at_idx").on(table.createdAt),
    uniqueIndex("marketing_contact_sync_jobs_submission_id_idx").on(
      table.submissionId,
    ),
    uniqueIndex("marketing_contact_sync_jobs_consent_event_id_idx").on(
      table.consentEventId,
    ),
  ],
);

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
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
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
    uniqueIndex("booking_policy_acceptances_appointment_id_idx").on(
      table.appointmentId,
    ),
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
    appointmentId: uuid("appointment_id").references(() => appointments.id, {
      onDelete: "set null",
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
    uniqueIndex("booking_no_show_charge_records_appointment_id_idx").on(
      table.appointmentId,
    ),
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

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
    uniqueIndex("booking_services_service_key_idx").on(table.serviceKey),
    uniqueIndex("booking_services_sanity_document_idx").on(
      table.sanityDocumentId,
    ),
    uniqueIndex("booking_services_public_slug_idx").on(table.publicSlug),
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
    index("checkout_orders_paid_square_appointment_not_booked_idx")
      .using("btree", table.paidAt, table.id, table.orderId)
      .where(
        sql`${table.status} = 'paid' AND ${table.paymentProvider} = 'square' AND ${table.purpose} IN ('appointment_deposit', 'appointment_full', 'appointment_custom_partial') AND ${table.calendarFinalizationStatus} NOT IN ('not_required', 'booked', 'manual_rebooked')`,
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

import {
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

export const trainingEnrollmentPurchaseKind = pgEnum("training_enrollment_purchase_kind", [
  "full",
]);

export const trainingEnrollmentSchedulingStatus = pgEnum("training_enrollment_scheduling_status", [
  "pending",
  "scheduled",
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
  totalCents: number;
}

export type CheckoutOrderStatus = typeof checkoutOrderStatus.enumValues[number];

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

export type TrainingEnrollmentPurchaseKind = typeof trainingEnrollmentPurchaseKind.enumValues[number];
export type TrainingEnrollmentSchedulingStatus = typeof trainingEnrollmentSchedulingStatus.enumValues[number];

export const checkoutOrders = pgTable(
  "checkout_orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: text("order_id").notNull().unique(),
    status: checkoutOrderStatus("status").notNull().default("pending"),
    checkoutTokenHash: text("checkout_token_hash").notNull().unique(),
    secretTokenCiphertext: text("secret_token_ciphertext").notNull(),
    helcimInvoiceId: integer("helcim_invoice_id").notNull(),
    helcimInvoiceNumber: text("helcim_invoice_number").notNull(),
    helcimTransactionId: text("helcim_transaction_id"),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("CAD"),
    lineItems: jsonb("line_items").$type<CheckoutOrderLineItemSnapshot[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("checkout_orders_checkout_token_hash_idx").on(table.checkoutTokenHash),
  ],
);

export const checkoutPaymentEvents = pgTable(
  "checkout_payment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => checkoutOrders.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    helcimTransactionId: text("helcim_transaction_id"),
    status: text("status"),
    amountCents: integer("amount_cents"),
    currency: text("currency"),
    message: text("message"),
    idempotencyKey: text("idempotency_key").unique(),
    payloadRedacted: jsonb("payload_redacted").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("checkout_payment_events_idempotency_key_idx").on(table.idempotencyKey),
  ],
);

export const trainingEnrollments = pgTable(
  "training_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    checkoutOrderId: uuid("checkout_order_id")
      .notNull()
      .references(() => checkoutOrders.id, { onDelete: "cascade" }),
    programSnapshot: jsonb("program_snapshot").$type<TrainingEnrollmentProgramSnapshot>().notNull(),
    productSnapshot: jsonb("product_snapshot").$type<TrainingEnrollmentProductSnapshot>().notNull(),
    checkoutEmail: text("checkout_email").notNull(),
    purchaseKind: trainingEnrollmentPurchaseKind("purchase_kind").notNull().default("full"),
    schedulingStatus: trainingEnrollmentSchedulingStatus("scheduling_status").notNull().default("pending"),
    schedulingTokenHash: text("scheduling_token_hash").unique(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    tokenUsedAt: timestamp("token_used_at", { withTimezone: true }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    staffAlertedAt: timestamp("staff_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("training_enrollments_checkout_order_id_idx").on(table.checkoutOrderId),
    uniqueIndex("training_enrollments_scheduling_token_hash_idx").on(table.schedulingTokenHash),
  ],
);

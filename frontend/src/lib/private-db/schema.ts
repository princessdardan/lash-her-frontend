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

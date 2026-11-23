import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { customerUsers } from "@/lib/customer-auth/schema";

export type CourseBilling = {
  name: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

export const coursePurchaseOrders = pgTable(
  "course_purchase_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customerUsers.id),
    courseId: uuid("course_id").notNull(),
    courseRevision: integer("course_revision").notNull(),
    courseSlug: text("course_slug").notNull(),
    courseTitle: text("course_title").notNull(),
    taxClassification: text("tax_classification").notNull(),
    email: text("email").notNull(),
    billing: jsonb("billing").$type<CourseBilling>().notNull(),
    policyHash: text("policy_hash").notNull(),
    policyVersion: text("policy_version").notNull(),
    disclosure: text("disclosure").notNull(),
    taxCode: text("tax_code").notNull(),
    taxBehavior: text("tax_behavior", {
      enum: ["inclusive", "exclusive"],
    }).notNull(),
    taxBreakdown: jsonb("tax_breakdown").$type<unknown[]>().notNull(),
    priceCents: integer("price_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    taxCalculation: text("tax_calculation").notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", {
      withTimezone: true,
    }).notNull(),
    squareLocationId: text("square_location_id").notNull(),
    status: text("status", {
      enum: ["quoted", "charging", "paid", "failed", "refunded"],
    })
      .notNull()
      .default("quoted"),
    access: text("access", {
      enum: ["none", "pending", "active", "revocation_pending", "revoked"],
    })
      .notNull()
      .default("none"),
    sourceFingerprint: text("source_fingerprint"),
    squarePaymentId: text("square_payment_id"),
    chargedAt: timestamp("charged_at", { withTimezone: true }),
    refundedCents: integer("refunded_cents").notNull().default(0),
    disputeBlocked: boolean("dispute_blocked").notNull().default(false),
    disputeStartedAt: timestamp("dispute_started_at", { withTimezone: true }),
    accessGeneration: integer("access_generation").notNull().default(0),
    taxTransactionId: text("tax_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("course_purchase_live_customer_course")
      .on(table.customerId, table.courseId)
      .where(sql`${table.status} in ('charging', 'paid')`),
    uniqueIndex("course_purchase_square_payment").on(table.squarePaymentId),
    check(
      "course_purchase_order_status",
      sql`${table.status} in ('quoted','charging','paid','failed','refunded')`,
    ),
    check(
      "course_purchase_access_status",
      sql`${table.access} in ('none','pending','active','revocation_pending','revoked')`,
    ),
    check(
      "course_purchase_amounts",
      sql`${table.priceCents} > 0 and ${table.taxCents} >= 0 and
    ((${table.taxBehavior} = 'exclusive' and ${table.totalCents}::bigint = ${table.priceCents}::bigint + ${table.taxCents}) or
      (${table.taxBehavior} = 'inclusive' and ${table.totalCents} = ${table.priceCents} and ${table.taxCents} <= ${table.priceCents}))
    and ${table.refundedCents} between 0 and ${table.totalCents}`,
    ),
  ],
);

export const coursePurchaseRefunds = pgTable(
  "course_purchase_refunds",
  {
    id: text("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => coursePurchaseOrders.id),
    amountCents: integer("amount_cents").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("course_purchase_refund_order").on(table.orderId),
    check("course_purchase_refund_amount", sql`${table.amountCents} > 0`),
  ],
);

export const coursePurchaseJobs = pgTable(
  "course_purchase_jobs",
  {
    id: text("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => coursePurchaseOrders.id),
    refundId: text("refund_id").references(() => coursePurchaseRefunds.id),
    accessGeneration: integer("access_generation").notNull().default(0),
    revokeReason: text("revoke_reason", { enum: ["refund", "dispute"] }),
    kind: text("kind", {
      enum: ["grant", "revoke", "tax_sale", "tax_refund", "receipt"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "processing", "done", "dead", "canceled"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lease: uuid("lease"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastFailure: text("last_failure"),
    destinationReceipt: text("destination_receipt"),
  },
  (table) => [
    index("course_purchase_jobs_ready").on(table.status, table.availableAt),
    index("course_purchase_jobs_order").on(table.orderId, table.createdAt),
    check(
      "course_purchase_job_kind",
      sql`${table.kind} in ('grant','revoke','tax_sale','tax_refund','receipt')`,
    ),
    check(
      "course_purchase_job_status",
      sql`${table.status} in ('pending','processing','done','dead','canceled')`,
    ),
    check(
      "course_purchase_job_revoke_reason",
      sql`${table.revokeReason} is null or
        (${table.kind} = 'revoke' and ${table.revokeReason} in ('refund', 'dispute'))`,
    ),
    check(
      "course_purchase_job_lease",
      sql`(${table.status} = 'processing' and ${table.lease} is not null and ${table.leaseUntil} is not null) or
    (${table.status} <> 'processing' and ${table.lease} is null and ${table.leaseUntil} is null)`,
    ),
  ],
);

export const coursePurchaseDisputes = pgTable(
  "course_purchase_disputes",
  {
    id: text("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => coursePurchaseOrders.id),
    amountCents: integer("amount_cents").notNull(),
    state: text("state").notNull(),
    version: integer("version"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("course_purchase_disputes_order").on(table.orderId),
    check("course_purchase_dispute_amount", sql`${table.amountCents} > 0`),
  ],
);

export const coursePurchaseJobReplays = pgTable("course_purchase_job_replays", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: text("job_id")
    .notNull()
    .references(() => coursePurchaseJobs.id),
  adminId: uuid("admin_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

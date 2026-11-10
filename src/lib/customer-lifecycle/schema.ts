import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { customerUsers } from "@/lib/customer-auth/schema";
import type { AccountCommand } from "./policy";

export const customerAccountCommands = pgTable("customer_account_commands", {
  commandId: uuid("command_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => customerUsers.id),
  accountVersion: bigint("account_version", { mode: "number" }).notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  action: text("action").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  command: jsonb("command").$type<AccountCommand>().notNull(),
  requestedByAdminId: uuid("requested_by_admin_id"),
}, table => [uniqueIndex("customer_account_commands_version_idx").on(table.userId, table.accountVersion),
  uniqueIndex("customer_account_commands_idempotency_idx").on(table.userId, table.idempotencyKey),
  check("customer_account_commands_action", sql`${table.action} IN ('suspend', 'restore', 'export', 'delete')`),
  check("customer_account_commands_version", sql`${table.accountVersion} BETWEEN 1 AND 9007199254740991`)]);

export const customerAccountDeliveries = pgTable("customer_account_deliveries", {
  commandId: uuid("command_id").notNull().references(() => customerAccountCommands.commandId),
  receiver: text("receiver").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseId: uuid("lease_id"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  lastError: text("last_error"),
}, table => [uniqueIndex("customer_account_deliveries_identity_idx").on(table.commandId, table.receiver),
  index("customer_account_deliveries_due_idx").on(table.status, table.nextRunAt),
  check("customer_account_deliveries_receiver", sql`${table.receiver} IN ('course', 'community')`),
  check("customer_account_deliveries_status", sql`${table.status} IN ('pending', 'delivering', 'acknowledged', 'blocked')`)]);

export const customerAccountExports = pgTable("customer_account_exports", {
  commandId: uuid("command_id").primaryKey().references(() => customerAccountCommands.commandId),
  userId: uuid("user_id").notNull().references(() => customerUsers.id),
  status: text("status").notNull().default("pending"),
  frontendData: jsonb("frontend_data").$type<Record<string, unknown>>(),
  data: jsonb("data").$type<Record<string, unknown>>(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, table => [index("customer_account_exports_expiry_idx").on(table.expiresAt),
  check("customer_account_exports_status", sql`${table.status} IN ('pending', 'ready', 'expired', 'failed')`)]);

export const customerAccountPreferences = pgTable("customer_account_preferences", {
  userId: uuid("user_id").primaryKey().references(() => customerUsers.id),
  learningUpdates: boolean("learning_updates").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

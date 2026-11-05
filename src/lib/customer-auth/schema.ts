import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const customerUsers = pgTable("customer_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  name: text("name"),
  status: text("status").notNull().default("active"),
  accountVersion: bigint("account_version", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("customer_users_email_idx").on(table.email),
  check("customer_users_email_normalized", sql`${table.email} = lower(trim(${table.email}))`),
  check("customer_users_status", sql`${table.status} IN ('active', 'suspended', 'deleted')`),
  check("customer_users_account_version", sql`${table.accountVersion} BETWEEN 0 AND 9007199254740991`)]);

// Authentication needs provider identity only. Provider access/refresh/ID tokens
// are deliberately discarded rather than retained as account credentials.
export const customerProviderLinks = pgTable("customer_provider_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => customerUsers.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("customer_provider_links_identity_idx").on(table.provider, table.providerAccountId),
  uniqueIndex("customer_provider_links_user_provider_idx").on(table.userId, table.provider),
  check("customer_provider_links_provider", sql`${table.provider} = 'google' AND ${table.type} = 'oidc'`)]);

export const customerSessions = pgTable("customer_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => customerUsers.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("customer_sessions_user_idx").on(table.userId), index("customer_sessions_expiry_idx").on(table.expires)]);

export const customerVerificationTokens = pgTable("customer_verification_tokens", {
  token: text("token").primaryKey(),
  identifier: text("identifier").notNull(),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
}, table => [index("customer_verification_tokens_expiry_idx").on(table.expires)]);

export const customerAuthThrottle = pgTable("customer_auth_throttle", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
}, table => [index("customer_auth_throttle_expiry_idx").on(table.resetsAt)]);

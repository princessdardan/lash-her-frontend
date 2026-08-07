import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("../../../drizzle/0032_sloppy_rocket_raccoon.sql", import.meta.url),
  "utf8",
);

test("course integration migration is append-only", () => {
  assert.doesNotMatch(migrationSql, /\bDROP\s+(?:TABLE|TYPE|COLUMN)\b/i);
  assert.doesNotMatch(migrationSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migrationSql, /\bDELETE\s+FROM\b/i);

  assert.match(
    migrationSql,
    /ALTER TYPE "public"\."checkout_order_purpose" ADD VALUE 'course'/,
  );

  for (const table of [
    "customer_users",
    "customer_provider_accounts",
    "customer_verified_emails",
    "course_order_items",
    "guest_order_claims",
    "course_refund_allocations",
    "entitlement_outbox",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE TABLE "${table}"`));
  }
});

test("course integration migration retains immutable lineage", () => {
  for (const foreignKey of [
    "course_order_items_checkout_order_id_checkout_orders_id_fk",
    "course_order_items_customer_user_id_customer_users_id_fk",
    "guest_order_claims_checkout_order_id_checkout_orders_id_fk",
    "guest_order_claims_customer_user_id_customer_users_id_fk",
    "guest_order_claims_verified_email_customer_fk",
    "entitlement_outbox_course_order_item_id_course_order_items_id_fk",
    "entitlement_outbox_cancelled_by_admin_user_id_admin_users_id_fk",
    "course_refund_allocations_checkout_payment_event_id_checkout_payment_events_id_fk",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`CONSTRAINT "${foreignKey}"[^;]+ON DELETE restrict`),
    );
  }

  assert.doesNotMatch(migrationSql, /square_payment_refund_event_id/);
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX "customer_verified_emails_id_customer_idx"[^;]+\("id","customer_user_id"\)/,
  );
  assert.ok(
    migrationSql.indexOf(
      'CREATE UNIQUE INDEX "customer_verified_emails_id_customer_idx"',
    ) <
      migrationSql.indexOf(
        'ADD CONSTRAINT "guest_order_claims_verified_email_customer_fk"',
      ),
    "the referenced composite unique key must exist before PostgreSQL creates the foreign key",
  );
});

test("course integration migration emits lifecycle checks and worker indexes", () => {
  for (const constraint of [
    "course_order_items_ownership_check",
    "course_order_items_amount_check",
    "course_order_items_currency_check",
    "course_refund_allocations_provider_check",
    "course_refund_allocations_amount_check",
    "course_refund_allocations_currency_check",
    "entitlement_outbox_sequence_check",
    "entitlement_outbox_attempts_check",
    "entitlement_outbox_lease_check",
    "entitlement_outbox_completion_check",
    "entitlement_outbox_cancellation_check",
  ]) {
    assert.match(migrationSql, new RegExp(`CONSTRAINT "${constraint}" CHECK`));
  }

  for (const index of [
    "checkout_orders_customer_created_idx",
    "course_order_items_customer_financial_idx",
    "course_order_items_course_financial_idx",
    "entitlement_outbox_due_idx",
    "entitlement_outbox_lease_idx",
    "entitlement_outbox_history_idx",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE INDEX "${index}"`));
  }
});

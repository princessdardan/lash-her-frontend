import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migrationSql = readFileSync(
  new URL("../../../drizzle/0018_grey_xorn.sql", import.meta.url),
  "utf8",
);
const guardrailMigrationSql = readFileSync(
  new URL("../../../drizzle/0019_rainy_lorna_dane.sql", import.meta.url),
  "utf8",
);
const modelVersionMigrationSql = readFileSync(
  new URL("../../../drizzle/0020_eager_stark_industries.sql", import.meta.url),
  "utf8",
);
const lineageReconciliationMigrationSql = readFileSync(
  new URL(
    "../../../drizzle/0024_private_db_lineage_reconciliation.sql",
    import.meta.url,
  ),
  "utf8",
);

test("booking operations migration is additive", () => {
  const currentSchemaMigrationSql = migrationSql.slice(
    migrationSql.indexOf('CREATE EXTENSION IF NOT EXISTS "btree_gist"'),
  );
  assert.doesNotMatch(
    currentSchemaMigrationSql,
    /DROP\s+(?:TABLE|COLUMN|TYPE)/i,
  );

  for (const table of [
    "admin_users",
    "admin_user_resources",
    "admin_audit_logs",
    "booking_resources",
    "booking_providers",
    "booking_services",
    "booking_service_offerings",
    "booking_resource_schedules",
    "booking_resource_schedule_exceptions",
    "booking_calendar_connections",
    "booking_resource_calendar_assignments",
    "appointments",
    "appointment_calendar_events",
    "appointment_events",
    "booking_payment_attempts",
    "booking_resource_reservations",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE TABLE "${table}"`));
  }
});

test("booking operations migration safely reconciles only the empty legacy admin lineage", () => {
  assert.match(
    migrationSql,
    /legacy_admin_roles <> ARRAY\['owner', 'operator'\]::text\[\]/,
  );
  assert.match(
    migrationSql,
    /Legacy admin\/privacy tables contain data; migration 0018 requires a data-preserving migration plan/,
  );
  assert.match(
    migrationSql,
    /EXISTS \(SELECT 1 FROM public\.admin_users LIMIT 1\)/,
  );
  assert.match(
    migrationSql,
    /EXISTS \(SELECT 1 FROM public\.admin_audit_logs LIMIT 1\)/,
  );
  assert.match(
    migrationSql,
    /EXISTS \(SELECT 1 FROM public\.privacy_requests LIMIT 1\)/,
  );
  assert.match(
    migrationSql,
    /EXISTS \(SELECT 1 FROM public\.privacy_request_events LIMIT 1\)/,
  );
  assert.doesNotMatch(migrationSql, /DROP\s+(?:TABLE|TYPE)[^;]+CASCADE/i);
});

test("booking operations migration enforces resource-scoped occupancy", () => {
  assert.match(migrationSql, /CREATE EXTENSION IF NOT EXISTS "btree_gist"/);
  assert.match(
    migrationSql,
    /ADD CONSTRAINT "booking_resource_reservations_no_active_overlap" EXCLUDE USING gist/,
  );
  assert.match(
    migrationSql,
    /tstzrange\("occupied_start", "occupied_end", '\[\)'\) WITH &&/,
  );
  assert.match(migrationSql, /WHERE \("state" = 'active'\)/);
});

test("booking operations migration keeps V1 holds valid", () => {
  assert.match(
    migrationSql,
    /ADD COLUMN "booking_model_version" integer DEFAULT 1 NOT NULL/,
  );
  assert.match(
    migrationSql,
    /ADD CONSTRAINT "appointment_holds_booking_model_v2_check" CHECK .* NOT VALID/,
  );
  assert.doesNotMatch(migrationSql, /ALTER COLUMN "offering_id" (?:DROP|SET)/);
});

test("booking operations migration permits one active write calendar per resource", () => {
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX "booking_resource_calendar_assignments_write_idx" ON "booking_resource_calendar_assignments" USING btree \("resource_id"\) WHERE .*"status" = 'active' AND .*"accepts_bookings" = true/,
  );
});

test("booking operations migration never stores a plaintext refresh token", () => {
  assert.match(migrationSql, /"credential_ciphertext" text/);
  assert.match(migrationSql, /"credential_secret_ref" text/);
  assert.doesNotMatch(migrationSql, /"refresh_token"/);
});

test("booking operations guardrails reject unusable assignments and negative add-on duration", () => {
  assert.doesNotMatch(guardrailMigrationSql, /DROP\s+(?:TABLE|COLUMN|TYPE)/i);
  assert.match(
    guardrailMigrationSql,
    /booking_resource_calendar_assignments_has_role_check[\s\S]*contributes_busy[\s\S]*accepts_bookings/,
  );
  assert.match(
    guardrailMigrationSql,
    /booking_service_offering_add_ons_duration_check[\s\S]*duration_delta_minutes[\s\S]*>= 0/,
  );
});

test("booking operations reject unknown hold model versions", () => {
  assert.doesNotMatch(
    modelVersionMigrationSql,
    /DROP\s+(?:TABLE|COLUMN|TYPE)/i,
  );
  assert.match(
    modelVersionMigrationSql,
    /appointment_holds_booking_model_version_check[\s\S]*booking_model_version[\s\S]*IN \(1, 2\)/,
  );
});

test("lineage reconciliation restores missing marketing sync uniqueness guarantees", () => {
  assert.match(
    lineageReconciliationMigrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "marketing_contact_sync_jobs_submission_id_idx"[\s\S]*\("submission_id"\)/,
  );
  assert.match(
    lineageReconciliationMigrationSql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "marketing_contact_sync_jobs_consent_event_id_idx"[\s\S]*\("consent_event_id"\)/,
  );
  assert.doesNotMatch(
    lineageReconciliationMigrationSql,
    /DROP\s+(?:TABLE|COLUMN|TYPE|INDEX)/i,
  );
});

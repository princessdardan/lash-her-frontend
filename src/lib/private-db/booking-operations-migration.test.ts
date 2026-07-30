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
const activeOfferingUniquenessMigrationSql = readFileSync(
  new URL("../../../drizzle/0026_nice_mattie_franklin.sql", import.meta.url),
  "utf8",
);
const operationalServiceColumnsMigrationSql = readFileSync(
  new URL("../../../drizzle/0025_smart_praxagora.sql", import.meta.url),
  "utf8",
);
const operationalServiceOwnershipMigrationSql = readFileSync(
  new URL("../../../drizzle/0027_curly_leader.sql", import.meta.url),
  "utf8",
);
const providerScopedServiceIdentityMigrationSql = readFileSync(
  new URL("../../../drizzle/0029_chemical_virginia_dare.sql", import.meta.url),
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

test("active offering uniqueness migration identifies duplicates before creating its index", () => {
  const preflightPosition =
    activeOfferingUniquenessMigrationSql.indexOf("IF EXISTS");
  const indexPosition = activeOfferingUniquenessMigrationSql.indexOf(
    "CREATE UNIQUE INDEX",
  );

  assert.ok(preflightPosition >= 0);
  assert.ok(indexPosition > preflightPosition);
  assert.match(
    activeOfferingUniquenessMigrationSql,
    /GROUP BY "service_id", "provider_id"[\s\S]*HAVING count\(\*\) > 1/,
  );
  assert.match(
    activeOfferingUniquenessMigrationSql,
    /Disable or archive all but one offering[\s\S]*then rerun the migration/,
  );
});

test("operational service ownership migration keeps booking settings and promotions in PostgreSQL", () => {
  assert.doesNotMatch(
    operationalServiceOwnershipMigrationSql,
    /DROP\s+(?:TABLE|COLUMN|TYPE|INDEX)/i,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /CREATE TABLE "booking_service_promotion_codes"/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /"source_sanity_document_id" text/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /CREATE UNIQUE INDEX "booking_service_promotion_codes_sanity_document_idx"/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /CREATE TABLE "booking_service_promotion_offerings"/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /ADD COLUMN "intake_questions" jsonb DEFAULT '\[\]'::jsonb NOT NULL/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /ADD COLUMN "marketing_opt_in_label" text .* NOT NULL/,
  );
  assert.match(
    operationalServiceOwnershipMigrationSql,
    /"offering_id"\) REFERENCES "public"\."booking_service_offerings"\("id"\)/,
  );
  assert.doesNotMatch(
    operationalServiceOwnershipMigrationSql,
    /FOREIGN KEY \("source_sanity_document_id"\)/i,
  );
});

test("provider-scoped service identity migration permits matching services across providers", () => {
  for (const indexName of [
    "booking_services_service_key_idx",
    "booking_services_sanity_document_idx",
    "booking_services_public_slug_idx",
  ]) {
    const dropPosition = providerScopedServiceIdentityMigrationSql.indexOf(
      `DROP INDEX "${indexName}"`,
    );
    const createPosition = providerScopedServiceIdentityMigrationSql.indexOf(
      `CREATE UNIQUE INDEX "${indexName}"`,
    );

    assert.ok(dropPosition >= 0);
    assert.ok(createPosition > dropPosition);
  }

  assert.match(
    providerScopedServiceIdentityMigrationSql,
    /"booking_services_service_key_idx"[\s\S]*\("owner_provider_id","service_key"\)/,
  );
  assert.match(
    providerScopedServiceIdentityMigrationSql,
    /"booking_services_sanity_document_idx"[\s\S]*\("owner_provider_id","sanity_document_id"\)/,
  );
  assert.match(
    providerScopedServiceIdentityMigrationSql,
    /"booking_services_public_slug_idx"[\s\S]*\("owner_provider_id","public_slug"\)/,
  );
});

test("operational cutover migration backfills provider ownership and public offering copy idempotently", () => {
  assert.doesNotMatch(
    operationalServiceColumnsMigrationSql,
    /DROP\s+(?:TABLE|COLUMN|TYPE|INDEX)/i,
  );
  assert.match(
    operationalServiceColumnsMigrationSql,
    /ADD COLUMN "owner_provider_id" uuid/,
  );
  assert.match(
    operationalServiceColumnsMigrationSql,
    /count\(DISTINCT "provider_id"\) = 1[\s\S]*ELSE NULL/,
  );
  assert.match(
    operationalServiceColumnsMigrationSql,
    /"owner_provider_id" IS DISTINCT FROM "resolution"\."owner_provider_id"/,
  );
  assert.match(
    operationalServiceColumnsMigrationSql,
    /"public_title" IS NULL OR btrim\("offering"\."public_title"\) = ''/,
  );
  assert.match(
    operationalServiceColumnsMigrationSql,
    /'Book ' \|\| btrim\("service"\."display_title"\) \|\| ' with ' \|\| btrim\("provider"\."display_name"\)/,
  );
  assert.doesNotMatch(
    operationalServiceColumnsMigrationSql,
    /UPDATE "booking_service_offerings"[\s\S]*SET[\s\S]*"status"/,
  );
});

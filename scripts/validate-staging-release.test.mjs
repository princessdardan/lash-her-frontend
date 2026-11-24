import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { checkStagingRelease } from "./validate-staging-release.mjs";
import { VERCEL_PROJECT_BINDINGS } from "../src/lib/env/application-environment.mjs";

function fixture() {
  const manifest = JSON.parse(readFileSync(new URL("../ops/staging/first-release.json", import.meta.url)));
  manifest.source.approvedCommit = "a".repeat(40);
  manifest.sanity.projectId = "staging-test-project";
  manifest.frontendDatabase.runtimeRoleConfigured = true;
  manifest.frontendDatabase.migrationVerifiedCommit = manifest.source.approvedCommit;
  manifest.frontendDatabase.postgres18CompatibilityVerified = true;
  manifest.providers.googleOAuth.clientId = "185770842371-stage-identity.apps.googleusercontent.com";
  manifest.providers.googleOAuth.adminOwnerEmailsSha256 = createHash("sha256").update("reviewed-admin@example.test").digest("hex");
  manifest.providers.googleCalendar = { ...manifest.providers.googleCalendar, clientId: "185770842371-stage-calendar.apps.googleusercontent.com" };
  const env = {
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production", APP_ENV: "staging",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: manifest.projectId,
    VERCEL_GIT_COMMIT_SHA: manifest.source.approvedCommit, VERCEL_GIT_COMMIT_REF: manifest.source.branch,
    NEXT_PUBLIC_SITE_URL: manifest.origin, NEXT_PUBLIC_SANITY_DATASET: manifest.sanity.dataset,
    NEXT_PUBLIC_SANITY_PROJECT_ID: manifest.sanity.projectId,
    DATABASE_URL: `postgres://${manifest.frontendDatabase.runtimeRole}:test@${manifest.frontendDatabase.pooledHost}/${manifest.frontendDatabase.database}?sslmode=verify-full`,
    KV_REST_API_URL: `https://${manifest.redis.hostname}`, SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_LOCATION_ID: manifest.providers.square.locationId,
    HIGHLEVEL_SYNC_ENABLED: "false", HIGHLEVEL_MARKETING_ENABLED: "false", CHITCHATS_SHIPPING_ENABLED: "false", CHITCHATS_CHECKOUT_ENABLED: "false",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "delivered@resend.dev",
  };
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "ADMIN_OWNER_EMAILS", "SANITY_API_READ_TOKEN", "SANITY_WRITE_TOKEN", "SANITY_WEBHOOK_SECRET", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "RESEND_SEGMENT_MARKETING_ID", "FROM_EMAIL", "ADMIN_EMAIL", "KV_REST_API_TOKEN", "SQUARE_ACCESS_TOKEN", "SQUARE_APPLICATION_ID", "SQUARE_WEBHOOK_SIGNATURE_KEY", "CHECKOUT_SECRET_ENCRYPTION_KEY", "BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY", "PAYMENT_RECONCILIATION_CRON_SECRET", "CRON_SECRET"]) env[name] = "synthetic-test-value";
  env.AUTH_GOOGLE_ID = manifest.providers.googleOAuth.clientId;
  env.GOOGLE_CLIENT_ID = manifest.providers.googleCalendar.clientId;
  env.GOOGLE_REDIRECT_URI = `${manifest.origin}/api/booking/oauth/callback`;
  env.ADMIN_OWNER_EMAILS = "reviewed-admin@example.test";
  env.FROM_EMAIL = manifest.providers.resend.fromEmail;
  env.ADMIN_EMAIL = manifest.providers.resend.adminEmail;
  env.RESEND_SEGMENT_MARKETING_ID = manifest.providers.resend.segmentId;
  return { env, manifest };
}

test("reviewed staging identities, endpoints, role and migration pin validate", () => {
  const { env, manifest } = fixture();
  assert.deepEqual(checkStagingRelease(env, manifest), []);
});
test("a shared Resend account accepts the reviewed staging sender and resources", () => {
  const { env, manifest } = fixture();
  manifest.providers.resend.separateAccountVerified = false;
  assert.deepEqual(checkStagingRelease(env, manifest), []);
});
test("Resend account separation evidence is optional for the reviewed staging configuration", () => {
  const { env, manifest } = fixture();
  delete manifest.providers.resend.separateAccountVerified;
  assert.deepEqual(checkStagingRelease(env, manifest), []);
});
test("production project, owner credentials, live payments and recipient escape fail closed", () => {
  const { env, manifest } = fixture();
  const bad = { ...env, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId,
    DATABASE_URL: env.DATABASE_URL.replace(manifest.frontendDatabase.runtimeRole, "neondb_owner"),
    SQUARE_ENVIRONMENT: "production", STAGING_EMAIL_RECIPIENT_ALLOWLIST: "customer@example.com", PGPASSWORD: "do-not-echo-this" };
  const errors = checkStagingRelease(bad, manifest);
  assert(errors.some(x => x.includes("runtime role")));
  assert(errors.some(x => x.includes("SQUARE_ENVIRONMENT")));
  assert(errors.some(x => x.includes("test recipients")));
  assert(errors.some(x => x.includes("PGPASSWORD")));
  assert(!errors.join(" ").includes("do-not-echo-this"));
});
test("uncommitted candidates and missing migration/compatibility evidence cannot pass", () => {
  const { env, manifest } = fixture();
  manifest.source.approvedCommit = null;
  manifest.frontendDatabase.postgres18CompatibilityVerified = false;
  const errors = checkStagingRelease(env, manifest);
  assert(errors.some(x => x.includes("approved source commit")));
  assert(errors.some(x => x.includes("migration evidence")));
  assert(errors.some(x => x.includes("PostgreSQL 18")));
});

test("protected release pins can approve an existing commit without modifying that commit", () => {
  const { env, manifest } = fixture();
  env.STAGING_RELEASE_COMMIT = manifest.source.approvedCommit;
  env.STAGING_MIGRATION_VERIFIED_COMMIT = manifest.frontendDatabase.migrationVerifiedCommit;
  manifest.source.approvedCommit = null;
  manifest.frontendDatabase.migrationVerifiedCommit = null;
  assert.deepEqual(checkStagingRelease(env, manifest), []);
  const errors = checkStagingRelease({ ...env, STAGING_MIGRATION_VERIFIED_COMMIT: "b".repeat(40) }, manifest);
  assert(errors.some(x => x.includes("migration evidence")));
  assert(checkStagingRelease({ ...env, DATABASE_URL: env.DATABASE_URL.replace("postgres:", "https:") }, manifest).some(x => x.includes("runtime role")));
});


test("OAuth preflight rejects unreviewed/shared clients and production callbacks", () => {
  const { env, manifest } = fixture();
  const wrong = checkStagingRelease({ ...env, AUTH_GOOGLE_ID: env.GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI: "https://lashher.com/api/booking/oauth/callback" }, manifest);
  assert(wrong.some(error => error.includes("AUTH_GOOGLE_ID")));
  assert(wrong.some(error => error.includes("GOOGLE_REDIRECT_URI")));
  manifest.providers.googleCalendar.clientId = manifest.providers.googleOAuth.clientId;
  assert(checkStagingRelease(env, manifest).some(error => error.includes("Distinct reviewed")));
  manifest.providers.googleCalendar.clientId = null;
  assert(checkStagingRelease(env, manifest).some(error => error.includes("Distinct reviewed")));
});

test("staging release rejects added administrators and unreviewed email configuration", () => {
  const { env, manifest } = fixture();
  const errors = checkStagingRelease({ ...env,
    ADMIN_OWNER_EMAILS: `${env.ADMIN_OWNER_EMAILS},unreviewed@example.com`,
    FROM_EMAIL: "Production <hello@lashher.com>",
    RESEND_SEGMENT_MARKETING_ID: "production-segment",
  }, manifest);
  for (const name of ["ADMIN_OWNER_EMAILS", "FROM_EMAIL", "RESEND_SEGMENT_MARKETING_ID"]) assert(errors.some(error => error.includes(name)));
  manifest.providers.resend.separateAccountVerified = false;
  manifest.providers.resend.domainStatus = "pending";
  assert(checkStagingRelease(env, manifest).some(error => error.includes("verified sender")));
});

test("shared administration does not permit different Sanity, database or Redis targets", () => {
  const { env, manifest } = fixture();
  delete manifest.providers.resend.separateAccountVerified;
  for (const [name, value, expectedError] of [
    ["NEXT_PUBLIC_SANITY_PROJECT_ID", "unreviewed-project", "NEXT_PUBLIC_SANITY_PROJECT_ID"],
    ["DATABASE_URL", env.DATABASE_URL.replace(manifest.frontendDatabase.pooledHost, "unreviewed.example.test"), "runtime role"],
    ["KV_REST_API_URL", "https://unreviewed.example.test", "Redis resource"],
  ]) {
    assert(checkStagingRelease({ ...env, [name]: value }, manifest).some(error => error.includes(expectedError)));
  }
});

test("runtime database TLS and connection parameters cannot weaken the reviewed target", () => {
  const { env, manifest } = fixture();
  for (const database of [
    env.DATABASE_URL.replace("verify-full", "require"),
    env.DATABASE_URL + "&options=-csearch_path%3Dother",
    env.DATABASE_URL.replace(manifest.frontendDatabase.pooledHost, "unreviewed-db.example.test"),
  ]) {
    assert(checkStagingRelease({ ...env, DATABASE_URL: database }, manifest).some(error => error.includes("runtime role")));
  }
});

function isolatedFixture() {
  const { env, manifest } = fixture();
  const pins = {
    commit: "b".repeat(40),
    databaseHost: "p4-07-db.example.test",
    databaseName: "isolated_checkout",
    databaseRole: "isolated_checkout_runtime",
    redisOrigin: "https://p4-07-redis.example.test",
    squareLocationId: "LISOLATED9876",
  };
  Object.assign(env, {
    STAGING_RELEASE_COMMIT: pins.commit,
    STAGING_MIGRATION_VERIFIED_COMMIT: pins.commit,
    VERCEL_GIT_COMMIT_SHA: pins.commit,
    VERCEL_GIT_COMMIT_REF: pins.commit,
    STAGING_P4_07_BUILD_PINS: JSON.stringify(pins),
    DATABASE_URL: `postgres://${pins.databaseRole}:fixture@${pins.databaseHost}/${pins.databaseName}?sslmode=verify-full`,
    KV_REST_API_URL: pins.redisOrigin,
    SQUARE_LOCATION_ID: pins.squareLocationId,
    CUSTOMER_AUTH_ENABLED: "false",
    INTEGRATION_CHECKOUT_ENABLED: "false",
    INTEGRATION_CUSTOMER_ACCESS_ENABLED: "false",
    INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED: "false",
    INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED: "false",
    LASH_RELEASE_SCHEDULER_PROFILE: "off",
    LASH_RELEASE_SCHEDULER_QUALIFICATION: "false",
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
  });
  return { env, manifest, pins };
}

test("an isolated P4-07 build validates against its exact source and deployment pins", () => {
  const { env, manifest } = isolatedFixture();
  assert.deepEqual(checkStagingRelease(env, manifest), []);
  const ordinary = { ...env };
  delete ordinary.STAGING_P4_07_BUILD_PINS;
  assert(checkStagingRelease(ordinary, manifest).some(error => error.includes("runtime role")));
  assert.deepEqual(checkStagingRelease(fixture().env, manifest), []);
});

test("isolated build pins refuse shared resources, source drift and open release controls", () => {
  const { env, manifest, pins } = isolatedFixture();
  for (const change of [
    { databaseHost: manifest.frontendDatabase.pooledHost },
    { redisOrigin: `https://${manifest.redis.hostname}` },
    { squareLocationId: manifest.providers.square.locationId },
    { commit: "c".repeat(40) },
  ]) {
    const errors = checkStagingRelease({
      ...env, STAGING_P4_07_BUILD_PINS: JSON.stringify({ ...pins, ...change }),
    }, manifest);
    assert(errors.some(error => error.includes("isolated P4-07")));
  }
  for (const [name, value] of [
    ["SQUARE_ENVIRONMENT", "production"],
    ["INTEGRATION_CHECKOUT_ENABLED", "true"],
    ["INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "true"],
    ["LASH_RELEASE_SCHEDULER_PROFILE", "full"],
    ["FRONTEND_WRITER_ADMISSION_MODE", "off"],
    ["FRONTEND_WRITER_ADMISSION_TARGET_JSON", '{"environment":"staging"}'],
  ]) {
    const errors = checkStagingRelease({ ...env, [name]: value }, manifest);
    assert(errors.some(error => error.includes(name)), name);
  }
  const errors = checkStagingRelease({
    ...env, DATABASE_URL: env.DATABASE_URL.replace("verify-full", "require"),
  }, manifest);
  assert(errors.some(error => error.includes("runtime role")));
});

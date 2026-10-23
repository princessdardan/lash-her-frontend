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
    VERCEL_GIT_COMMIT_SHA: manifest.source.approvedCommit, VERCEL_GIT_COMMIT_REF: "staging",
    NEXT_PUBLIC_SITE_URL: manifest.origin, NEXT_PUBLIC_SANITY_DATASET: manifest.sanity.dataset,
    NEXT_PUBLIC_SANITY_PROJECT_ID: manifest.sanity.projectId,
    DATABASE_URL: `postgres://lash_her_frontend_staging_runtime:test@${manifest.frontendDatabase.pooledHost}/neondb?sslmode=verify-full`,
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
test("production project, owner credentials, live payments and recipient escape fail closed", () => {
  const { env, manifest } = fixture();
  const bad = { ...env, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId,
    DATABASE_URL: env.DATABASE_URL.replace("lash_her_frontend_staging_runtime", "neondb_owner"),
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

test("staging release rejects added administrators and cross-account email configuration", () => {
  const { env, manifest } = fixture();
  const errors = checkStagingRelease({ ...env,
    ADMIN_OWNER_EMAILS: `${env.ADMIN_OWNER_EMAILS},unreviewed@example.com`,
    FROM_EMAIL: "Production <hello@lashher.com>",
    RESEND_SEGMENT_MARKETING_ID: "production-segment",
  }, manifest);
  for (const name of ["ADMIN_OWNER_EMAILS", "FROM_EMAIL", "RESEND_SEGMENT_MARKETING_ID"]) assert(errors.some(error => error.includes(name)));
  manifest.providers.resend.domainStatus = "pending";
  assert(checkStagingRelease(env, manifest).some(error => error.includes("verified sender")));
});

test("runtime database TLS and connection parameters cannot weaken the reviewed target", () => {
  const { env, manifest } = fixture();
  for (const database of [env.DATABASE_URL.replace("verify-full", "require"), env.DATABASE_URL + "&options=-csearch_path%3Dother"]) {
    assert(checkStagingRelease({ ...env, DATABASE_URL: database }, manifest).some(error => error.includes("runtime role")));
  }
});

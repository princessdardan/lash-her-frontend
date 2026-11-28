import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { checkStagingRelease, loadStagingReleaseManifest } from "./validate-staging-release.mjs";
import { P600_HOST, P600_DATABASE, P600_RUNTIME, P600_TARGET_SHA256, p600ProducerSha256 } from "../src/lib/private-db/p600-postgres-relay.mjs";
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

function p506Fixture() {
  const { env, manifest } = fixture();
  const commit = "c".repeat(40);
  const migrationReceiptSha256 = "d".repeat(64);
  const database = "postgresql://lash_her_p506_frontend_runtime:p506-inactive-build-fixture@p506-frontend-db.lashher.com:5432/lash_her_p506_frontend?sslmode=verify-full&channel_binding=require";
  const inactiveProviders = [
    "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "ADMIN_OWNER_EMAILS",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
    "SANITY_API_READ_TOKEN", "SANITY_WRITE_TOKEN", "SANITY_WEBHOOK_SECRET",
    "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "RESEND_SEGMENT_MARKETING_ID",
    "FROM_EMAIL", "ADMIN_EMAIL", "KV_REST_API_TOKEN", "SQUARE_ACCESS_TOKEN",
    "SQUARE_APPLICATION_ID", "SQUARE_LOCATION_ID", "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "CHECKOUT_SECRET_ENCRYPTION_KEY", "BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
    "PAYMENT_RECONCILIATION_CRON_SECRET", "CRON_SECRET",
    "CUSTOMER_AUTH_GOOGLE_ID", "CUSTOMER_AUTH_GOOGLE_SECRET", "CUSTOMER_AUTH_RESEND_KEY",
    "CUSTOMER_AUTH_EMAIL_FROM", "CUSTOMER_AUTH_SECRET",
  ];
  Object.assign(env, Object.fromEntries(inactiveProviders.map(name => [name, ""])), {
    STAGING_P5_06_BUILD_PINS: JSON.stringify({ commit, migrationReceiptSha256 }),
    STAGING_P5_06_MIGRATION_RECEIPT_SHA256: migrationReceiptSha256,
    STAGING_RELEASE_COMMIT: commit,
    STAGING_MIGRATION_VERIFIED_COMMIT: commit,
    VERCEL_GIT_COMMIT_SHA: commit,
    VERCEL_GIT_COMMIT_REF: commit,
    DATABASE_URL: database,
    FRONTEND_WRITER_ADMISSION_DATABASE_URL: database,
    API_GATEWAY_STAGING_ORIGIN: "https://api-p506.lashher.com",
    P506_POSTGRES_RELAY_URL: "wss://api-p506.lashher.com/internal/p5-06/postgres",
    KV_REST_API_URL: "https://p506-inactive-build.invalid",
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
    LASH_RELEASE_SCHEDULER_PROFILE: "off",
    LASH_RELEASE_SCHEDULER_QUALIFICATION: "false",
    API_GATEWAY_SMOKE_ENABLED: "false",
    CUSTOMER_AUTH_ENABLED: "false",
    CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED: "false",
    CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED: "false",
    INTEGRATION_CUSTOMER_ACCESS_ENABLED: "false",
    INTEGRATION_LEARNING_ROUTES_ENABLED: "false",
    INTEGRATION_COURSE_READS_ENABLED: "false",
    INTEGRATION_COURSE_AUTHORING_ENABLED: "false",
    INTEGRATION_CHECKOUT_ENABLED: "false",
    INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED: "false",
    INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED: "false",
    INTEGRATION_COMMUNITY_READS_ENABLED: "false",
    INTEGRATION_COMMUNITY_WRITES_ENABLED: "false",
    INTEGRATION_COMMUNITY_MEDIA_ENABLED: "false",
    MANUAL_PRODUCT_CHECKOUT_ENABLED: "false",
    SQUARE_COMMERCE_ENABLED: "false",
    SERVICE_BOOKING_SQUARE_ENABLED: "false",
    SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED: "false",
    SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED: "false",
    TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED: "false",
  });
  return { env, manifest };
}

test("P5-06 accepts only an exact isolated held build", () => {
  const { env, manifest } = p506Fixture();
  assert.deepEqual(checkStagingRelease(env, manifest), []);
  for (const [name, value, error] of [
    ["VERCEL_PROJECT_ID", VERCEL_PROJECT_BINDINGS.productionProjectId, "VERCEL_PROJECT_ID"],
    ["VERCEL_TARGET_ENV", "preview", "VERCEL_TARGET_ENV"],
    ["STAGING_P5_06_BUILD_PINS", undefined, "source and migration receipt"],
    ["STAGING_P5_06_MIGRATION_RECEIPT_SHA256", "e".repeat(64), "source and migration receipt"],
    ["STAGING_MIGRATION_VERIFIED_COMMIT", "e".repeat(40), "source and migration receipt"],
    ["VERCEL_GIT_COMMIT_REF", "staging", "source and migration receipt"],
    ["P407_POSTGRES_RELAY_URL", "wss://api-p407.lashher.com/internal/p4-07/postgres", "P407_POSTGRES_RELAY_URL"],
    ["P506_POSTGRES_RELAY_URL", env.P506_POSTGRES_RELAY_URL + "?target=other", "P506_POSTGRES_RELAY_URL"],
    ["API_GATEWAY_STAGING_ORIGIN", "https://api-staging.lashher.com", "API_GATEWAY_STAGING_ORIGIN"],
    ["LASH_RELEASE_SCHEDULER_PROFILE", "business", "LASH_RELEASE_SCHEDULER_PROFILE"],
    ["SQUARE_COMMERCE_ENABLED", "true", "SQUARE_COMMERCE_ENABLED"],
    ["INTEGRATION_CHECKOUT_ENABLED", "true", "INTEGRATION_CHECKOUT_ENABLED"],
    ["CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED", "true", "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED"],
    ["P506_POSTGRES_RELAY_DEPLOYMENT_PROOF", "do-not-echo-this", "P506_POSTGRES_RELAY_DEPLOYMENT_PROOF"],
    ["RESEND_API_KEY", "do-not-echo-this", "RESEND_API_KEY"],
  ]) {
    const errors = checkStagingRelease({ ...env, [name]: value }, manifest);
    assert(errors.some(message => message.includes(error)), name);
    assert(!errors.join(" ").includes("do-not-echo-this"));
  }
});

test("P5-06 validates the exact build-only target on both database drivers", () => {
  const { env, manifest } = p506Fixture();
  for (const name of ["DATABASE_URL", "FRONTEND_WRITER_ADMISSION_DATABASE_URL"]) {
    for (const value of [
      env[name].replace("postgresql:", "https:"),
      env[name].replace("p506-frontend-db.lashher.com", manifest.frontendDatabase.pooledHost),
      env[name].replace("5432", "6432"),
      env[name].replace("lash_her_p506_frontend_runtime", "migration_role"),
      env[name].replace("/lash_her_p506_frontend", "/unrelated_database"),
      env[name].replace("p506-inactive-build-fixture", "do-not-echo-this"),
      env[name].replace("verify-full", "require"),
      env[name].replace("channel_binding=require", "channel_binding=disable"),
      env[name] + "&sslmode=require",
      env[name] + "&options=unsafe",
      env[name] + "#fragment",
    ]) {
      const errors = checkStagingRelease({ ...env, [name]: value }, manifest);
      assert(errors.some(message => message.includes(name)), name);
      assert(!errors.join(" ").includes("do-not-echo-this"));
    }
  }
});


test("the two real prebuild commands accept only the exact isolated P5-06 build", () => {
  const { env } = p506Fixture();
  const manifest = loadStagingReleaseManifest();
  const isolated = {
    ...env,
    NEXT_PUBLIC_SANITY_PROJECT_ID: manifest.sanity.projectId,
    NEXT_PUBLIC_SANITY_API_VERSION: "2026-03-24",
  };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const run = (name, bindings) => spawnSync(process.execPath, ["scripts/" + name], {
    cwd: root, env: bindings, encoding: "utf8",
  });
  const paymentFixture = {
    ...isolated,
    NEXT_PUBLIC_SANITY_PROJECT_ID: "898r3c4e",
    P4_07_SANITY_CLONE: "1",
    STAGING_P5_06_BUILD_PINS: JSON.stringify({
      ...JSON.parse(isolated.STAGING_P5_06_BUILD_PINS),
      sanityFixture: "p6-02-isolated-payment",
    }),
  };
  for (const command of ["validate-staging-release.mjs", "validate-sanity-env.mjs"]) {
    const accepted = run(command, isolated);
    assert.equal(accepted.status, 0, accepted.stderr);
    const fixtureAccepted = run(command, paymentFixture);
    assert.equal(fixtureAccepted.status, 0, fixtureAccepted.stderr);
    for (const changes of [
      { STAGING_P5_06_BUILD_PINS: isolated.STAGING_P5_06_BUILD_PINS },
      {
        STAGING_P5_06_BUILD_PINS: JSON.stringify({
          ...JSON.parse(isolated.STAGING_P5_06_BUILD_PINS),
          sanityFixture: "unreviewed",
        }),
      },
      { P4_07_SANITY_CLONE: "" },
      { NEXT_PUBLIC_SANITY_PROJECT_ID: manifest.sanity.projectId },
      { NEXT_PUBLIC_SANITY_PROJECT_ID: "cmlb4clg" },
      { NEXT_PUBLIC_SANITY_DATASET: "production" },
      { VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.productionProjectId },
      { SQUARE_ENVIRONMENT: "production" },
      { SQUARE_COMMERCE_ENABLED: "true" },
      { LASH_RELEASE_SCHEDULER_PROFILE: "business" },
    ]) {
      const rejected = run(command, { ...paymentFixture, ...changes });
      assert.equal(rejected.status, 1, command + " payment fixture " + Object.keys(changes).join(","));
    }
    for (const changes of [
      { APP_VERCEL_TEAM_ID: "team_unreviewed" },
      { STAGING_P5_06_BUILD_PINS: "malformed" },
      { STAGING_P5_06_MIGRATION_RECEIPT_SHA256: "f".repeat(64) },
      { DATABASE_URL: isolated.DATABASE_URL.replace("p506-inactive-build-fixture", "never-echo-value") },
      { FRONTEND_WRITER_ADMISSION_TARGET_JSON: '{"environment":"staging"}' },
      { FRONTEND_WRITER_PRODUCER_SHA256: "f".repeat(64) },
      { SANITY_API_READ_TOKEN: "never-echo-value" },
      { SANITY_API_READ_TOKEN: undefined },
      { BOOKING_ADMIN_SETUP_SECRET: "never-echo-value" },
      { P506_POSTGRES_RELAY_DEPLOYMENT_PROOF: "never-echo-value" },
      { SANITY_WRITE_TOKEN: "never-echo-value" },
      { INTEGRATION_COMMUNITY_WRITES_ENABLED: "true" },
      { NEXT_PUBLIC_SANITY_DATASET: "production" },
    ]) {
      const rejected = run(command, { ...isolated, ...changes });
      assert.equal(rejected.status, 1, command + " " + Object.keys(changes).join(","));
      assert.doesNotMatch(rejected.stderr, /never-echo-value/u);
    }
  }
  const ordinary = { ...isolated };
  for (const name of Object.keys(ordinary)) {
    if (name.startsWith("STAGING_P5_06_") || name.startsWith("P506_POSTGRES_RELAY_")) delete ordinary[name];
  }
  const missing = run("validate-sanity-env.mjs", ordinary);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing env var: AUTH_SECRET/u);
  assert.match(missing.stderr, /Missing env var: SANITY_API_READ_TOKEN/u);
  const malformed = run("validate-sanity-env.mjs", {
    ...ordinary, AUTH_SECRET: "short", GOOGLE_REDIRECT_URI: "not-a-url",
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /Malformed env var: AUTH_SECRET/u);
  assert.match(malformed.stderr, /Malformed env var: GOOGLE_REDIRECT_URI/u);
});

test("shared Lightsail binding requires its own protected relay, TLS, and existing provider checks", () => {
  const {env, manifest} = fixture();
  const database = "postgresql://lash_her_frontend_staging_runtime_p2:fixture@p600-frontend-db.lashher.com/lash_her_p600_frontend?sslmode=verify-full&channel_binding=require";
  const selected = {...env, DATABASE_URL: database, FRONTEND_WRITER_ADMISSION_DATABASE_URL: database, FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_PRODUCER_SHA256: p600ProducerSha256(env.VERCEL_GIT_COMMIT_SHA),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({environment:"staging",host:P600_HOST, port:5432, user:P600_RUNTIME,
      database:P600_DATABASE, serverMajor:18, targetSha256:P600_TARGET_SHA256}), P600_POSTGRES_RELAY_URL: "wss://api-p600.lashher.com/internal/p6-00/postgres",
    P600_POSTGRES_RELAY_DEPLOYMENT_PROOF: "a".repeat(64)};
  assert.deepEqual(checkStagingRelease(selected, manifest), []);
  for (const change of [{FRONTEND_WRITER_ADMISSION_MODE:"off"}, {FRONTEND_WRITER_ADMISSION_DATABASE_URL: env.DATABASE_URL},
    {FRONTEND_WRITER_PRODUCER_SHA256:"f".repeat(64)}, {DATABASE_URL: env.DATABASE_URL}, {P600_POSTGRES_RELAY_URL: undefined}, {P600_POSTGRES_RELAY_DEPLOYMENT_PROOF: ""},
    {DATABASE_URL: database.replace("channel_binding=require", "channel_binding=prefer")}, {DATABASE_URL: database + "&host=other"},
    {STAGING_P5_06_BUILD_PINS: "{}"}, {VERCEL_ENV: "preview"}, {SQUARE_ENVIRONMENT: "production"}]) {
    assert.ok(checkStagingRelease({...selected, ...change}, manifest).length);
  }
});

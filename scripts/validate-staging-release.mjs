import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { readP600RelayConfig, selectsP600Relay } from "../src/lib/private-db/p600-postgres-relay.mjs";
import { resolveApplicationEnvironment } from "../src/lib/env/application-environment.mjs";

import {
  P506_RELAY_URL, P506_POSTGRES_HOST, P506_POSTGRES_PORT,
  P506_POSTGRES_DATABASE, P506_POSTGRES_ROLE,
} from "../src/lib/private-db/p506-postgres-relay-pins.mjs";

const FORBIDDEN_DATABASE_BINDINGS = [
  "DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL",
  "POSTGRES_PRISMA_URL", "POSTGRES_URL_NO_SSL", "PGPASSWORD", "POSTGRES_PASSWORD",
  "COMMUNITY_DATABASE_URL", "COURSE_DATABASE_URL",
];

const REQUIRED_CREDENTIALS = [
  "AUTH_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "ADMIN_OWNER_EMAILS",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
  "SANITY_API_READ_TOKEN", "SANITY_WRITE_TOKEN", "SANITY_WEBHOOK_SECRET",
  "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "RESEND_SEGMENT_MARKETING_ID",
  "FROM_EMAIL", "ADMIN_EMAIL", "KV_REST_API_TOKEN", "SQUARE_ACCESS_TOKEN",
  "SQUARE_APPLICATION_ID", "SQUARE_LOCATION_ID", "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "CHECKOUT_SECRET_ENCRYPTION_KEY", "BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
  "PAYMENT_RECONCILIATION_CRON_SECRET", "CRON_SECRET",
];

function isolatedBuildPins(env, manifest) {
  const pins = JSON.parse(env.STAGING_P4_07_BUILD_PINS);
  const dnsName = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;
  const databaseName = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u;
  const redis = new URL(pins.redisOrigin);
  if (
    typeof pins.commit !== "string" || !/^[a-f0-9]{40}$/u.test(pins.commit) ||
    pins.commit !== env.STAGING_RELEASE_COMMIT ||
    pins.commit !== env.STAGING_MIGRATION_VERIFIED_COMMIT ||
    typeof pins.databaseHost !== "string" || !dnsName.test(pins.databaseHost) ||
    [manifest.frontendDatabase.pooledHost, manifest.frontendDatabase.directHost].includes(pins.databaseHost) ||
    typeof pins.databaseName !== "string" || !databaseName.test(pins.databaseName) ||
    typeof pins.databaseRole !== "string" || !databaseName.test(pins.databaseRole) ||
    !dnsName.test(redis.hostname) || pins.redisOrigin !== `https://${redis.hostname}` ||
    redis.hostname === manifest.redis.hostname ||
    typeof pins.squareLocationId !== "string" || !/^[A-Za-z0-9]{8,64}$/u.test(pins.squareLocationId) ||
    pins.squareLocationId === manifest.providers.square.locationId
  ) throw new Error();
  return pins;
}

const P506_HELD_FEATURES = [
  "API_GATEWAY_SMOKE_ENABLED",
  "CUSTOMER_AUTH_ENABLED",
  "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED",
  "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
  "INTEGRATION_CUSTOMER_ACCESS_ENABLED",
  "INTEGRATION_LEARNING_ROUTES_ENABLED",
  "INTEGRATION_COURSE_READS_ENABLED",
  "INTEGRATION_COURSE_AUTHORING_ENABLED",
  "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED",
  "INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED",
  "INTEGRATION_COMMUNITY_READS_ENABLED",
  "INTEGRATION_COMMUNITY_WRITES_ENABLED",
  "INTEGRATION_COMMUNITY_MEDIA_ENABLED",
  "HIGHLEVEL_SYNC_ENABLED",
  "HIGHLEVEL_MARKETING_ENABLED",
  "CHITCHATS_SHIPPING_ENABLED",
  "CHITCHATS_CHECKOUT_ENABLED",
  "MANUAL_PRODUCT_CHECKOUT_ENABLED",
  "SQUARE_COMMERCE_ENABLED",
  "SERVICE_BOOKING_SQUARE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED",
  "TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED",
];

const P506_BUILD_INPUT = "p506-inactive-build-fixture";
export const P4_07_SANITY_CLONE_PROJECT_ID = "898r3c4e";

function checkP506Database(value) {
  try {
    const url = new URL(value);
    const channelBinding = url.searchParams.getAll("channel_binding");
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname === P506_POSTGRES_HOST && Number(url.port || 5432) === P506_POSTGRES_PORT &&
      decodeURIComponent(url.pathname) === `/${P506_POSTGRES_DATABASE}` &&
      decodeURIComponent(url.username) === P506_POSTGRES_ROLE && url.password === P506_BUILD_INPUT && !url.hash &&
      url.searchParams.getAll("sslmode").length === 1 && url.searchParams.get("sslmode") === "verify-full" &&
      [...url.searchParams.keys()].every(key => key === "sslmode" || key === "channel_binding") &&
      (channelBinding.length === 0 || channelBinding.length === 1 && channelBinding[0] === "require");
  } catch { return false; }
}

function checkP506Build(env, manifest) {
  const errors = [];
  const requireValue = (name, expected) => {
    if (env[name] !== expected) errors.push(`${name} must match the isolated P5-06 build configuration`);
  };
  const requireEmpty = (name) => {
    if (env[name]) errors.push(`${name} must be absent from the isolated P5-06 build`);
  };
  try {
    if (resolveApplicationEnvironment(env) !== "staging") throw new Error();
  } catch { errors.push("The verified Vercel staging project and team are required for P5-06"); }

  let sanityProjectId = manifest.sanity.projectId;
  // The operator validates the read-only migration receipt, then pins its digest
  // and source in deployment build metadata. A build does not contact the DB.
  try {
    const { commit, migrationReceiptSha256, sanityFixture } = JSON.parse(env.STAGING_P5_06_BUILD_PINS);
    const sha = (value, size) => typeof value === "string" &&
      new RegExp(`^(?!0+$)[a-f0-9]{${size}}$`, "u").test(value);
    if (!sha(commit, 40) || !sha(migrationReceiptSha256, 64) ||
        migrationReceiptSha256 !== env.STAGING_P5_06_MIGRATION_RECEIPT_SHA256 ||
        commit !== env.STAGING_RELEASE_COMMIT || commit !== env.STAGING_MIGRATION_VERIFIED_COMMIT ||
        commit !== env.VERCEL_GIT_COMMIT_SHA || commit !== env.VERCEL_GIT_COMMIT_REF) throw new Error();
    if (sanityFixture !== undefined) {
      if (sanityFixture === "p6-02-isolated-payment" && env.P4_07_SANITY_CLONE === "1") {
        sanityProjectId = P4_07_SANITY_CLONE_PROJECT_ID;
      } else {
        errors.push("The P6-02 payment Sanity fixture pin is invalid");
      }
    }
  } catch { errors.push("The isolated P5-06 source and migration receipt pins are invalid"); }

  for (const [name, value] of Object.entries({
    VERCEL: "1",
    VERCEL_PROJECT_ID: manifest.projectId,
    VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production",
    NEXT_PUBLIC_SITE_URL: manifest.origin,
    NEXT_PUBLIC_SANITY_PROJECT_ID: sanityProjectId,
    NEXT_PUBLIC_SANITY_DATASET: manifest.sanity.dataset,
    API_GATEWAY_STAGING_ORIGIN: new URL(P506_RELAY_URL).origin.replace(/^wss:/u, "https:"),
    P506_POSTGRES_RELAY_URL: P506_RELAY_URL,
    LASH_RELEASE_SCHEDULER_PROFILE: "off",
    LASH_RELEASE_SCHEDULER_QUALIFICATION: "false",
    FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
    SQUARE_ENVIRONMENT: "sandbox",
    KV_REST_API_URL: "https://p506-inactive-build.invalid",
    SANITY_API_READ_TOKEN: "",
  })) requireValue(name, value);
  if (!manifest.sanity.projectId) errors.push("A selected staging Sanity project must be recorded");
  for (const feature of P506_HELD_FEATURES) requireValue(feature, "false");
  for (const name of [
    ...FORBIDDEN_DATABASE_BINDINGS,
    "STAGING_P4_07_BUILD_PINS", "P407_POSTGRES_RELAY_URL", "P407_POSTGRES_RELAY_DEPLOYMENT_PROOF",
    "P506_POSTGRES_RELAY_DEPLOYMENT_PROOF", "P506_POSTGRES_RELAY_PROOF_SHA256", "P506_POSTGRES_RELAY_PROOF_EXPIRES_AT",
    "FRONTEND_WRITER_PRODUCER_SHA256", "API_GATEWAY_PRODUCTION_ORIGIN",
    "BOOKING_ADMIN_SETUP_SECRET", "CHECKOUT_PII_ENCRYPTION_KEY",
  ]) requireEmpty(name);
  if (env.PAYMENT_GATEWAY_MODE === "mock") errors.push("The Production target must not use payment mock mode");

  for (const name of ["DATABASE_URL", "FRONTEND_WRITER_ADMISSION_DATABASE_URL"]) {
    if (!checkP506Database(env[name])) errors.push(`${name} must use the isolated P5-06 database identity and TLS policy`);
  }
  for (const name of [
    ...REQUIRED_CREDENTIALS.filter(name => name !== "SANITY_API_READ_TOKEN"),
    "SQUARE_LOCATION_ID", "CUSTOMER_AUTH_GOOGLE_ID", "CUSTOMER_AUTH_GOOGLE_SECRET",
    "CUSTOMER_AUTH_RESEND_KEY", "CUSTOMER_AUTH_EMAIL_FROM", "CUSTOMER_AUTH_SECRET",
  ]) {
    // Explicit blank or known synthetic input removes inherited provider credentials.
    if (env[name] !== "" && env[name] !== P506_BUILD_INPUT) requireValue(name, P506_BUILD_INPUT);
  }
  return errors;
}

export function hasP506BuildBindings(env) {
  return env.STAGING_P5_06_BUILD_PINS !== undefined ||
    env.STAGING_P5_06_MIGRATION_RECEIPT_SHA256 !== undefined ||
    Object.keys(env).some(name => name.startsWith("P506_POSTGRES_RELAY_"));
}

export function loadStagingReleaseManifest() {
  return JSON.parse(readFileSync(new URL("../ops/staging/first-release.json", import.meta.url), "utf8"));
}

/** Returns configuration errors without including credential values or URLs. */
export function checkStagingRelease(env, manifest) {
  const useLightsail = selectsP600Relay(env.DATABASE_URL, env);
  if (useLightsail && hasP506BuildBindings(env)) return ["Mixed staging database release scopes"];
  if (hasP506BuildBindings(env)) {
    return checkP506Build(env, manifest);
  }
  const errors = [];
  const requireValue = (name, expected) => {
    if (env[name] !== expected) errors.push(`${name} does not match the staging release manifest`);
  };
  const readUrl = (name) => {
    try { return new URL(env[name]); }
    catch { errors.push(`${name} must be a configured staging URL`); return null; }
  };
  let isolated;
  if (env.STAGING_P4_07_BUILD_PINS !== undefined) {
    try {
      isolated = isolatedBuildPins(env, manifest);
    } catch {
      errors.push("The isolated P4-07 source, migration and provider pins are invalid");
    }
    for (const [name, expected] of Object.entries({
      CUSTOMER_AUTH_ENABLED: "false",
      INTEGRATION_CHECKOUT_ENABLED: "false",
      INTEGRATION_CUSTOMER_ACCESS_ENABLED: "false",
      INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED: "false",
      INTEGRATION_LEGACY_PROGRESS_IMPORT_ENABLED: "false",
      LASH_RELEASE_SCHEDULER_PROFILE: "off",
      LASH_RELEASE_SCHEDULER_QUALIFICATION: "false",
      FRONTEND_WRITER_ADMISSION_MODE: "enforce",
      FRONTEND_WRITER_ADMISSION_TARGET_JSON: "{}",
    })) requireValue(name, expected);
  }
  try {
    if (resolveApplicationEnvironment(env) !== "staging") errors.push("A verified business staging deployment is required");
  } catch { errors.push("The Vercel project, target, APP_ENV and team binding must be verified"); }
  requireValue("VERCEL_PROJECT_ID", manifest.projectId);
  requireValue("VERCEL_ENV", manifest.target);
  requireValue("VERCEL_TARGET_ENV", manifest.target);
  requireValue("NEXT_PUBLIC_SITE_URL", manifest.origin);
  requireValue("NEXT_PUBLIC_SANITY_DATASET", manifest.sanity.dataset);
  if (!manifest.sanity.projectId) errors.push("A selected staging Sanity project must be recorded");
  else requireValue("NEXT_PUBLIC_SANITY_PROJECT_ID", manifest.sanity.projectId);
  // Each staging purpose must use its own reviewed OAuth client ID and callback.
  const identityClient = manifest.providers.googleOAuth.clientId;
  const calendarClient = manifest.providers.googleCalendar?.clientId;
  if (!identityClient || !calendarClient || identityClient === calendarClient) {
    errors.push("Distinct reviewed staging Identity and Calendar OAuth clients must be recorded");
  } else {
    requireValue("AUTH_GOOGLE_ID", identityClient);
    requireValue("GOOGLE_CLIENT_ID", calendarClient);
  }
  requireValue("GOOGLE_REDIRECT_URI", `${manifest.origin}/api/booking/oauth/callback`);
  const reviewedAdminsHash = manifest.providers.googleOAuth.adminOwnerEmailsSha256;
  const configuredAdmins = (env.ADMIN_OWNER_EMAILS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const configuredAdminsHash = createHash("sha256").update([...new Set(configuredAdmins)].sort().join("\n")).digest("hex");
  if (!configuredAdmins.length || !reviewedAdminsHash || configuredAdminsHash !== reviewedAdminsHash) {
    errors.push("ADMIN_OWNER_EMAILS must match the reviewed staging administrators");
  }
  const resend = manifest.providers.resend;
  if (resend.domainStatus !== "verified") errors.push("A verified sender domain is required");
  for (const [name, expected] of [["FROM_EMAIL", resend.fromEmail], ["ADMIN_EMAIL", resend.adminEmail], ["RESEND_SEGMENT_MARKETING_ID", resend.segmentId]]) {
    if (!expected) errors.push(`${name} must be recorded in the staging release manifest`);
    else requireValue(name, expected);
  }
  // Set release pins in protected deployment configuration after source review.
  // Committing a file containing its own Git SHA would create a circular pin.
  const commit = isolated?.commit ?? manifest.source.approvedCommit ?? env.STAGING_RELEASE_COMMIT;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) errors.push("An approved source commit must be pinned");
  else requireValue("VERCEL_GIT_COMMIT_SHA", commit);
  if (env.VERCEL_GIT_COMMIT_REF !== manifest.source.branch &&
    (!isolated || env.VERCEL_GIT_COMMIT_REF !== isolated.commit)) {
    errors.push("The reviewed staging Git branch is required");
  }
  const migratedCommit = isolated?.commit ?? manifest.frontendDatabase.migrationVerifiedCommit ?? env.STAGING_MIGRATION_VERIFIED_COMMIT;
  if (!commit || migratedCommit !== commit) errors.push("Frontend migration evidence must match the approved source commit");
  if (!manifest.frontendDatabase.postgres18CompatibilityVerified) errors.push("PostgreSQL 18 compatibility evidence is required");
  if (!manifest.frontendDatabase.runtimeRoleConfigured) errors.push("Separate frontend runtime and migration roles are required");
  const database = readUrl("DATABASE_URL");
  if (useLightsail) {
    try {
      readP600RelayConfig(env.DATABASE_URL, env);
      readP600RelayConfig(env.FRONTEND_WRITER_ADMISSION_DATABASE_URL, env);
    }
    catch { errors.push("DATABASE_URL and relay must match the shared Lightsail staging runtime and TLS policy"); }
  } else if (database && (!["postgres:", "postgresql:"].includes(database.protocol) ||
    (database.port && database.port !== "5432") || database.hostname !== (isolated?.databaseHost ?? manifest.frontendDatabase.pooledHost) ||
    database.pathname !== `/${isolated?.databaseName ?? manifest.frontendDatabase.database}` ||
    decodeURIComponent(database.username) !== (isolated?.databaseRole ?? manifest.frontendDatabase.runtimeRole) ||
    database.searchParams.get("sslmode") !== "verify-full" ||
    [...database.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key)))) {
    errors.push("DATABASE_URL must use the reviewed pooled staging runtime role with TLS");
  }
  const redis = readUrl("KV_REST_API_URL");
  if (redis && (isolated ? env.KV_REST_API_URL !== isolated.redisOrigin :
    redis.protocol !== "https:" || redis.hostname !== manifest.redis.hostname || redis.username || redis.password)) {
    errors.push("KV_REST_API_URL must match the selected staging Redis resource");
  }
  for (const name of FORBIDDEN_DATABASE_BINDINGS) {
    if (env[name]) errors.push(`${name} must not be delivered to the frontend runtime`);
  }
  requireValue("SQUARE_ENVIRONMENT", "sandbox");
  requireValue("SQUARE_LOCATION_ID", isolated?.squareLocationId ?? manifest.providers.square.locationId);
  for (const name of ["HIGHLEVEL_SYNC_ENABLED", "HIGHLEVEL_MARKETING_ENABLED", "CHITCHATS_SHIPPING_ENABLED", "CHITCHATS_CHECKOUT_ENABLED"]) requireValue(name, "false");
  if (env.PAYMENT_GATEWAY_MODE === "mock") errors.push("The Production target must not use payment mock mode");
  const recipients = (env.STAGING_EMAIL_RECIPIENT_ALLOWLIST ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (recipients.length === 0 || recipients.some(x => !manifest.providers.resend.allowedRecipients.includes(x))) errors.push("Staging email must be restricted to the reviewed test recipients");
  for (const name of REQUIRED_CREDENTIALS) {
    if (!env[name]?.trim() || /^(REQUIRED_|TODO|placeholder|replace[-_ ])/i.test(env[name])) errors.push(`${name} is missing or a placeholder`);
  }
  return [...new Set(errors)];
}

function main() {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf("--env-file");
  let env = process.env;
  if (envIndex >= 0) {
    if (!args[envIndex + 1]) throw new Error("--env-file requires a path");
    // Explicit files are snapshots: never merge the repository's production .env.local.
    env = dotenv.parse(readFileSync(args[envIndex + 1]));
  }
  const manifest = loadStagingReleaseManifest();
  const errors = checkStagingRelease(env, manifest);
  if (errors.length) {
    console.error("Staging release is blocked:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log("Staging release configuration validated; deployed smoke tests remain required.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch { console.error("Unable to load the staging release configuration; values withheld."); process.exitCode = 1; }
}

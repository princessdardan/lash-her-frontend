import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { resolveApplicationEnvironment } from "../src/lib/env/application-environment.mjs";

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

/** Returns configuration errors without including credential values or URLs. */
export function checkStagingRelease(env, manifest) {
  const errors = [];
  const requireValue = (name, expected) => {
    if (env[name] !== expected) errors.push(`${name} does not match the staging release manifest`);
  };
  const readUrl = (name) => {
    try { return new URL(env[name]); }
    catch { errors.push(`${name} must be a configured staging URL`); return null; }
  };
  try {
    if (resolveApplicationEnvironment(env) !== "staging") errors.push("A verified business staging deployment is required");
  } catch { errors.push("The Vercel project, target, APP_ENV and team binding must be verified"); }
  requireValue("VERCEL_PROJECT_ID", manifest.projectId);
  requireValue("VERCEL_ENV", manifest.target);
  requireValue("VERCEL_TARGET_ENV", manifest.target);
  requireValue("NEXT_PUBLIC_SITE_URL", manifest.origin);
  requireValue("NEXT_PUBLIC_SANITY_DATASET", manifest.sanity.dataset);
  if (!manifest.sanity.projectId) errors.push("An isolated Sanity project must be recorded");
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
  if (!resend.separateAccountVerified || resend.domainStatus !== "verified") errors.push("An isolated Resend account and verified sender domain are required");
  for (const [name, expected] of [["FROM_EMAIL", resend.fromEmail], ["ADMIN_EMAIL", resend.adminEmail], ["RESEND_SEGMENT_MARKETING_ID", resend.segmentId]]) {
    if (!expected) errors.push(`${name} must be recorded in the staging release manifest`);
    else requireValue(name, expected);
  }
  // Set release pins in protected deployment configuration after source review.
  // Committing a file containing its own Git SHA would create a circular pin.
  const commit = manifest.source.approvedCommit ?? env.STAGING_RELEASE_COMMIT;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) errors.push("An approved source commit must be pinned");
  else requireValue("VERCEL_GIT_COMMIT_SHA", commit);
  if (env.VERCEL_GIT_COMMIT_REF !== manifest.source.branch) errors.push("The reviewed staging Git branch is required");
  const migratedCommit = manifest.frontendDatabase.migrationVerifiedCommit ?? env.STAGING_MIGRATION_VERIFIED_COMMIT;
  if (!commit || migratedCommit !== commit) errors.push("Frontend migration evidence must match the approved source commit");
  if (!manifest.frontendDatabase.postgres18CompatibilityVerified) errors.push("PostgreSQL 18 compatibility evidence is required");
  if (!manifest.frontendDatabase.runtimeRoleConfigured) errors.push("Separate frontend runtime and migration roles are required");
  const database = readUrl("DATABASE_URL");
  if (database && (!["postgres:", "postgresql:"].includes(database.protocol) ||
    (database.port && database.port !== "5432") || database.hostname !== manifest.frontendDatabase.pooledHost ||
    database.pathname !== `/${manifest.frontendDatabase.database}` ||
    decodeURIComponent(database.username) !== manifest.frontendDatabase.runtimeRole ||
    database.searchParams.get("sslmode") !== "verify-full" ||
    [...database.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key)))) {
    errors.push("DATABASE_URL must use the isolated pooled staging runtime role with TLS");
  }
  const redis = readUrl("KV_REST_API_URL");
  if (redis && (redis.protocol !== "https:" || redis.hostname !== manifest.redis.hostname || redis.username || redis.password)) errors.push("KV_REST_API_URL must select the isolated staging Redis resource");
  for (const name of ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NO_SSL", "PGPASSWORD", "POSTGRES_PASSWORD", "COMMUNITY_DATABASE_URL", "COURSE_DATABASE_URL"]) {
    if (env[name]) errors.push(`${name} must not be delivered to the frontend runtime`);
  }
  requireValue("SQUARE_ENVIRONMENT", "sandbox");
  requireValue("SQUARE_LOCATION_ID", manifest.providers.square.locationId);
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
  const manifest = JSON.parse(readFileSync(path.resolve("ops/staging/first-release.json"), "utf8"));
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

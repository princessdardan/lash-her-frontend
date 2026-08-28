import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = join(process.cwd(), "scripts/validate-sanity-env.mjs");
const checkoutKey = Buffer.alloc(32, 7).toString("base64");
const checkoutPiiKey = Buffer.alloc(32, 9).toString("base64");
const calendarCredentialKey = Buffer.alloc(32, 11).toString("base64");
const secretValue = "super-secret-value-that-must-not-appear";

const publicSanityEnv = {
  NEXT_PUBLIC_SANITY_PROJECT_ID: "3auncj84",
  NEXT_PUBLIC_SANITY_DATASET: "local-dev",
  NEXT_PUBLIC_SANITY_API_VERSION: "2026-03-24",
};

const launchEnv = {
  ...publicSanityEnv,
  SANITY_API_READ_TOKEN: "sanity-api-read-token",
  SANITY_WRITE_TOKEN: "sanity-write-token",
  SANITY_WEBHOOK_SECRET: "sanity-webhook-secret",
  AUTH_SECRET: "auth-secret-with-at-least-thirty-two-characters",
  AUTH_GOOGLE_ID: "google-identity-client-id",
  AUTH_GOOGLE_SECRET: "google-identity-client-secret",
  ADMIN_OWNER_EMAILS: "owner@lashher.com",
  RESEND_API_KEY: "resend-api-key",
  RESEND_WEBHOOK_SECRET: "resend-webhook-secret",
  RESEND_SEGMENT_MARKETING_ID: "resend-segment-marketing-id",
  FROM_EMAIL: "hello@lashher.com",
  ADMIN_EMAIL: "admin@lashher.com",
  GOOGLE_CLIENT_ID: "google-client-id",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URI: "https://lashher.com/api/booking/oauth/callback",
  BOOKING_ADMIN_SETUP_SECRET: "booking-admin-setup-secret",
  KV_REST_API_URL: "https://kv.example.com",
  KV_REST_API_TOKEN: "kv-rest-api-token",
  DATABASE_URL: "postgres://user:password@example.com:5432/lashher",
  CHECKOUT_SECRET_ENCRYPTION_KEY: checkoutKey,
  BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY: calendarCredentialKey,
  SERVICE_BOOKING_MODEL_MODE: "dual",
  PAYMENT_RECONCILIATION_CRON_SECRET: "payment-reconciliation-cron-secret",
  CRON_SECRET: "vercel-cron-secret",
  BACKUP_RETENTION_DAYS: "30",
  NEXT_PUBLIC_SITE_URL: "https://lashher.com",
};

test("validates local public Sanity environment", () => {
  const result = runValidator({
    ...publicSanityEnv,
    GOOGLE_REDIRECT_URI: "local-only-not-a-url",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Local environment validated/);
});

test("loads local public Sanity values from .env.local", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lash-her-env-"));

  try {
    writeFileSync(
      join(cwd, ".env.local"),
      [
        "NEXT_PUBLIC_SANITY_PROJECT_ID=3auncj84",
        "NEXT_PUBLIC_SANITY_DATASET=staging-2026-05-10",
        "NEXT_PUBLIC_SANITY_API_VERSION=2026-03-24",
        "",
      ].join("\n"),
    );

    const result = runValidator({ NODE_ENV: "development" }, cwd);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Local environment validated/);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});

test("validates preview launch environment", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Vercel preview environment validated/);
});

test("validates preview Chit Chats shipping configuration", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "true",
    CHITCHATS_US_SHIPPING_ENABLED: "false",
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "client-id",
    CHITCHATS_REGION: "ontario_manitoba",
    CHITCHATS_ACCESS_TOKEN: "access-token",
    CHITCHATS_QUOTE_SIGNING_SECRET: "quote-signing-secret-with-safe-length",
    CHITCHATS_WORKER_CRON_SECRET:
      "worker-cron-secret-with-at-least-32-random-bytes",
    CHECKOUT_PII_ENCRYPTION_KEY: checkoutPiiKey,
    SHIPPING_DECISION_TOKEN_SECRET:
      "shipping-decision-secret-at-least-thirty-two-bytes",
    ADDRESS_CHANGE_TOKEN_SECRET:
      "address-change-secret-at-least-thirty-two-bytes",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "enforce",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Vercel preview environment validated/);
});

test("accepts every canonical Chit Chats region", () => {
  for (const region of [
    "british_columbia",
    "alberta_saskatchewan",
    "ontario_manitoba",
    "quebec",
    "atlantic",
  ]) {
    const result = runValidator({
      ...launchEnv,
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
      CHITCHATS_SHIPPING_ENABLED: "true",
      CHITCHATS_CHECKOUT_ENABLED: "false",
      CHITCHATS_US_SHIPPING_ENABLED: "false",
      CHITCHATS_ENVIRONMENT: "staging",
      CHITCHATS_CLIENT_ID: "client-id",
      CHITCHATS_REGION: region,
      CHITCHATS_ACCESS_TOKEN: "access-token",
      CHITCHATS_QUOTE_SIGNING_SECRET:
        "quote-signing-secret-with-at-least-32-bytes",
      CHITCHATS_WORKER_CRON_SECRET:
        "worker-cron-secret-with-at-least-32-random-bytes",
      CHECKOUT_PII_ENCRYPTION_KEY: checkoutPiiKey,
      SHIPPING_DECISION_TOKEN_SECRET:
        "shipping-decision-secret-at-least-thirty-two-bytes",
      ADDRESS_CHANGE_TOKEN_SECRET:
        "address-change-secret-at-least-thirty-two-bytes",
      SHIPPING_POLICY_ENFORCEMENT_MODE: "observe",
    });

    assert.equal(result.status, 0, `${region}: ${result.combinedOutput}`);
  }
});

test("normalizes surrounding whitespace in the configured Chit Chats region", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "false",
    CHITCHATS_US_SHIPPING_ENABLED: "false",
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "client-id",
    CHITCHATS_REGION: "  ontario_manitoba  ",
    CHITCHATS_ACCESS_TOKEN: "access-token",
    CHITCHATS_QUOTE_SIGNING_SECRET:
      "quote-signing-secret-with-at-least-32-bytes",
    CHITCHATS_WORKER_CRON_SECRET:
      "worker-cron-secret-with-at-least-32-random-bytes",
    CHECKOUT_PII_ENCRYPTION_KEY: checkoutPiiKey,
    SHIPPING_DECISION_TOKEN_SECRET:
      "shipping-decision-secret-at-least-thirty-two-bytes",
    ADDRESS_CHANGE_TOKEN_SECRET:
      "address-change-secret-at-least-thirty-two-bytes",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "observe",
  });

  assert.equal(result.status, 0, result.combinedOutput);
});

test("rejects a Chit Chats region outside the canonical allowlist", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "false",
    CHITCHATS_US_SHIPPING_ENABLED: "false",
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "client-id",
    CHITCHATS_REGION: "ontario",
    CHITCHATS_ACCESS_TOKEN: "access-token",
    CHITCHATS_QUOTE_SIGNING_SECRET:
      "quote-signing-secret-with-at-least-32-bytes",
    CHITCHATS_WORKER_CRON_SECRET:
      "worker-cron-secret-with-at-least-32-random-bytes",
    CHECKOUT_PII_ENCRYPTION_KEY: checkoutPiiKey,
    SHIPPING_DECISION_TOKEN_SECRET:
      "shipping-decision-secret-at-least-thirty-two-bytes",
    ADDRESS_CHANGE_TOKEN_SECRET:
      "address-change-secret-at-least-thirty-two-bytes",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "observe",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /CHITCHATS_REGION must be one of british_columbia, alberta_saskatchewan, ontario_manitoba, quebec, atlantic/,
  );
});

test("does not accept the obsolete branch ID in place of a region", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "false",
    CHITCHATS_US_SHIPPING_ENABLED: "false",
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "client-id",
    CHITCHATS_BRANCH_ID: "unsupported-branch-id",
    CHITCHATS_ACCESS_TOKEN: "access-token",
    CHITCHATS_QUOTE_SIGNING_SECRET:
      "quote-signing-secret-with-at-least-32-bytes",
    CHITCHATS_WORKER_CRON_SECRET:
      "worker-cron-secret-with-at-least-32-random-bytes",
    CHECKOUT_PII_ENCRYPTION_KEY: checkoutPiiKey,
    SHIPPING_DECISION_TOKEN_SECRET:
      "shipping-decision-secret-at-least-thirty-two-bytes",
    ADDRESS_CHANGE_TOKEN_SECRET:
      "address-change-secret-at-least-thirty-two-bytes",
    SHIPPING_POLICY_ENFORCEMENT_MODE: "observe",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: CHITCHATS_REGION/);
});

test("fails when Chit Chats checkout is enabled without the shipping worker", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHITCHATS_SHIPPING_ENABLED: "false",
    CHITCHATS_CHECKOUT_ENABLED: "true",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /CHITCHATS_CHECKOUT_ENABLED requires CHITCHATS_SHIPPING_ENABLED=true/,
  );
});

test("rejects a malformed independent product checkout admission flag", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    MANUAL_PRODUCT_CHECKOUT_ENABLED: "yes",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /MANUAL_PRODUCT_CHECKOUT_ENABLED must be true or false/,
  );
});

test("fails production Chit Chats shipping configured against staging", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SANITY_DATASET: "production",
    CHITCHATS_SHIPPING_ENABLED: "true",
    CHITCHATS_CHECKOUT_ENABLED: "false",
    CHITCHATS_US_SHIPPING_ENABLED: "false",
    CHITCHATS_ENVIRONMENT: "staging",
    CHITCHATS_CLIENT_ID: "client-id",
    CHITCHATS_REGION: "ontario_manitoba",
    CHITCHATS_ACCESS_TOKEN: "access-token",
    CHITCHATS_QUOTE_SIGNING_SECRET: "quote-signing-secret-with-safe-length",
    CHITCHATS_WORKER_CRON_SECRET:
      "worker-cron-secret-with-at-least-32-random-bytes",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /requires CHITCHATS_ENVIRONMENT=production/,
  );
});

test("fails launch environment when Square service booking flag is blank", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SERVICE_BOOKING_SQUARE_ENABLED: "",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /SERVICE_BOOKING_SQUARE_ENABLED must be true or false/,
  );
});

test("validates preview mock payment environment without live payment credentials", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    PAYMENT_GATEWAY_MODE: "mock",
    PAYMENT_MOCK_DEFAULT_SCENARIO: "success",
  };

  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  const result = runValidator(env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Vercel preview environment validated/);
});

test("fails production environment when payment mock mode is enabled", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SANITY_DATASET: "production",
    PAYMENT_GATEWAY_MODE: "mock",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Payment mock mode is not allowed in production/,
  );
});

test("fails production launch environment with wrong dataset", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "production",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /NEXT_PUBLIC_SANITY_DATASET/);
  assert.match(result.combinedOutput, /expected production/);
  assert.doesNotMatch(result.combinedOutput, /staging-2026-05-10/);
});

test("fails launch environment missing a critical variable", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  };

  delete env.RESEND_API_KEY;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: RESEND_API_KEY/);
});

test("fails launch environment missing the Sanity API read token", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  };

  delete env.SANITY_API_READ_TOKEN;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SANITY_API_READ_TOKEN/);
});

test("fails launch environment missing the payment reconciliation cron secret", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  };

  delete env.PAYMENT_RECONCILIATION_CRON_SECRET;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("fails launch environment missing the Vercel cron secret", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  };

  delete env.CRON_SECRET;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: CRON_SECRET/);
});

test("fails launch environment when Square service booking URL does not use HTTPS", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SERVICE_BOOKING_SQUARE_ENABLED: "true",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "square-access-token",
    SQUARE_LOCATION_ID: "square-location-id",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "square-webhook-signature-key",
    SQUARE_SERVICE_BOOKING_RETURN_URL:
      "http://lashher.com/api/booking/square/return",
    SQUARE_SERVICE_BOOKING_WEBHOOK_URL:
      "https://lashher.com/api/webhooks/square",
  };

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /SQUARE_SERVICE_BOOKING_RETURN_URL must use https/,
  );
});

test("fails launch environment when Square service booking webhook URL does not use HTTPS", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SERVICE_BOOKING_SQUARE_ENABLED: "true",
    SQUARE_ENVIRONMENT: "sandbox",
    SQUARE_ACCESS_TOKEN: "square-access-token",
    SQUARE_LOCATION_ID: "square-location-id",
    SQUARE_WEBHOOK_SIGNATURE_KEY: "square-webhook-signature-key",
    SQUARE_SERVICE_BOOKING_RETURN_URL:
      "https://lashher.com/api/booking/square/return",
    SQUARE_SERVICE_BOOKING_WEBHOOK_URL:
      "http://lashher.com/api/webhooks/square",
  };

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /SQUARE_SERVICE_BOOKING_WEBHOOK_URL must use https/,
  );
});

test("treats whitespace-only launch variables as missing", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SANITY_WEBHOOK_SECRET: "   ",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SANITY_WEBHOOK_SECRET/);
});

test("fails malformed checkout encryption key", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    CHECKOUT_SECRET_ENCRYPTION_KEY: "not-base64",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /CHECKOUT_SECRET_ENCRYPTION_KEY/);
});

test("fails launch environment without Auth.js identity configuration", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
  };

  delete env.AUTH_SECRET;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: AUTH_SECRET/);
});

test("fails launch environment with a weak Auth.js secret", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    AUTH_SECRET: "too-short",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /AUTH_SECRET must be at least 32 bytes with at least 12 distinct characters/,
  );
});

test("fails launch environment with a repeated 32-byte Auth.js secret", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    AUTH_SECRET: "a".repeat(32),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /at least 12 distinct characters/);
});

test("fails launch environment with a low-diversity Auth.js secret", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    AUTH_SECRET: "abcd".repeat(8),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /at least 12 distinct characters/);
});

test("fails an unknown service booking model rollout mode", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SERVICE_BOOKING_MODEL_MODE: "automatic",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /SERVICE_BOOKING_MODEL_MODE/);
});

test("fails malformed booking calendar credential encryption key", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY: "not-base64",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY/,
  );
});

test("does not print secret values on failure", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    SANITY_WRITE_TOKEN: secretValue,
    GOOGLE_REDIRECT_URI: secretValue,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /GOOGLE_REDIRECT_URI/);
  assert.doesNotMatch(result.combinedOutput, new RegExp(secretValue));
});

function runValidator(
  env: Record<string, string>,
  cwd = mkdtempSync(join(tmpdir(), "lash-her-env-")),
) {
  const shouldRemoveCwd = arguments.length === 1;
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      ...env,
    },
    encoding: "utf8",
  });

  if (shouldRemoveCwd) {
    rmSync(cwd, { force: true, recursive: true });
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: `${result.stdout}${result.stderr}`,
  };
}

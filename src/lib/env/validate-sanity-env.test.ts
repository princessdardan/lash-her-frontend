import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = join(process.cwd(), "scripts/validate-sanity-env.mjs");
const checkoutKey = Buffer.alloc(32, 7).toString("base64");
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
  HELCIM_GENERAL_API_TOKEN: "helcim-general-api-token-with-safe-length",
  HELCIM_TRANSACTION_API_TOKEN: "helcim-transaction-api-token-with-safe-length",
  HELCIM_WEBHOOK_VERIFIER_TOKEN: "helcim-webhook-verifier-token",
  PAYMENT_RECONCILIATION_CRON_SECRET: "payment-reconciliation-cron-secret",
  CRON_SECRET: "vercel-cron-secret",
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

  delete env.HELCIM_GENERAL_API_TOKEN;
  delete env.HELCIM_TRANSACTION_API_TOKEN;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  const result = runValidator(env);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Vercel preview environment validated/);
});

test("fails preview live payment environment without Helcim credentials", () => {
  const env: Record<string, string> = {
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    PAYMENT_GATEWAY_MODE: "live",
  };

  delete env.HELCIM_GENERAL_API_TOKEN;
  delete env.HELCIM_TRANSACTION_API_TOKEN;

  const result = runValidator(env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: HELCIM_GENERAL_API_TOKEN/,
  );
  assert.match(
    result.combinedOutput,
    /Missing env var: HELCIM_TRANSACTION_API_TOKEN/,
  );
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

test("fails launch environment when Helcim token appears truncated", () => {
  const result = runValidator({
    ...launchEnv,
    VERCEL_ENV: "preview",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    HELCIM_TRANSACTION_API_TOKEN: "token-before-comment",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /HELCIM_TRANSACTION_API_TOKEN/);
  assert.match(result.combinedOutput, /appears truncated/);
  assert.match(
    result.combinedOutput,
    /wrap Helcim tokens that contain # in quotes/,
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

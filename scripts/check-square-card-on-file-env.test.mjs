import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const scriptPath = new URL("./check-square-card-on-file-env.mjs", import.meta.url).pathname;
const node = process.execPath;

const requiredVariables = [
  "SERVICE_BOOKING_SQUARE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
  "SQUARE_ENVIRONMENT",
  "SQUARE_APPLICATION_ID",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
  "SQUARE_SERVICE_BOOKING_RETURN_URL",
  "BOOKING_ADMIN_PAYMENT_ACTION_SECRET",
  "CRON_SECRET",
  "PAYMENT_RECONCILIATION_CRON_SECRET",
  "DATABASE_URL",
];

const validEnv = {
  SERVICE_BOOKING_SQUARE_ENABLED: "true",
  SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED: "true",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_APPLICATION_ID: "sandbox-sq0idb-test-application-id",
  SQUARE_ACCESS_TOKEN: "test-access-token",
  SQUARE_LOCATION_ID: "test-location-id",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "test-webhook-signature-key",
  SQUARE_SERVICE_BOOKING_WEBHOOK_URL: "https://example.com/api/webhooks/square",
  SQUARE_SERVICE_BOOKING_RETURN_URL: "https://example.com/booking/card-on-file/callback",
  BOOKING_ADMIN_PAYMENT_ACTION_SECRET: "test-admin-secret",
  CRON_SECRET: "test-cron-secret",
  PAYMENT_RECONCILIATION_CRON_SECRET: "test-reconciliation-cron-secret",
  DATABASE_URL: "postgres://test:test@localhost:5432/test",
  PAYMENT_GATEWAY_MODE: "live",
};

function run(env) {
  return spawnSync(node, [scriptPath], {
    cwd: new URL("..", import.meta.url).pathname,
    env,
    encoding: "utf8",
  });
}

describe("check-square-card-on-file-env", () => {
  it("fails and lists names of missing required variables", () => {
    const result = run({});

    assert.notEqual(result.status, 0, "expected non-zero exit code");
    const output = result.stderr + result.stdout;

    for (const name of requiredVariables) {
      assert.match(output, new RegExp(`\\b${name}\\b`), `missing variable ${name} should be listed`);
    }
  });

  it("does not leak secret values when listing missing variables", () => {
    const result = run({});
    const output = result.stderr + result.stdout;

    assert.doesNotMatch(output, /test-access-token/);
    assert.doesNotMatch(output, /test-webhook-signature-key/);
    assert.doesNotMatch(output, /test-admin-secret/);
    assert.doesNotMatch(output, /test-cron-secret/);
    assert.doesNotMatch(output, /test-reconciliation-cron-secret/);
  });

  it("fails when SQUARE_ENVIRONMENT is not sandbox or production", () => {
    const result = run({ ...validEnv, SQUARE_ENVIRONMENT: "staging" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SQUARE_ENVIRONMENT must be sandbox or production/);
  });

  it("fails when production Vercel environment is paired with sandbox Square credentials", () => {
    const result = run({ ...validEnv, VERCEL_ENV: "production", SQUARE_ENVIRONMENT: "sandbox" });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr + result.stdout,
      /Production Vercel environment must use Square production credentials/
    );
  });

  it("succeeds when all required variables are present and consistent", () => {
    const result = run(validEnv);

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Required environment variables are present/);
  });

  it("does not echo secret values on success", () => {
    const result = run(validEnv);
    const output = result.stdout + result.stderr;

    assert.doesNotMatch(output, /test-access-token/);
    assert.doesNotMatch(output, /test-webhook-signature-key/);
    assert.doesNotMatch(output, /test-admin-secret/);
    assert.doesNotMatch(output, /test-cron-secret/);
    assert.doesNotMatch(output, /test-reconciliation-cron-secret/);
  });

  it("fails when SERVICE_BOOKING_SQUARE_ENABLED is not exactly true", () => {
    const result = run({ ...validEnv, SERVICE_BOOKING_SQUARE_ENABLED: "yes" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SERVICE_BOOKING_SQUARE_ENABLED must be exactly "true"/);
  });

  it("fails when SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED is not exactly true", () => {
    const result = run({ ...validEnv, SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED: "1" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED must be exactly "true"/);
  });

  it("fails when PAYMENT_GATEWAY_MODE is mock in a production Vercel environment", () => {
    const result = run({ ...validEnv, VERCEL_ENV: "production", PAYMENT_GATEWAY_MODE: "mock" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /PAYMENT_GATEWAY_MODE=mock is not allowed in production/);
  });

  it("fails when preview Vercel environment uses Square production credentials", () => {
    const result = run({ ...validEnv, VERCEL_ENV: "preview", SQUARE_ENVIRONMENT: "production" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /preview.*must use Square sandbox credentials/i);
  });

  it("fails when SQUARE_SERVICE_BOOKING_WEBHOOK_URL is malformed", () => {
    const result = run({ ...validEnv, SQUARE_SERVICE_BOOKING_WEBHOOK_URL: "not-a-url" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SQUARE_SERVICE_BOOKING_WEBHOOK_URL must be a valid URL/);
  });

  it("fails when SQUARE_SERVICE_BOOKING_RETURN_URL is malformed", () => {
    const result = run({ ...validEnv, SQUARE_SERVICE_BOOKING_RETURN_URL: "///bad" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SQUARE_SERVICE_BOOKING_RETURN_URL must be a valid URL/);
  });

  it("does not leak secret URL values when reporting malformed URLs", () => {
    const result = run({
      ...validEnv,
      SQUARE_SERVICE_BOOKING_WEBHOOK_URL: "://bad?token=supersecrettoken",
    });
    const output = result.stdout + result.stderr;

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(output, /supersecrettoken/);
  });

  it("fails when SQUARE_SERVICE_BOOKING_WEBHOOK_URL does not use https", () => {
    const result = run({ ...validEnv, SQUARE_SERVICE_BOOKING_WEBHOOK_URL: "http://example.com/api/webhooks/square" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SQUARE_SERVICE_BOOKING_WEBHOOK_URL must use https/);
  });

  it("fails when SQUARE_SERVICE_BOOKING_RETURN_URL does not use https", () => {
    const result = run({ ...validEnv, SQUARE_SERVICE_BOOKING_RETURN_URL: "javascript:alert(1)" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /SQUARE_SERVICE_BOOKING_RETURN_URL must use https/);
  });

  it("fails when PAYMENT_RECONCILIATION_CRON_SECRET is missing", () => {
    const env = { ...validEnv };
    delete env.PAYMENT_RECONCILIATION_CRON_SECRET;
    const result = run(env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /\bPAYMENT_RECONCILIATION_CRON_SECRET\b/);
  });

  it("fails when CRON_SECRET is missing", () => {
    const env = { ...validEnv };
    delete env.CRON_SECRET;
    const result = run(env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /\bCRON_SECRET\b/);
  });

  it("does not treat CRON_SECRET as a substitute for PAYMENT_RECONCILIATION_CRON_SECRET", () => {
    const env = { ...validEnv, CRON_SECRET: "test-cron-secret" };
    delete env.PAYMENT_RECONCILIATION_CRON_SECRET;
    const result = run(env);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /\bPAYMENT_RECONCILIATION_CRON_SECRET\b/);
  });

  it("succeeds with PAYMENT_RECONCILIATION_CRON_SECRET and does not echo it", () => {
    const result = run(validEnv);

    assert.equal(result.status, 0);
    assert.match(result.stdout + result.stderr, /Required environment variables are present/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-reconciliation-cron-secret/);
  });
});

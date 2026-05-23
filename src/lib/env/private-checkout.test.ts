import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const disabledSquareScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getCheckoutDatabaseUrl,
    getSquareServiceBookingEnv,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getCheckoutDatabaseUrl(), "postgres://neon-pooled-url");
  assert.equal(getSquareServiceBookingEnv(), null);
`;

const enabledSquareScript = String.raw`
  import { getSquareServiceBookingEnv } from "./src/lib/env/private-checkout.ts";

  getSquareServiceBookingEnv();
`;

test("square service booking stays disabled without Square secrets", () => {
  const env = { ...process.env };

  env.DATABASE_URL = "postgres://neon-pooled-url";
  delete env.SERVICE_BOOKING_SQUARE_ENABLED;
  delete env.SQUARE_ENVIRONMENT;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  const result = runTsx(disabledSquareScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square service booking requires secrets when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_LOCATION_ID = "square-location-id";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "square-webhook-signature-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL = "https://lashher.example/booking/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL = "https://lashher.example/api/booking/webhook";
  env.DATABASE_URL = "postgres://neon-pooled-url";
  delete env.SQUARE_ACCESS_TOKEN;

  const result = runTsx(enabledSquareScript, env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SQUARE_ACCESS_TOKEN/);
});

test("square service booking rejects blank required values when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_ACCESS_TOKEN = "   ";
  env.SQUARE_LOCATION_ID = "square-location-id";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "square-webhook-signature-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL = "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL = "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(enabledSquareScript, env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SQUARE_ACCESS_TOKEN/);
});

test("square service booking rejects blank square location id when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_ACCESS_TOKEN = "square-access-token";
  env.SQUARE_LOCATION_ID = "";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "square-webhook-signature-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL = "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL = "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(enabledSquareScript, env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SQUARE_LOCATION_ID/);
});

function runTsx(
  script: string,
  env: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  combinedOutput: string;
} {
  const result = spawnSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", script],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combinedOutput: `${result.stdout}${result.stderr}`,
  };
}

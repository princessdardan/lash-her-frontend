import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const disabledSquareScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getCheckoutDatabaseUrl,
    getPaymentGatewayMode,
    getSquareServiceBookingEnv,
    isPaymentMockMode,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getCheckoutDatabaseUrl(), "postgres://neon-pooled-url");
  assert.equal(getPaymentGatewayMode(), "mock");
  assert.equal(isPaymentMockMode(), true);
  assert.equal(getSquareServiceBookingEnv(), null);
`;

const liveModeScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getPaymentGatewayMode,
    isPaymentMockMode,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getPaymentGatewayMode(), "live");
  assert.equal(isPaymentMockMode(), false);
`;

const mockModeScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getPaymentGatewayMode,
    isPaymentMockMode,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getPaymentGatewayMode(), "mock");
  assert.equal(isPaymentMockMode(), true);
`;

const trainingAfterpaySquareInvoiceEnabledScript = String.raw`
  import assert from "node:assert/strict";

  import {
    isTrainingAfterpaySquareInvoiceEnabled,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(isTrainingAfterpaySquareInvoiceEnabled(), EXPECTED_VALUE);
`;

const enabledSquareScript = String.raw`
  import { getSquareServiceBookingEnv } from "./src/lib/env/private-checkout.ts";

  getSquareServiceBookingEnv();
`;

const paymentReconciliationCronSecretScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getPaymentReconciliationCronSecret,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getPaymentReconciliationCronSecret(), EXPECTED_VALUE);
`;

const paymentReconciliationCronSecretsScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getPaymentReconciliationCronSecrets,
  } from "./src/lib/env/private-checkout.ts";

  assert.deepEqual(getPaymentReconciliationCronSecrets(), EXPECTED_VALUE);
`;

const cardOnFileEnabledScript = String.raw`
  import assert from "node:assert/strict";

  import {
    isSquareCardOnFileServiceBookingEnabled,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(isSquareCardOnFileServiceBookingEnabled(), EXPECTED_VALUE);
`;

const localInvoiceFallbackEnabledScript = String.raw`
  import assert from "node:assert/strict";

  import {
    isSquareCardOnFileServiceBookingLocalInvoiceFallbackEnabled,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(isSquareCardOnFileServiceBookingLocalInvoiceFallbackEnabled(), EXPECTED_VALUE);
`;

const cardOnFileConfigScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getSquareCardOnFileServiceBookingConfig,
  } from "./src/lib/env/private-checkout.ts";

  const config = getSquareCardOnFileServiceBookingConfig();
  EXPECTED_ASSERTIONS
`;

const bookingAdminPaymentActionSecretScript = String.raw`
  import assert from "node:assert/strict";

  import {
    getBookingAdminPaymentActionSecret,
  } from "./src/lib/env/private-checkout.ts";

  assert.equal(getBookingAdminPaymentActionSecret(), EXPECTED_VALUE);
`;

test("square service booking stays disabled without Square secrets", () => {
  const env = { ...process.env };

  env.DATABASE_URL = "postgres://neon-pooled-url";
  env.PAYMENT_GATEWAY_MODE = "mock";
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

test("payment mock mode is server-checkable without live Helcim or Square credentials", () => {
  const env = { ...process.env };

  env.PAYMENT_GATEWAY_MODE = "mock";
  delete env.HELCIM_GENERAL_API_TOKEN;
  delete env.HELCIM_TRANSACTION_API_TOKEN;
  delete env.SERVICE_BOOKING_SQUARE_ENABLED;
  delete env.SQUARE_ENVIRONMENT;
  delete env.SQUARE_ACCESS_TOKEN;
  delete env.SQUARE_LOCATION_ID;
  delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  delete env.SQUARE_SERVICE_BOOKING_RETURN_URL;
  delete env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL;

  const result = runTsx(mockModeScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment mock mode is rejected in production before provider selection", () => {
  const env = { ...process.env };

  env.NODE_ENV = "production";
  env.PAYMENT_GATEWAY_MODE = "mock";

  const result = runTsx(liveModeScript, env);

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Payment mock mode is not allowed in production/,
  );
});

test("payment live mode remains server-checkable as the default", () => {
  const env = { ...process.env };

  delete env.PAYMENT_GATEWAY_MODE;

  const result = runTsx(liveModeScript, env);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("training afterpay square invoice flag defaults to disabled when absent", () => {
  const env = { ...process.env };

  delete env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED;

  const result = runTsx(
    trainingAfterpaySquareInvoiceEnabledScript.replace(
      "EXPECTED_VALUE",
      "false",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("training afterpay square invoice flag enables only for exact true", () => {
  const env = { ...process.env };

  env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED = "true";

  const result = runTsx(
    trainingAfterpaySquareInvoiceEnabledScript.replace(
      "EXPECTED_VALUE",
      "true",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("training afterpay square invoice flag stays false for non-true strings", () => {
  const env = { ...process.env };

  env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED = "yes";

  const result = runTsx(
    trainingAfterpaySquareInvoiceEnabledScript.replace(
      "EXPECTED_VALUE",
      "false",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square service booking requires secrets when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_LOCATION_ID = "square-location-id";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "square-webhook-signature-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/booking/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/booking/webhook";
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
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
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
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(enabledSquareScript, env);

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SQUARE_LOCATION_ID/);
});

test("payment reconciliation cron secret throws when route-specific secret is absent", () => {
  const env = { ...process.env };

  delete env.PAYMENT_RECONCILIATION_CRON_SECRET;

  const result = runTsx(
    paymentReconciliationCronSecretScript.replace("EXPECTED_VALUE", "null"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("payment reconciliation cron secret throws when route-specific secret is blank", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "   ";

  const result = runTsx(
    paymentReconciliationCronSecretScript.replace("EXPECTED_VALUE", "null"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("payment reconciliation cron secret returns trimmed route-specific secret when set", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "  route-secret  ";

  const result = runTsx(
    paymentReconciliationCronSecretScript.replace(
      "EXPECTED_VALUE",
      '"route-secret"',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment reconciliation cron secret returns route-specific secret when CRON_SECRET is also set", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "route-secret";
  env.CRON_SECRET = "cron-secret";

  const result = runTsx(
    paymentReconciliationCronSecretScript.replace(
      "EXPECTED_VALUE",
      '"route-secret"',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment reconciliation cron secret throws when only CRON_SECRET is set", () => {
  const env = { ...process.env };

  delete env.PAYMENT_RECONCILIATION_CRON_SECRET;
  env.CRON_SECRET = "cron-secret";

  const result = runTsx(
    paymentReconciliationCronSecretScript.replace("EXPECTED_VALUE", "null"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("payment reconciliation cron secrets throws when route-specific secret is absent", () => {
  const env = { ...process.env };

  delete env.PAYMENT_RECONCILIATION_CRON_SECRET;

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace("EXPECTED_VALUE", "[]"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("payment reconciliation cron secrets throws when route-specific secret is blank", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "   ";

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace("EXPECTED_VALUE", "[]"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("payment reconciliation cron secrets returns trimmed route-specific secret when set", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "  route-secret  ";

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace(
      "EXPECTED_VALUE",
      '["route-secret"]',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment reconciliation cron secrets returns both route-specific and CRON_SECRET when both are set", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "route-secret";
  env.CRON_SECRET = "cron-secret";

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace(
      "EXPECTED_VALUE",
      '["route-secret","cron-secret"]',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment reconciliation cron secrets ignores blank CRON_SECRET", () => {
  const env = { ...process.env };

  env.PAYMENT_RECONCILIATION_CRON_SECRET = "route-secret";
  env.CRON_SECRET = "   ";

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace(
      "EXPECTED_VALUE",
      '["route-secret"]',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("payment reconciliation cron secrets throws when only CRON_SECRET is set", () => {
  const env = { ...process.env };

  delete env.PAYMENT_RECONCILIATION_CRON_SECRET;
  env.CRON_SECRET = "cron-secret";

  const result = runTsx(
    paymentReconciliationCronSecretsScript.replace("EXPECTED_VALUE", "[]"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET/,
  );
});

test("square card-on-file service booking defaults to disabled when absent", () => {
  const env = { ...process.env };

  delete env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED;

  const result = runTsx(
    cardOnFileEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file service booking enables only for exact true", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";

  const result = runTsx(
    cardOnFileEnabledScript.replace("EXPECTED_VALUE", "true"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file service booking stays false for non-true strings", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "yes";

  const result = runTsx(
    cardOnFileEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback defaults to disabled when absent", () => {
  const env = { ...process.env };

  delete env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED;

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback enables only for exact true", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED =
    "true";

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "true"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback stays false for non-true strings", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED =
    "yes";

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback is disabled when VERCEL_ENV is production", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED =
    "true";
  env.VERCEL_ENV = "production";

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback is disabled when Square environment is production", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED =
    "true";
  env.SQUARE_ENVIRONMENT = "production";

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "false"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file local invoice fallback remains enabled in local development", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED =
    "true";
  env.VERCEL_ENV = "development";
  env.SQUARE_ENVIRONMENT = "sandbox";

  const result = runTsx(
    localInvoiceFallbackEnabledScript.replace("EXPECTED_VALUE", "true"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file config returns null when disabled without requiring application id", () => {
  const env = { ...process.env };

  delete env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED;
  delete env.SQUARE_APPLICATION_ID;
  delete env.SQUARE_ENVIRONMENT;
  delete env.SQUARE_LOCATION_ID;

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      "assert.equal(config, null);",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("card-on-file config is unavailable when card flag is true but service booking Square is disabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  delete env.SERVICE_BOOKING_SQUARE_ENABLED;
  delete env.SQUARE_APPLICATION_ID;
  delete env.SQUARE_ENVIRONMENT;
  delete env.SQUARE_LOCATION_ID;

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      "assert.equal(config, null);",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("card-on-file config returns null when Square is ready but DATABASE_URL is missing", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_LOCATION_ID = "LOC123";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  delete env.DATABASE_URL;

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      "assert.equal(config, null);",
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("card-on-file config returns public values when both card and service flags are enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_LOCATION_ID = "LOC123";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      `
        assert.deepEqual(config, {
          applicationId: "sandbox-sq0idb-test",
          environment: "sandbox",
          locationId: "LOC123",
        });
        const configText = JSON.stringify(config);
        assert.ok(!configText.includes("secret-access-token"));
        assert.ok(!configText.includes("secret-webhook-key"));
      `,
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("square card-on-file config requires application id when enabled", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_LOCATION_ID = "square-location-id";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";
  delete env.SQUARE_APPLICATION_ID;

  const result = runTsx(
    cardOnFileConfigScript.replace("EXPECTED_ASSERTIONS", ""),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.combinedOutput, /Missing env var: SQUARE_APPLICATION_ID/);
});

test("square card-on-file config returns public Square values and omits secrets", () => {
  const env = { ...process.env };

  env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED = "true";
  env.SERVICE_BOOKING_SQUARE_ENABLED = "true";
  env.SQUARE_ENVIRONMENT = "sandbox";
  env.SQUARE_APPLICATION_ID = "sandbox-sq0idb-test";
  env.SQUARE_LOCATION_ID = "LOC123";
  env.SQUARE_ACCESS_TOKEN = "secret-access-token";
  env.SQUARE_WEBHOOK_SIGNATURE_KEY = "secret-webhook-key";
  env.SQUARE_SERVICE_BOOKING_RETURN_URL =
    "https://lashher.example/api/booking/square/return";
  env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL =
    "https://lashher.example/api/webhooks/square";
  env.DATABASE_URL = "postgres://neon-pooled-url";

  const result = runTsx(
    cardOnFileConfigScript.replace(
      "EXPECTED_ASSERTIONS",
      `
        assert.deepEqual(config, {
          applicationId: "sandbox-sq0idb-test",
          environment: "sandbox",
          locationId: "LOC123",
        });
        const configText = JSON.stringify(config);
        assert.ok(!configText.includes("secret-access-token"));
        assert.ok(!configText.includes("secret-webhook-key"));
      `,
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("booking admin payment action secret returns null when absent", () => {
  const env = { ...process.env };

  delete env.BOOKING_ADMIN_PAYMENT_ACTION_SECRET;

  const result = runTsx(
    bookingAdminPaymentActionSecretScript.replace("EXPECTED_VALUE", "null"),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("booking admin payment action secret throws when blank", () => {
  const env = { ...process.env };

  env.BOOKING_ADMIN_PAYMENT_ACTION_SECRET = "   ";

  const result = runTsx(
    bookingAdminPaymentActionSecretScript.replace("EXPECTED_VALUE", "null"),
    env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.combinedOutput,
    /Missing env var: BOOKING_ADMIN_PAYMENT_ACTION_SECRET/,
  );
});

test("booking admin payment action secret returns trimmed value when set", () => {
  const env = { ...process.env };

  env.BOOKING_ADMIN_PAYMENT_ACTION_SECRET = "  admin-payment-secret  ";

  const result = runTsx(
    bookingAdminPaymentActionSecretScript.replace(
      "EXPECTED_VALUE",
      '"admin-payment-secret"',
    ),
    env,
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
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

import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const expectedDatasets = {
  production: "production",
  preview: "staging-2026-05-10",
};

const publicSanityEnvVars = [
  "NEXT_PUBLIC_SANITY_PROJECT_ID",
  "NEXT_PUBLIC_SANITY_DATASET",
  "NEXT_PUBLIC_SANITY_API_VERSION",
];

const launchEnvVars = [
  "SANITY_API_READ_TOKEN",
  "SANITY_WRITE_TOKEN",
  "SANITY_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "FROM_EMAIL",
  "ADMIN_EMAIL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "BOOKING_ADMIN_SETUP_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "DATABASE_URL",
  "CHECKOUT_SECRET_ENCRYPTION_KEY",
  "HELCIM_GENERAL_API_TOKEN",
  "HELCIM_TRANSACTION_API_TOKEN",
  "HELCIM_WEBHOOK_VERIFIER_TOKEN",
];

const squareLaunchEnvVars = [
  "SQUARE_ENVIRONMENT",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_SERVICE_BOOKING_RETURN_URL",
  "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
];

const urlEnvVars = [
  "GOOGLE_REDIRECT_URI",
  "KV_REST_API_URL",
  "DATABASE_URL",
];

const emailEnvVars = ["FROM_EMAIL", "ADMIN_EMAIL"];

const vercelEnv = process.env.VERCEL_ENV;
const expectedDataset = expectedDatasets[vercelEnv];
const isLaunchEnvironment = expectedDataset !== undefined;
const paymentGatewayMode = process.env.PAYMENT_GATEWAY_MODE ?? "live";
const isPaymentMockMode = paymentGatewayMode === "mock";
const serviceBookingSquareEnabled = process.env.SERVICE_BOOKING_SQUARE_ENABLED;
const isSquareServiceBookingEnabled =
  serviceBookingSquareEnabled === "true";
const requiredEnvVars = isLaunchEnvironment
  ? [
      ...publicSanityEnvVars,
      ...(isPaymentMockMode ? launchEnvVarsWithoutLivePayment() : launchEnvVars),
      ...(isSquareServiceBookingEnabled && !isPaymentMockMode ? squareLaunchEnvVars : []),
    ]
  : publicSanityEnvVars;

const errors = [];

for (const name of requiredEnvVars) {
  if (!hasValue(process.env[name])) {
    errors.push(`Missing env var: ${name}`);
  }
}

if (hasValue(process.env.NEXT_PUBLIC_SANITY_PROJECT_ID)) {
  validateProjectId(process.env.NEXT_PUBLIC_SANITY_PROJECT_ID);
}

if (hasValue(process.env.NEXT_PUBLIC_SANITY_API_VERSION)) {
  validateApiVersion(process.env.NEXT_PUBLIC_SANITY_API_VERSION);
}

if (expectedDataset && process.env.NEXT_PUBLIC_SANITY_DATASET !== expectedDataset) {
  errors.push(
    `Invalid env var: NEXT_PUBLIC_SANITY_DATASET for Vercel ${vercelEnv}; expected ${expectedDataset}`
  );
}

if (paymentGatewayMode !== "live" && paymentGatewayMode !== "mock") {
  errors.push("Malformed env var: PAYMENT_GATEWAY_MODE must be live or mock");
}

if (
  serviceBookingSquareEnabled !== undefined
  && serviceBookingSquareEnabled !== "true"
  && serviceBookingSquareEnabled !== "false"
) {
  errors.push("Malformed env var: SERVICE_BOOKING_SQUARE_ENABLED must be true or false");
}

if (isPaymentMockMode && (process.env.NODE_ENV === "production" || vercelEnv === "production")) {
  errors.push("Payment mock mode is not allowed in production");
}

if (isLaunchEnvironment) {
  for (const name of urlEnvVars) {
    if (hasValue(process.env[name])) {
      validateUrl(name, process.env[name]);
    }
  }

  for (const name of emailEnvVars) {
    if (hasValue(process.env[name])) {
      validateEmail(name, process.env[name]);
    }
  }

  if (hasValue(process.env.CHECKOUT_SECRET_ENCRYPTION_KEY)) {
    validateCheckoutSecretEncryptionKey(process.env.CHECKOUT_SECRET_ENCRYPTION_KEY);
  }

  for (const name of ["HELCIM_GENERAL_API_TOKEN", "HELCIM_TRANSACTION_API_TOKEN"]) {
    if (hasValue(process.env[name])) {
      validateHelcimApiToken(name, process.env[name]);
    }
  }

  if (isSquareServiceBookingEnabled) {
    validateSquareEnvironment(process.env.SQUARE_ENVIRONMENT);

    for (const name of [
      "SQUARE_SERVICE_BOOKING_RETURN_URL",
      "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
    ]) {
      if (hasValue(process.env[name])) {
        validateUrl(name, process.env[name]);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`[sanity-env] Environment validation failed:\n${errors.join("\n")}`);
  process.exit(1);
}

console.log(
  vercelEnv
    ? `[sanity-env] Vercel ${vercelEnv} environment validated`
    : "[sanity-env] Local environment validated"
);

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProjectId(value) {
  if (value !== "3auncj84") {
    errors.push("Malformed env var: NEXT_PUBLIC_SANITY_PROJECT_ID must match launch project ID");
  }
}

function validateApiVersion(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push("Malformed env var: NEXT_PUBLIC_SANITY_API_VERSION must use YYYY-MM-DD");
  }
}

function validateUrl(name, value) {
  try {
    new URL(value);
  } catch {
    errors.push(`Malformed env var: ${name} must be a valid URL`);
  }
}

function validateEmail(name, value) {
  if (!value.includes("@")) {
    errors.push(`Malformed env var: ${name} must include @`);
  }
}

function validateCheckoutSecretEncryptionKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    errors.push(
      "Malformed env var: CHECKOUT_SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes"
    );
    return;
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32 || key.toString("base64") !== value) {
    errors.push(
      "Malformed env var: CHECKOUT_SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes"
    );
  }
}

function validateHelcimApiToken(name, value) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    errors.push(`Missing env var: ${name}`);
    return;
  }

  if (/\s/.test(trimmed)) {
    errors.push(`Malformed env var: ${name} must not contain whitespace`);
    return;
  }

  if (trimmed.length < 32) {
    errors.push(
      `Malformed env var: ${name} appears truncated; wrap Helcim tokens that contain # in quotes`
    );
  }
}

function validateSquareEnvironment(value) {
  if (value !== "sandbox" && value !== "production") {
    errors.push(
      "Malformed env var: SQUARE_ENVIRONMENT must be sandbox or production"
    );
  }
}

function launchEnvVarsWithoutLivePayment() {
  return launchEnvVars.filter(
    (name) => name !== "HELCIM_GENERAL_API_TOKEN"
      && name !== "HELCIM_TRANSACTION_API_TOKEN"
      && name !== "HELCIM_WEBHOOK_VERIFIER_TOKEN"
  );
}

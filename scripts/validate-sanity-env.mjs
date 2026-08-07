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
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "ADMIN_OWNER_EMAILS",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "RESEND_SEGMENT_MARKETING_ID",
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
  "BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
  "SERVICE_BOOKING_MODEL_MODE",
  "HELCIM_GENERAL_API_TOKEN",
  "HELCIM_TRANSACTION_API_TOKEN",
  "HELCIM_WEBHOOK_VERIFIER_TOKEN",
  "PAYMENT_RECONCILIATION_CRON_SECRET",
  "CRON_SECRET",
];

const squareLaunchEnvVars = [
  "SQUARE_ENVIRONMENT",
  "SQUARE_ACCESS_TOKEN",
  "SQUARE_LOCATION_ID",
  "SQUARE_WEBHOOK_SIGNATURE_KEY",
  "SQUARE_SERVICE_BOOKING_RETURN_URL",
  "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
];

const urlEnvVars = ["GOOGLE_REDIRECT_URI", "KV_REST_API_URL", "DATABASE_URL"];

const emailEnvVars = ["FROM_EMAIL", "ADMIN_EMAIL"];

const vercelEnv = process.env.VERCEL_ENV;
const expectedDataset = expectedDatasets[vercelEnv];
const isLaunchEnvironment = expectedDataset !== undefined;
const paymentGatewayMode = process.env.PAYMENT_GATEWAY_MODE ?? "live";
const isPaymentMockMode = paymentGatewayMode === "mock";
const serviceBookingSquareEnabled = process.env.SERVICE_BOOKING_SQUARE_ENABLED;
const serviceBookingModelMode =
  process.env.SERVICE_BOOKING_MODEL_MODE ?? "dual";
const isSquareServiceBookingEnabled = serviceBookingSquareEnabled === "true";
const academyEnabled = process.env.ACADEMY_ENABLED;
const courseCheckoutEnabled = process.env.COURSE_CHECKOUT_ENABLED;
const courseEntitlementWorkerEnabled =
  process.env.COURSE_ENTITLEMENT_WORKER_ENABLED;
const requiredEnvVars = isLaunchEnvironment
  ? [
      ...publicSanityEnvVars,
      ...(isPaymentMockMode
        ? launchEnvVarsWithoutLivePayment()
        : launchEnvVars),
      ...(isSquareServiceBookingEnabled && !isPaymentMockMode
        ? squareLaunchEnvVars
        : []),
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

if (
  expectedDataset &&
  process.env.NEXT_PUBLIC_SANITY_DATASET !== expectedDataset
) {
  errors.push(
    `Invalid env var: NEXT_PUBLIC_SANITY_DATASET for Vercel ${vercelEnv}; expected ${expectedDataset}`,
  );
}

if (paymentGatewayMode !== "live" && paymentGatewayMode !== "mock") {
  errors.push("Malformed env var: PAYMENT_GATEWAY_MODE must be live or mock");
}

if (
  serviceBookingModelMode !== "legacy" &&
  serviceBookingModelMode !== "dual" &&
  serviceBookingModelMode !== "operational"
) {
  errors.push(
    "Malformed env var: SERVICE_BOOKING_MODEL_MODE must be legacy, dual, or operational",
  );
}

if (
  serviceBookingSquareEnabled !== undefined &&
  serviceBookingSquareEnabled !== "true" &&
  serviceBookingSquareEnabled !== "false"
) {
  errors.push(
    "Malformed env var: SERVICE_BOOKING_SQUARE_ENABLED must be true or false",
  );
}

validateOptionalBoolean("ACADEMY_ENABLED", academyEnabled);
validateOptionalBoolean("COURSE_CHECKOUT_ENABLED", courseCheckoutEnabled);
validateOptionalBoolean(
  "COURSE_ENTITLEMENT_WORKER_ENABLED",
  courseEntitlementWorkerEnabled,
);

if (academyEnabled === "true") {
  const courseApiEnvVars = [
    "COURSE_API_BASE_URL",
    "COURSE_API_USER_JWT_SECRET",
    "COURSE_API_USER_JWT_ISSUER",
    "COURSE_API_USER_JWT_AUDIENCE",
    "COURSE_API_SERVICE_JWT_SECRET",
    "COURSE_API_SERVICE_JWT_ISSUER",
    "COURSE_API_SERVICE_JWT_AUDIENCE",
    "COURSE_API_SERVICE_JWT_SUBJECT",
  ];

  for (const name of courseApiEnvVars) {
    if (!hasValue(process.env[name])) {
      errors.push(`Missing env var: ${name}`);
    }
  }

  if (hasValue(process.env.COURSE_API_BASE_URL)) {
    validateCourseApiUrl(process.env.COURSE_API_BASE_URL);
  }

  for (const name of [
    "COURSE_API_USER_JWT_SECRET",
    "COURSE_API_SERVICE_JWT_SECRET",
  ]) {
    if (hasValue(process.env[name]) && process.env[name].length < 32) {
      errors.push(`Malformed env var: ${name} must be at least 32 characters`);
    }
  }

  const courseSecrets = [
    process.env.AUTH_SECRET,
    process.env.COURSE_API_USER_JWT_SECRET,
    process.env.COURSE_API_SERVICE_JWT_SECRET,
  ].filter(hasValue);
  if (new Set(courseSecrets).size !== courseSecrets.length) {
    errors.push(
      "Malformed env vars: Auth.js, course user, and course service secrets must be distinct",
    );
  }
}

if (courseEntitlementWorkerEnabled === "true") {
  if (academyEnabled !== "true") {
    errors.push(
      "Invalid env var: COURSE_ENTITLEMENT_WORKER_ENABLED requires ACADEMY_ENABLED=true",
    );
  }
  if (!hasValue(process.env.COURSE_ENTITLEMENT_CRON_SECRET)) {
    errors.push("Missing env var: COURSE_ENTITLEMENT_CRON_SECRET");
  } else {
    const entitlementCronSecret = process.env.COURSE_ENTITLEMENT_CRON_SECRET;
    if (
      entitlementCronSecret !== entitlementCronSecret.trim() ||
      entitlementCronSecret.length < 32
    ) {
      errors.push(
        "Malformed env var: COURSE_ENTITLEMENT_CRON_SECRET must be at least 32 characters without surrounding whitespace",
      );
    }

    const otherSecrets = [
      process.env.AUTH_SECRET,
      process.env.COURSE_API_USER_JWT_SECRET,
      process.env.COURSE_API_SERVICE_JWT_SECRET,
      process.env.CRON_SECRET,
    ].filter(hasValue);
    if (otherSecrets.includes(entitlementCronSecret)) {
      errors.push(
        "Malformed env var: COURSE_ENTITLEMENT_CRON_SECRET must be distinct from Auth.js, course JWT, and shared cron secrets",
      );
    }
  }
}

if (courseCheckoutEnabled === "true" && academyEnabled !== "true") {
  errors.push(
    "Invalid env var: COURSE_CHECKOUT_ENABLED requires ACADEMY_ENABLED=true",
  );
}

if (
  isPaymentMockMode &&
  (process.env.NODE_ENV === "production" || vercelEnv === "production")
) {
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
    validateBase64EncryptionKey(
      "CHECKOUT_SECRET_ENCRYPTION_KEY",
      process.env.CHECKOUT_SECRET_ENCRYPTION_KEY,
    );
  }

  if (hasValue(process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY)) {
    validateBase64EncryptionKey(
      "BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY",
      process.env.BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY,
    );
  }

  if (hasValue(process.env.ADMIN_OWNER_EMAILS)) {
    validateEmailList("ADMIN_OWNER_EMAILS", process.env.ADMIN_OWNER_EMAILS);
  }

  if (
    hasValue(process.env.AUTH_SECRET) &&
    process.env.AUTH_SECRET.trim().length < 32
  ) {
    errors.push(
      "Malformed env var: AUTH_SECRET must be at least 32 characters",
    );
  }

  for (const name of [
    "HELCIM_GENERAL_API_TOKEN",
    "HELCIM_TRANSACTION_API_TOKEN",
  ]) {
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
        validateHttpsUrl(name, process.env[name]);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(
    `[sanity-env] Environment validation failed:\n${errors.join("\n")}`,
  );
  process.exit(1);
}

console.log(
  vercelEnv
    ? `[sanity-env] Vercel ${vercelEnv} environment validated`
    : "[sanity-env] Local environment validated",
);

function hasValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProjectId(value) {
  if (value !== "3auncj84") {
    errors.push(
      "Malformed env var: NEXT_PUBLIC_SANITY_PROJECT_ID must match launch project ID",
    );
  }
}

function validateApiVersion(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(
      "Malformed env var: NEXT_PUBLIC_SANITY_API_VERSION must use YYYY-MM-DD",
    );
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

function validateBase64EncryptionKey(name, value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    errors.push(`Malformed env var: ${name} must be base64-encoded 32 bytes`);
    return;
  }

  const key = Buffer.from(value, "base64");

  if (key.length !== 32 || key.toString("base64") !== value) {
    errors.push(`Malformed env var: ${name} must be base64-encoded 32 bytes`);
  }
}

function validateEmailList(name, value) {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0 || entries.some((entry) => !entry.includes("@"))) {
    errors.push(
      `Malformed env var: ${name} must be a comma-separated email list`,
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
      `Malformed env var: ${name} appears truncated; wrap Helcim tokens that contain # in quotes`,
    );
  }
}

function validateSquareEnvironment(value) {
  if (value !== "sandbox" && value !== "production") {
    errors.push(
      "Malformed env var: SQUARE_ENVIRONMENT must be sandbox or production",
    );
  }
}

function validateOptionalBoolean(name, value) {
  if (value !== undefined && value !== "true" && value !== "false") {
    errors.push(`Malformed env var: ${name} must be true or false`);
  }
}

function validateCourseApiUrl(value) {
  try {
    const url = new URL(value);
    const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(
      url.hostname,
    );
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLocalhost)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("unsafe course API URL");
    }
  } catch {
    errors.push(
      "Malformed env var: COURSE_API_BASE_URL must be HTTPS (or localhost HTTP) without credentials, query, or fragment",
    );
  }
}

function validateHttpsUrl(name, value) {
  validateUrl(name, value);

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "https:") {
      errors.push(`Malformed env var: ${name} must use https`);
    }
  } catch {
    // validateUrl already records the error.
  }
}

function launchEnvVarsWithoutLivePayment() {
  return launchEnvVars.filter(
    (name) =>
      name !== "HELCIM_GENERAL_API_TOKEN" &&
      name !== "HELCIM_TRANSACTION_API_TOKEN" &&
      name !== "HELCIM_WEBHOOK_VERIFIER_TOKEN",
  );
}

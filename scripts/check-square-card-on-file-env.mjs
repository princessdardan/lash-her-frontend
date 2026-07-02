const required = [
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

const missing = required.filter((name) => {
  const value = process.env[name];
  return typeof value !== "string" || value.trim().length === 0;
});

if (missing.length > 0) {
  console.error(`[square-card-on-file-env] Missing required variables: ${missing.join(", ")}`);
  process.exit(1);
}

const trueFlags = [
  "SERVICE_BOOKING_SQUARE_ENABLED",
  "SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED",
];

for (const name of trueFlags) {
  if (process.env[name] !== "true") {
    console.error(`[square-card-on-file-env] ${name} must be exactly "true"`);
    process.exit(1);
  }
}

if (process.env.SQUARE_ENVIRONMENT !== "sandbox" && process.env.SQUARE_ENVIRONMENT !== "production") {
  console.error("[square-card-on-file-env] SQUARE_ENVIRONMENT must be sandbox or production");
  process.exit(1);
}

if (process.env.VERCEL_ENV === "production" && process.env.PAYMENT_GATEWAY_MODE === "mock") {
  console.error("[square-card-on-file-env] PAYMENT_GATEWAY_MODE=mock is not allowed in production");
  process.exit(1);
}

if (process.env.VERCEL_ENV === "production" && process.env.SQUARE_ENVIRONMENT !== "production") {
  console.error("[square-card-on-file-env] Production Vercel environment must use Square production credentials");
  process.exit(1);
}

if (
  process.env.VERCEL_ENV !== undefined &&
  process.env.VERCEL_ENV !== "production" &&
  process.env.SQUARE_ENVIRONMENT === "production"
) {
  console.error("[square-card-on-file-env] Preview/staging Vercel environments must use Square sandbox credentials");
  process.exit(1);
}

function validateUrl(name) {
  const value = process.env[name];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    console.error(`[square-card-on-file-env] ${name} must be a valid URL`);
    process.exit(1);
  }

  if (parsed.protocol !== "https:") {
    console.error(`[square-card-on-file-env] ${name} must use https`);
    process.exit(1);
  }
}

validateUrl("SQUARE_SERVICE_BOOKING_WEBHOOK_URL");
validateUrl("SQUARE_SERVICE_BOOKING_RETURN_URL");

console.log("[square-card-on-file-env] Required environment variables are present");

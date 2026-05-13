export const apiVersion =
  process.env.NEXT_PUBLIC_SANITY_API_VERSION || "2026-03-24";

export const dataset = assertValue(
  process.env.NEXT_PUBLIC_SANITY_DATASET,
  "Missing env var: NEXT_PUBLIC_SANITY_DATASET"
);

export const projectId = assertValue(
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  "Missing env var: NEXT_PUBLIC_SANITY_PROJECT_ID"
);

/** Lazy — only asserts when the revalidate route actually calls it. */
export function getWebhookSecret(): string {
  return assertValue(
    process.env.SANITY_WEBHOOK_SECRET,
    "Missing env var: SANITY_WEBHOOK_SECRET"
  );
}

export function getBookingEnv(): {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  bookingAdminSetupSecret: string;
  kvRestApiUrl: string;
  kvRestApiToken: string;
} {
  return {
    googleClientId: assertValue(process.env.GOOGLE_CLIENT_ID, "Missing env var: GOOGLE_CLIENT_ID"),
    googleClientSecret: assertValue(process.env.GOOGLE_CLIENT_SECRET, "Missing env var: GOOGLE_CLIENT_SECRET"),
    googleRedirectUri: assertValue(process.env.GOOGLE_REDIRECT_URI, "Missing env var: GOOGLE_REDIRECT_URI"),
    bookingAdminSetupSecret: assertValue(process.env.BOOKING_ADMIN_SETUP_SECRET, "Missing env var: BOOKING_ADMIN_SETUP_SECRET"),
    kvRestApiUrl: assertValue(process.env.KV_REST_API_URL, "Missing env var: KV_REST_API_URL"),
    kvRestApiToken: assertValue(process.env.KV_REST_API_TOKEN, "Missing env var: KV_REST_API_TOKEN"),
  };
}

/** Lazy — only asserts when server-side Helcim general API requests need it. */
export function getHelcimGeneralApiToken(): string {
  return assertValue(
    process.env.HELCIM_GENERAL_API_TOKEN,
    "Missing env var: HELCIM_GENERAL_API_TOKEN"
  );
}

/** Lazy — only asserts when server-side HelcimPay transaction requests need it. */
export function getHelcimTransactionApiToken(): string {
  return assertValue(
    process.env.HELCIM_TRANSACTION_API_TOKEN,
    "Missing env var: HELCIM_TRANSACTION_API_TOKEN"
  );
}

/** Lazy — only asserts when checkout validation needs persisted Helcim secrets. */
export function getCheckoutSecretEncryptionKey(): Buffer {
  const encodedKey = assertValue(
    process.env.CHECKOUT_SECRET_ENCRYPTION_KEY,
    "Missing env var: CHECKOUT_SECRET_ENCRYPTION_KEY"
  );
  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error(
      "Malformed env var: CHECKOUT_SECRET_ENCRYPTION_KEY must be base64-encoded 32 bytes"
    );
  }

  return key;
}

function assertValue<T>(v: T | undefined, errorMessage: string): T {
  if (v === undefined) {
    throw new Error(errorMessage);
  }
  return v;
}

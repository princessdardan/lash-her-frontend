import "server-only";

import {
  resolvePaymentGatewayMode,
  type PaymentGatewayMode,
  type PaymentMockRuntimeEnvironment,
} from "@/lib/payment-mocks/runtime-controls";

export function getCheckoutDatabaseUrl(): string {
  return assertValue(process.env.DATABASE_URL, "Missing env var: DATABASE_URL");
}

export function getHelcimWebhookVerifierToken(): string {
  return assertValue(
    process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN,
    "Missing env var: HELCIM_WEBHOOK_VERIFIER_TOKEN",
  );
}

export function getEmailRetrySecret(): string {
  return assertValue(
    process.env.EMAIL_RETRY_SECRET,
    "Missing env var: EMAIL_RETRY_SECRET",
  );
}

export function getPrivateDataRetentionCronSecret(): string {
  return assertValue(process.env.CRON_SECRET, "Missing env var: CRON_SECRET");
}

export function getPaymentReconciliationCronSecret(): string | null {
  const secrets = getPaymentReconciliationCronSecretsInternal();

  return secrets[0] ?? null;
}

export function getPaymentReconciliationCronSecrets(): string[] {
  return getPaymentReconciliationCronSecretsInternal();
}

function getPaymentReconciliationCronSecretsInternal(): string[] {
  const routeSpecific = process.env.PAYMENT_RECONCILIATION_CRON_SECRET;
  const cronSecret = process.env.CRON_SECRET;

  // Fail closed: the route-specific secret is required to enable the route.
  const primary = assertValue(
    routeSpecific,
    "Missing env var: PAYMENT_RECONCILIATION_CRON_SECRET",
  ).trim();

  const secrets = [primary];

  // Vercel scheduled cron sends CRON_SECRET; accept it as a secondary bearer
  // when the route is explicitly enabled and CRON_SECRET is configured.
  if (cronSecret !== undefined && cronSecret.trim().length > 0) {
    secrets.push(cronSecret.trim());
  }

  return secrets;
}

export function getPaymentGatewayMode(): PaymentGatewayMode {
  return resolvePaymentGatewayMode(getPaymentMockRuntimeEnvironment());
}

export function isPaymentMockMode(): boolean {
  return getPaymentGatewayMode() === "mock";
}

export function isTrainingAfterpaySquareInvoiceEnabled(): boolean {
  return process.env.TRAINING_AFTERPAY_SQUARE_INVOICE_ENABLED === "true";
}

export function isSquareCardOnFileServiceBookingEnabled(): boolean {
  return process.env.SERVICE_BOOKING_SQUARE_CARD_ON_FILE_ENABLED === "true";
}

export function isSquareCardOnFileServiceBookingLocalInvoiceFallbackEnabled(): boolean {
  if (
    process.env
      .SERVICE_BOOKING_SQUARE_CARD_ON_FILE_LOCAL_INVOICE_FALLBACK_ENABLED !==
    "true"
  ) {
    return false;
  }

  if (process.env.VERCEL_ENV === "production") {
    return false;
  }

  const squareEnvironment = process.env.SQUARE_ENVIRONMENT;
  if (squareEnvironment === "production") {
    return false;
  }

  return true;
}

export function getSquareCardOnFileServiceBookingConfig(): SquareCardOnFileServiceBookingConfig | null {
  if (!isSquareCardOnFileServiceBookingEnabled()) return null;
  const serviceEnv = getSquareServiceBookingEnv();
  if (serviceEnv === null) return null;

  // The card-on-file POST needs DATABASE_URL to persist the secure token.
  // Hide the public config so the browser form is not shown when the DB is unavailable.
  try {
    getCheckoutDatabaseUrl();
  } catch {
    return null;
  }

  return {
    environment: serviceEnv.environment,
    applicationId: assertValue(
      process.env.SQUARE_APPLICATION_ID,
      "Missing env var: SQUARE_APPLICATION_ID",
    ),
    locationId: serviceEnv.locationId,
  };
}

export function getPaymentMockRuntimeEnvironment(): PaymentMockRuntimeEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_GATEWAY_MODE: process.env.PAYMENT_GATEWAY_MODE,
    PAYMENT_MOCK_DEFAULT_SCENARIO: process.env.PAYMENT_MOCK_DEFAULT_SCENARIO,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
}

export function getBookingAdminPaymentActionSecret(): string | null {
  const value = process.env.BOOKING_ADMIN_PAYMENT_ACTION_SECRET;

  if (value === undefined) {
    return null;
  }

  return assertValue(
    value,
    "Missing env var: BOOKING_ADMIN_PAYMENT_ACTION_SECRET",
  ).trim();
}

export function getSquareServiceBookingEnv(): SquareServiceBookingEnv | null {
  if (process.env.SERVICE_BOOKING_SQUARE_ENABLED !== "true") {
    return null;
  }

  const environment = assertValue(
    process.env.SQUARE_ENVIRONMENT,
    "Missing env var: SQUARE_ENVIRONMENT",
  );

  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      "Malformed env var: SQUARE_ENVIRONMENT must be sandbox or production",
    );
  }

  return {
    environment,
    accessToken: assertValue(
      process.env.SQUARE_ACCESS_TOKEN,
      "Missing env var: SQUARE_ACCESS_TOKEN",
    ),
    locationId: assertValue(
      process.env.SQUARE_LOCATION_ID,
      "Missing env var: SQUARE_LOCATION_ID",
    ),
    webhookSignatureKey: assertValue(
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      "Missing env var: SQUARE_WEBHOOK_SIGNATURE_KEY",
    ),
    serviceBookingReturnUrl: assertUrlValue(
      process.env.SQUARE_SERVICE_BOOKING_RETURN_URL,
      "SQUARE_SERVICE_BOOKING_RETURN_URL",
    ),
    serviceBookingWebhookUrl: assertUrlValue(
      process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL,
      "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
    ),
    helcimLegacyCutoffAt:
      process.env.SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT ?? null,
  };
}

export function getTrainingAfterpaySquareInvoiceEnv(): TrainingAfterpaySquareInvoiceEnv | null {
  if (!isTrainingAfterpaySquareInvoiceEnabled()) {
    return null;
  }

  const environment = assertSquareEnvironment();

  return {
    environment,
    accessToken: assertValue(
      process.env.SQUARE_ACCESS_TOKEN,
      "Missing env var: SQUARE_ACCESS_TOKEN",
    ),
    locationId: assertValue(
      process.env.SQUARE_LOCATION_ID,
      "Missing env var: SQUARE_LOCATION_ID",
    ),
  };
}

export function getTrainingAfterpaySquareInvoiceWebhookEnv(): TrainingAfterpaySquareInvoiceWebhookEnv | null {
  if (!isTrainingAfterpaySquareInvoiceEnabled()) {
    return null;
  }

  return {
    notificationUrl: assertUrlValue(
      process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL,
      "SQUARE_SERVICE_BOOKING_WEBHOOK_URL",
    ),
    webhookSignatureKey: assertValue(
      process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
      "Missing env var: SQUARE_WEBHOOK_SIGNATURE_KEY",
    ),
  };
}

function assertSquareEnvironment(): "sandbox" | "production" {
  const environment = assertValue(
    process.env.SQUARE_ENVIRONMENT,
    "Missing env var: SQUARE_ENVIRONMENT",
  );

  if (environment !== "sandbox" && environment !== "production") {
    throw new Error(
      "Malformed env var: SQUARE_ENVIRONMENT must be sandbox or production",
    );
  }

  return environment;
}

function assertValue<T>(value: T | undefined, errorMessage: string): T {
  if (
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  ) {
    throw new Error(errorMessage);
  }

  return value;
}

function assertUrlValue(value: string | undefined, name: string): string {
  const url = assertValue(value, `Missing env var: ${name}`);

  try {
    new URL(url);
  } catch {
    throw new Error(`Malformed env var: ${name} must be a valid URL`);
  }

  return url;
}

export type SquareCardOnFileServiceBookingConfig = {
  environment: "sandbox" | "production";
  applicationId: string;
  locationId: string;
};

type SquareServiceBookingEnv = {
  environment: "sandbox" | "production";
  accessToken: string;
  locationId: string;
  webhookSignatureKey: string;
  serviceBookingReturnUrl: string;
  serviceBookingWebhookUrl: string;
  helcimLegacyCutoffAt: string | null;
};

type TrainingAfterpaySquareInvoiceEnv = {
  environment: "sandbox" | "production";
  accessToken: string;
  locationId: string;
};

type TrainingAfterpaySquareInvoiceWebhookEnv = {
  notificationUrl: string;
  webhookSignatureKey: string;
};

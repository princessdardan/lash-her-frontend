import "server-only";

import {
  resolvePaymentGatewayMode,
  type PaymentGatewayMode,
  type PaymentMockRuntimeEnvironment,
} from "@/lib/payment-mocks/runtime-controls";

export function getCheckoutDatabaseUrl(): string {
  return assertValue(
    process.env.DATABASE_URL,
    "Missing env var: DATABASE_URL",
  );
}

export function getHelcimWebhookVerifierToken(): string {
  return assertValue(
    process.env.HELCIM_WEBHOOK_VERIFIER_TOKEN,
    "Missing env var: HELCIM_WEBHOOK_VERIFIER_TOKEN",
  );
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

export function getPaymentMockRuntimeEnvironment(): PaymentMockRuntimeEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_GATEWAY_MODE: process.env.PAYMENT_GATEWAY_MODE,
    PAYMENT_MOCK_DEFAULT_SCENARIO: process.env.PAYMENT_MOCK_DEFAULT_SCENARIO,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
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
    helcimLegacyCutoffAt: process.env.SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT ?? null,
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
  if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
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

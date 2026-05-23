import "server-only";

import { createPaymentMockStore } from "@/lib/payment-mocks/in-memory-store";
import {
  assertPaymentMockAllowed,
  resolvePaymentGatewayMode,
  resolvePaymentMockScenario,
} from "@/lib/payment-mocks/runtime-controls";
import type { PaymentMockRuntimeEnvironment } from "@/lib/payment-mocks/runtime-controls";
import { getSquareServiceBookingEnv } from "@/lib/env/private-checkout";

import { createMockSquareClient } from "./square-mock-client";
import { createSquareClient, type SquareClient } from "./square-client";

export interface SquareServiceBookingRuntimeEnv {
  accessToken: string;
  environment: "sandbox" | "production";
  helcimLegacyCutoffAt: string | null;
  locationId: string;
  serviceBookingReturnUrl: string;
  serviceBookingWebhookUrl: string;
  webhookSignatureKey: string;
}

interface SquareClientResolverInput {
  env: SquareServiceBookingRuntimeEnv;
  now?: Date;
  request?: Request;
}

const mockSquareStore = createPaymentMockStore();
const fallbackMockRequest = new Request("http://localhost:3000/api/booking/square/mock-runtime");

export function getSquareServiceBookingRuntimeEnv(): SquareServiceBookingRuntimeEnv | null {
  if (process.env.SERVICE_BOOKING_SQUARE_ENABLED !== "true") {
    return null;
  }

  const runtimeEnvironment = getPaymentMockRuntimeEnvironment();
  const mode = resolvePaymentGatewayMode(runtimeEnvironment);

  if (mode !== "mock") {
    return getSquareServiceBookingEnv();
  }

  return {
    accessToken: process.env.SQUARE_ACCESS_TOKEN?.trim() || "mock-square-access-token",
    environment: parseSquareEnvironment(process.env.SQUARE_ENVIRONMENT),
    helcimLegacyCutoffAt: process.env.SERVICE_BOOKING_HELCIM_LEGACY_CUTOFF_AT ?? null,
    locationId: process.env.SQUARE_LOCATION_ID?.trim() || "mock-square-location",
    serviceBookingReturnUrl: process.env.SQUARE_SERVICE_BOOKING_RETURN_URL?.trim()
      || "http://localhost:3000/api/booking/square/return",
    serviceBookingWebhookUrl: process.env.SQUARE_SERVICE_BOOKING_WEBHOOK_URL?.trim()
      || "http://localhost:3000/api/webhooks/square",
    webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY?.trim() || "mock-square-webhook-signature-key",
  };
}

export function createSquareServiceBookingClient(input: SquareClientResolverInput): SquareClient {
  const runtimeEnvironment = getPaymentMockRuntimeEnvironment();
  const request = input.request ?? fallbackMockRequest;

  assertPaymentMockAllowed({ env: runtimeEnvironment, request });

  if (resolvePaymentGatewayMode(runtimeEnvironment) !== "mock") {
    return createSquareClient(input.env);
  }

  return createMockSquareClient({
    now: input.now,
    scenario: resolvePaymentMockScenario({
      env: runtimeEnvironment,
      now: input.now ?? new Date(),
      request,
    }),
    store: mockSquareStore,
  });
}

export function getSquarePaymentMockRuntimeEnvironment(): PaymentMockRuntimeEnvironment {
  return getPaymentMockRuntimeEnvironment();
}

function getPaymentMockRuntimeEnvironment(): PaymentMockRuntimeEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PAYMENT_GATEWAY_MODE: process.env.PAYMENT_GATEWAY_MODE,
    PAYMENT_MOCK_DEFAULT_SCENARIO: process.env.PAYMENT_MOCK_DEFAULT_SCENARIO,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
}

function parseSquareEnvironment(value: string | undefined): "sandbox" | "production" {
  return value === "production" ? "production" : "sandbox";
}

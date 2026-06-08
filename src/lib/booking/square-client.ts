import "server-only";

import { getSquareServiceBookingEnv } from "@/lib/env/private-checkout";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareCreatePaymentLinkRequest {
  checkout_options?: {
    allow_tipping?: boolean;
    redirect_url?: string;
  };
  idempotency_key: string;
  order?: {
    location_id: string;
    line_items: Array<{
      applied_taxes?: Array<{
        tax_uid: string;
      }>;
      name: string;
      quantity: string;
      base_price_money: {
        amount: number;
        currency: "CAD";
      };
      note?: string;
    }>;
    metadata?: Record<string, string>;
    reference_id?: string;
    taxes?: Array<{
      name: string;
      percentage: string;
      scope: "LINE_ITEM";
      type: "ADDITIVE";
      uid: string;
    }>;
  };
  payment_note?: string;
}

export interface SquarePaymentLink {
  id: string;
  order_id?: string;
  url: string;
}

export interface SquareCreatePaymentLinkResponse {
  payment_link: SquarePaymentLink;
  related_resources?: unknown;
}

export interface SquareMoney {
  amount?: number;
  currency?: string;
}

export interface SquarePayment {
  id: string;
  amount_money?: SquareMoney;
  order_id?: string;
  status?: string;
  tip_money?: SquareMoney;
  total_money?: SquareMoney;
}

export interface SquareOrder {
  id: string;
  location_id?: string;
  reference_id?: string;
  state?: string;
  total_money?: SquareMoney;
}

export interface SquareGetPaymentResponse {
  payment: SquarePayment;
}

export interface SquareGetOrderResponse {
  order: SquareOrder;
}

export interface SquareClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
}

export interface SquareClient {
  createPaymentLink(request: SquareCreatePaymentLinkRequest): Promise<SquareCreatePaymentLinkResponse>;
  getOrder(orderId: string): Promise<SquareGetOrderResponse>;
  getPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
}

export function createSquareClient(env: SquareClientEnv): SquareClient {
  return {
    async createPaymentLink(request) {
      return postSquare<SquareCreatePaymentLinkRequest, SquareCreatePaymentLinkResponse>(
        env,
        "/v2/online-checkout/payment-links",
        request,
        isSquareCreatePaymentLinkResponse,
      );
    },

    async getOrder(orderId) {
      return getSquare<SquareGetOrderResponse>(
        env,
        `/v2/orders/${encodeURIComponent(orderId)}`,
        isSquareGetOrderResponse,
      );
    },

    async getPayment(paymentId) {
      return getSquare<SquareGetPaymentResponse>(
        env,
        `/v2/payments/${encodeURIComponent(paymentId)}`,
        isSquareGetPaymentResponse,
      );
    },
  };
}

export async function createSquarePaymentLink(
  request: SquareCreatePaymentLinkRequest,
): Promise<SquareCreatePaymentLinkResponse> {
  const env = getSquareServiceBookingEnv();

  if (env === null) {
    throw new Error("Square service booking checkout is not enabled");
  }

  return createSquareClient(env).createPaymentLink(request);
}

async function postSquare<TRequest, TResponse>(
  env: SquareClientEnv,
  path: string,
  request: TRequest,
  validateResponse: (value: unknown) => value is TResponse,
): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(`${SQUARE_BASE_URLS[env.environment]}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.accessToken}`,
        "content-type": "application/json",
        "square-version": SQUARE_VERSION,
      },
      body: JSON.stringify(request),
      cache: "no-store",
    });
  } catch {
    throw new Error("Square API request failed before receiving a response");
  }

  if (!response.ok) {
    throw new Error(`Square API request failed with status ${response.status}`);
  }

  const body: unknown = await response.json();

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

async function getSquare<TResponse>(
  env: SquareClientEnv,
  path: string,
  validateResponse: (value: unknown) => value is TResponse,
): Promise<TResponse> {
  let response: Response;

  try {
    response = await fetch(`${SQUARE_BASE_URLS[env.environment]}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.accessToken}`,
        "square-version": SQUARE_VERSION,
      },
      cache: "no-store",
    });
  } catch {
    throw new Error("Square API request failed before receiving a response");
  }

  if (!response.ok) {
    throw new Error(`Square API request failed with status ${response.status}`);
  }

  const body: unknown = await response.json();

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

function isSquareCreatePaymentLinkResponse(value: unknown): value is SquareCreatePaymentLinkResponse {
  if (!isRecord(value) || !isRecord(value.payment_link)) {
    return false;
  }

  return typeof value.payment_link.id === "string" &&
    typeof value.payment_link.url === "string" &&
    (
      value.payment_link.order_id === undefined ||
      typeof value.payment_link.order_id === "string"
    );
}

function isSquareGetPaymentResponse(value: unknown): value is SquareGetPaymentResponse {
  return isRecord(value) && isSquarePayment(value.payment);
}

function isSquareGetOrderResponse(value: unknown): value is SquareGetOrderResponse {
  return isRecord(value) && isRecord(value.order) && typeof value.order.id === "string";
}

function isSquarePayment(value: unknown): value is SquarePayment {
  return isRecord(value) && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

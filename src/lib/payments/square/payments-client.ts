import "server-only";

const SQUARE_VERSION = "2026-05-20";
const SQUARE_BASE_URLS = {
  production: "https://connect.squareup.com",
  sandbox: "https://connect.squareupsandbox.com",
} as const;

export interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquareCreatePaymentRequest {
  idempotency_key: string;
  source_id: string;
  customer_id: string;
  amount_money: SquareMoney;
  autocomplete?: boolean;
  verification_token?: string;
  reference_id?: string;
  note?: string;
}

export interface SquarePayment {
  id: string;
  status: string;
  order_id?: string;
  customer_id?: string;
  source_type?: string;
  version_token?: string;
  card_details?: { card?: { id?: string } };
  amount_money: SquareMoney;
}

export interface SquareCreatePaymentResponse {
  payment: SquarePayment;
}

export interface SquareGetPaymentResponse {
  payment: SquarePayment;
}

export interface SquarePaymentsClientEnv {
  accessToken: string;
  environment: "sandbox" | "production";
}

export interface SquarePaymentsClient {
  createCardOnFilePayment(
    request: SquareCreatePaymentRequest,
  ): Promise<SquareCreatePaymentResponse>;
  getPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
  completePayment(
    paymentId: string,
    versionToken?: string,
  ): Promise<SquareGetPaymentResponse>;
  cancelPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
}

export function createSquarePaymentsClient(
  env: SquarePaymentsClientEnv,
): SquarePaymentsClient {
  return {
    async createCardOnFilePayment(request) {
      return postSquare<
        SquareCreatePaymentRequest,
        SquareCreatePaymentResponse
      >(env, "/v2/payments", request, isSquareCreatePaymentResponse);
    },
    async getPayment(paymentId) {
      return getSquare<SquareGetPaymentResponse>(
        env,
        `/v2/payments/${encodeURIComponent(paymentId)}`,
        isSquareGetPaymentResponse,
      );
    },
    async completePayment(paymentId, versionToken) {
      const query = versionToken
        ? `?version_token=${encodeURIComponent(versionToken)}`
        : "";
      return postSquare<Record<string, never>, SquareGetPaymentResponse>(
        env,
        `/v2/payments/${encodeURIComponent(paymentId)}/complete${query}`,
        {},
        isSquareGetPaymentResponse,
      );
    },
    async cancelPayment(paymentId) {
      return postSquare<Record<string, never>, SquareGetPaymentResponse>(
        env,
        `/v2/payments/${encodeURIComponent(paymentId)}/cancel`,
        {},
        isSquareGetPaymentResponse,
      );
    },
  };
}

export async function createSquareCardOnFilePayment(
  env: SquarePaymentsClientEnv,
  request: SquareCreatePaymentRequest,
): Promise<SquareCreatePaymentResponse> {
  return createSquarePaymentsClient(env).createCardOnFilePayment(request);
}

async function postSquare<TRequest, TResponse>(
  env: SquarePaymentsClientEnv,
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

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new Error("Square API response was malformed");
  }

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

async function getSquare<TResponse>(
  env: SquarePaymentsClientEnv,
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

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new Error("Square API response was malformed");
  }

  if (!validateResponse(body)) {
    throw new Error("Square API response was malformed");
  }

  return body;
}

function isSquareCreatePaymentResponse(
  value: unknown,
): value is SquareCreatePaymentResponse {
  return isSquarePaymentResponse(value);
}

function isSquareGetPaymentResponse(
  value: unknown,
): value is SquareGetPaymentResponse {
  return isSquarePaymentResponse(value);
}

function isSquarePaymentResponse(
  value: unknown,
): value is { payment: SquarePayment } {
  return isRecord(value) && isSquarePayment(value.payment);
}

function isSquarePayment(value: unknown): value is SquarePayment {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.id !== "string" || typeof value.status !== "string") {
    return false;
  }

  if (!isRecord(value.amount_money)) {
    return false;
  }

  if (
    typeof value.amount_money.amount !== "number" ||
    typeof value.amount_money.currency !== "string"
  ) {
    return false;
  }

  if (
    "customer_id" in value &&
    value.customer_id !== undefined &&
    typeof value.customer_id !== "string"
  ) {
    return false;
  }

  if (
    "order_id" in value &&
    value.order_id !== undefined &&
    typeof value.order_id !== "string"
  ) {
    return false;
  }

  if (
    "source_type" in value &&
    value.source_type !== undefined &&
    typeof value.source_type !== "string"
  ) {
    return false;
  }

  if (
    "version_token" in value &&
    value.version_token !== undefined &&
    typeof value.version_token !== "string"
  ) {
    return false;
  }

  if ("card_details" in value && value.card_details !== undefined) {
    if (!isRecord(value.card_details)) {
      return false;
    }

    if ("card" in value.card_details && value.card_details.card !== undefined) {
      if (!isRecord(value.card_details.card)) {
        return false;
      }

      if (
        "id" in value.card_details.card &&
        value.card_details.card.id !== undefined &&
        typeof value.card_details.card.id !== "string"
      ) {
        return false;
      }
    }
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

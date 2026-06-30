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
  reference_id?: string;
  note?: string;
}

export interface SquarePayment {
  id: string;
  status: string;
  order_id?: string;
  customer_id?: string;
  source_type?: string;
  card_details?: { card?: { id: string } };
  amount_money?: SquareMoney;
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
  return (
    isRecord(value) &&
    isRecord(value.payment) &&
    typeof value.payment.id === "string" &&
    typeof value.payment.status === "string"
  );
}

function isSquareGetPaymentResponse(
  value: unknown,
): value is SquareGetPaymentResponse {
  if (!isRecord(value) || !isRecord(value.payment)) {
    return false;
  }

  const payment = value.payment;

  if (typeof payment.id !== "string" || typeof payment.status !== "string") {
    return false;
  }

  if (!isRecord(payment.amount_money)) {
    return false;
  }

  if (
    typeof payment.amount_money.amount !== "number" ||
    typeof payment.amount_money.currency !== "string"
  ) {
    return false;
  }

  if (
    "customer_id" in payment &&
    payment.customer_id !== undefined &&
    typeof payment.customer_id !== "string"
  ) {
    return false;
  }

  if (
    "order_id" in payment &&
    payment.order_id !== undefined &&
    typeof payment.order_id !== "string"
  ) {
    return false;
  }

  if (
    "source_type" in payment &&
    payment.source_type !== undefined &&
    typeof payment.source_type !== "string"
  ) {
    return false;
  }

  if ("card_details" in payment && payment.card_details !== undefined) {
    if (!isRecord(payment.card_details)) {
      return false;
    }

    if (
      "card" in payment.card_details &&
      payment.card_details.card !== undefined
    ) {
      if (!isRecord(payment.card_details.card)) {
        return false;
      }

      if (
        "id" in payment.card_details.card &&
        payment.card_details.card.id !== undefined &&
        typeof payment.card_details.card.id !== "string"
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

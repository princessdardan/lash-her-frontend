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
  /**
   * Required for card-on-file booking charges. Optional for one-time commerce
   * sales (product / primary-training checkout), where no customer is stored.
   */
  customer_id?: string;
  amount_money: SquareMoney;
  autocomplete?: boolean;
  verification_token?: string;
  reference_id?: string;
  note?: string;
  team_member_id?: string;
}

export interface SquarePayment {
  id: string;
  status: string;
  order_id?: string;
  reference_id?: string;
  customer_id?: string;
  source_type?: string;
  team_member_id?: string;
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

export interface SquareRefund {
  id: string;
  status: string;
  payment_id?: string;
  order_id?: string;
  amount_money: SquareMoney;
}

export interface SquareRefundPaymentRequest {
  idempotency_key: string;
  payment_id: string;
  amount_money: SquareMoney;
  reason?: string;
}

export interface SquareRefundPaymentResponse {
  refund: SquareRefund;
}

/**
 * Thrown by {@link SquarePaymentsClient.refundPayment} when Square rejects the
 * request with a non-2xx status. Preserves the HTTP status (and Square error
 * code when present) so callers can classify a deterministic client error
 * (4xx, excluding 409 conflicts) from a transient/unknown outcome.
 */
export class SquareApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`Square API request failed with status ${status}`);
    this.name = "SquareApiError";
    this.status = status;
    this.code = code;
  }
}

export interface SquareListPaymentsParams {
  /** RFC3339 lower bound on payment `created_at` (inclusive). */
  beginTime?: string;
  /** RFC3339 upper bound on payment `created_at` (inclusive). */
  endTime?: string;
  /** "ASC" | "DESC" over `created_at`. Square defaults to "DESC". */
  sortOrder?: "ASC" | "DESC";
  /** Opaque pagination cursor from a prior page. */
  cursor?: string;
  /** Page size (Square caps this server-side). */
  limit?: number;
}

export interface SquareListPaymentsResponse {
  payments: SquarePayment[];
  cursor?: string;
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
  /**
   * List payments over a `created_at` window (one page). Square offers no
   * server-side filter on `reference_id`, so the caller pages this and matches
   * the reference client-side. Parsing is lenient: an account payment whose
   * shape the validator does not recognize is skipped, never failing the read.
   */
  listPayments(
    params: SquareListPaymentsParams,
  ): Promise<SquareListPaymentsResponse>;
  completePayment(
    paymentId: string,
    versionToken?: string,
  ): Promise<SquareGetPaymentResponse>;
  cancelPayment(paymentId: string): Promise<SquareGetPaymentResponse>;
  cancelPaymentByIdempotencyKey(idempotencyKey: string): Promise<void>;
  refundPayment(
    request: SquareRefundPaymentRequest,
  ): Promise<SquareRefundPaymentResponse>;
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
    async listPayments(params) {
      const query = new URLSearchParams();
      if (params.beginTime) query.set("begin_time", params.beginTime);
      if (params.endTime) query.set("end_time", params.endTime);
      if (params.sortOrder) query.set("sort_order", params.sortOrder);
      if (params.cursor) query.set("cursor", params.cursor);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      const suffix = query.toString();
      const envelope = await getSquare<SquareListPaymentsEnvelope>(
        env,
        `/v2/payments${suffix ? `?${suffix}` : ""}`,
        isSquareListPaymentsEnvelope,
      );
      const payments = Array.isArray(envelope.payments)
        ? envelope.payments.filter(isSquarePayment)
        : [];
      return {
        payments,
        ...(typeof envelope.cursor === "string"
          ? { cursor: envelope.cursor }
          : {}),
      };
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
    async cancelPaymentByIdempotencyKey(idempotencyKey) {
      await postSquare<{ idempotency_key: string }, Record<string, never>>(
        env,
        "/v2/payments/cancel",
        { idempotency_key: idempotencyKey },
        isSquareEmptyResponse,
      );
    },
    async refundPayment(request) {
      return postSquareWithStatus<
        SquareRefundPaymentRequest,
        SquareRefundPaymentResponse
      >(env, "/v2/refunds", request, isSquareRefundPaymentResponse);
    },
  };
}

export async function createSquareCardOnFilePayment(
  env: SquarePaymentsClientEnv,
  request: SquareCreatePaymentRequest,
): Promise<SquareCreatePaymentResponse> {
  return createSquarePaymentsClient(env).createCardOnFilePayment(request);
}

/**
 * One-time sale for product / primary-training checkout. Hits the same
 * `/v2/payments` endpoint as the booking charge, but the source is a single-use
 * card nonce from the Web Payments SDK (`tokenize({ intent: "CHARGE" })`) and no
 * stored `customer_id` is required. Pass `autocomplete: true` to capture
 * immediately.
 */
export async function createSquareCommercePayment(
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

/**
 * POST variant that preserves the HTTP status on failure by throwing a
 * {@link SquareApiError}. Used for refunds, where the caller must distinguish a
 * deterministic client rejection (4xx) from a transient/unknown outcome so a
 * refund is never silently double-issued or falsely marked failed.
 */
async function postSquareWithStatus<TRequest, TResponse>(
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
    let code: string | undefined;
    try {
      const errorBody: unknown = await response.json();
      if (
        isRecord(errorBody) &&
        Array.isArray(errorBody.errors) &&
        isRecord(errorBody.errors[0]) &&
        typeof errorBody.errors[0].code === "string"
      ) {
        code = errorBody.errors[0].code;
      }
    } catch {
      // Non-JSON error body; status alone drives classification.
    }
    throw new SquareApiError(response.status, code);
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

/**
 * Raw ListPayments envelope. Deliberately lenient — `payments` need only be an
 * array (its items are validated and filtered by the caller) and `cursor` a
 * string when present — so one unrecognized account payment never fails the
 * whole read. An empty body (no payments in the window) is valid.
 */
interface SquareListPaymentsEnvelope {
  payments?: unknown[];
  cursor?: unknown;
}

function isSquareListPaymentsEnvelope(
  value: unknown,
): value is SquareListPaymentsEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  if ("payments" in value && value.payments !== undefined) {
    if (!Array.isArray(value.payments)) {
      return false;
    }
  }
  if (
    "cursor" in value &&
    value.cursor !== undefined &&
    typeof value.cursor !== "string"
  ) {
    return false;
  }
  return true;
}

function isSquareEmptyResponse(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isSquareRefundPaymentResponse(
  value: unknown,
): value is SquareRefundPaymentResponse {
  if (!isRecord(value) || !isRecord(value.refund)) {
    return false;
  }

  const refund = value.refund;

  if (typeof refund.id !== "string" || typeof refund.status !== "string") {
    return false;
  }

  if (!isRecord(refund.amount_money)) {
    return false;
  }

  if (
    typeof refund.amount_money.amount !== "number" ||
    typeof refund.amount_money.currency !== "string"
  ) {
    return false;
  }

  if (
    "payment_id" in refund &&
    refund.payment_id !== undefined &&
    typeof refund.payment_id !== "string"
  ) {
    return false;
  }

  if (
    "order_id" in refund &&
    refund.order_id !== undefined &&
    typeof refund.order_id !== "string"
  ) {
    return false;
  }

  return true;
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
    "reference_id" in value &&
    value.reference_id !== undefined &&
    typeof value.reference_id !== "string"
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

  if (
    "team_member_id" in value &&
    value.team_member_id !== undefined &&
    typeof value.team_member_id !== "string"
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

import "server-only";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";

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
  order_id?: string;
  location_id?: string;
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
  receipt_url?: string;
  location_id?: string;
  created_at?: string;
  updated_at?: string;
  refunded_money?: SquareMoney;
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
  location_id?: string;
  updated_at?: string;
  order_id?: string;
  amount_money: SquareMoney;
}

const disputeStates = [
  "INQUIRY_EVIDENCE_REQUIRED",
  "INQUIRY_PROCESSING",
  "INQUIRY_CLOSED",
  "EVIDENCE_REQUIRED",
  "PROCESSING",
  "WON",
  "LOST",
  "ACCEPTED",
] as const;

export interface SquareDispute {
  id: string;
  disputed_payment: { payment_id: string };
  location_id: string;
  amount_money: SquareMoney;
  state: (typeof disputeStates)[number];
  updated_at: string;
  version?: number;
}

type DisputeRevision = { version?: number | null; updatedAt: string | Date };

export function compareSquareDisputeRevisions(
  a: DisputeRevision,
  b: DisputeRevision,
) {
  return a.version != null && b.version != null
    ? a.version - b.version
    : new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
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
  locationId?: string;
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
      >(
        env,
        "/v2/payments",
        {
          ...request,
          ...(env.locationId ? { location_id: env.locationId } : {}),
        },
        isSquareCreatePaymentResponse,
      );
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
      if (env.locationId) query.set("location_id", env.locationId);
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
      if (
        Array.isArray(envelope.payments) &&
        payments.length !== envelope.payments.length
      )
        markWriterOperationUncertain();
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

type SquareCourseTax = { taxCode: string; label: string; amount: number; ratePartsPerMillion: number };
type SquareCourseOrderResponse = { order: { id: string; [key: string]: unknown } };

export async function createSquareCourseOrder(
  env: SquarePaymentsClientEnv,
  order: {
    reference: string;
    title: string;
    priceCents: number;
    taxCents: number;
    totalCents: number;
    taxBehavior: "inclusive" | "exclusive";
    components: SquareCourseTax[];
  },
) {
  const components = order.components.filter(({ ratePartsPerMillion }) => ratePartsPerMillion > 0);
  const [tax] = components;
  // Square rounds an exact half-cent down when the lower cent is even.
  // For a single tax at that boundary, give Square the gross price with
  // included tax so it preserves both the accepted amount and the exact rate.
  const squareRoundsTaxDown = order.taxBehavior === "exclusive" && components.length === 1 &&
    (BigInt(order.priceCents) * BigInt(tax.ratePartsPerMillion)) % BigInt(2_000_000) === BigInt(500_000);
  const inclusive = order.taxBehavior === "inclusive" || squareRoundsTaxDown;
  const linePrice = squareRoundsTaxDown ? order.totalCents : order.priceCents;

  // Square permits only alphanumeric IDs on applied taxes. The quote's
  // component order is stable for retries with the same idempotency key.
  const taxes = components.map(({ label, ratePartsPerMillion }, index) => ({
    uid: `tax${index + 1}`,
    name: label,
    percentage: String(ratePartsPerMillion / 10_000),
    type: inclusive ? "INCLUSIVE" : "ADDITIVE",
    scope: "ORDER",
  }));
  const validate = (value: unknown): value is SquareCourseOrderResponse =>
    isRecord(value) && isRecord(value.order) &&
    typeof value.order.id === "string" && value.order.id.length > 0;
  const { order: created } = await postSquareWithStatus(env, "/v2/orders", {
    idempotency_key: order.reference,
    order: {
      location_id: env.locationId,
      reference_id: order.reference,
      line_items: [{
        name: order.title,
        quantity: "1",
        base_price_money: { amount: linePrice, currency: "CAD" },
      }],
      taxes,
    },
  }, validate, 10_000);

  const matchesCad = (money: unknown, amount: number) =>
    isRecord(money) && money.currency === "CAD" && money.amount === amount;
  const returnedTaxes = created.taxes ?? [];
  if (
    created.location_id !== env.locationId || created.reference_id !== order.reference ||
    !matchesCad(created.total_money, order.totalCents) ||
    !(created.total_tax_money == null && order.taxCents === 0 ||
      matchesCad(created.total_tax_money, order.taxCents)) ||
    !Array.isArray(returnedTaxes) || returnedTaxes.length !== taxes.length ||
    !taxes.every(({ uid, name, type }, index) =>
      returnedTaxes.some((tax: unknown) =>
        isRecord(tax) && tax.uid === uid && tax.name === name && tax.type === type &&
        matchesCad(tax.applied_money, components[index].amount),
      ),
    )
  ) throw new Error("Square Course order does not match the accepted quote");
  return created.id;
}

export function createSquareCoursePayment(env: SquarePaymentsClientEnv, request: SquareCreatePaymentRequest) {
  return postSquareWithStatus(env, "/v2/payments", request, isSquareCreatePaymentResponse, 10_000);
}

export function getSquareCoursePayment(env: SquarePaymentsClientEnv, paymentId: string) {
  return getSquare(env, `/v2/payments/${encodeURIComponent(paymentId)}`, isSquareGetPaymentResponse, 10_000);
}

export function getSquareCourseRefund(env: SquarePaymentsClientEnv, refundId: string) {
  return getSquare(env, `/v2/refunds/${encodeURIComponent(refundId)}`, isSquareRefundPaymentResponse, 10_000);
}

export function getSquareCourseDispute(
  env: SquarePaymentsClientEnv,
  disputeId: string,
) {
  return getSquare(
    env,
    `/v2/disputes/${encodeURIComponent(disputeId)}`,
    isSquareDisputeResponse,
    10_000,
  );
}

export function completeSquareCoursePayment(env: SquarePaymentsClientEnv, payment: SquarePayment) {
  return postSquareWithStatus(env, `/v2/payments/${encodeURIComponent(payment.id)}/complete`, {
    ...(payment.version_token ? { version_token: payment.version_token } : {}),
  }, isSquareGetPaymentResponse, 10_000);
}

export function cancelSquareCoursePayment(env: SquarePaymentsClientEnv, paymentId: string) {
  return postSquareWithStatus(env, `/v2/payments/${encodeURIComponent(paymentId)}/cancel`, {},
    isSquareGetPaymentResponse, 10_000);
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
  timeoutMs?: number,
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
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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
  timeoutMs?: number,
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
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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

function isSquareDisputeResponse(
  value: unknown,
): value is { dispute: SquareDispute } {
  if (!isRecord(value) || !isRecord(value.dispute)) return false;
  const dispute = value.dispute;
  return (
    typeof dispute.id === "string" &&
    typeof dispute.location_id === "string" &&
    isRecord(dispute.disputed_payment) &&
    typeof dispute.disputed_payment.payment_id === "string" &&
    isRecord(dispute.amount_money) &&
    typeof dispute.amount_money.amount === "number" &&
    typeof dispute.amount_money.currency === "string" &&
    disputeStates.some((state) => state === dispute.state) &&
    typeof dispute.updated_at === "string" &&
    Number.isFinite(Date.parse(dispute.updated_at)) &&
    (dispute.version === undefined ||
      (typeof dispute.version === "number" &&
        Number.isInteger(dispute.version) &&
        dispute.version >= 0 &&
        dispute.version <= 2147483647))
  );
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

  if (value.receipt_url !== undefined && typeof value.receipt_url !== "string") {
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

export interface SquareSplitOrder {
  tenders?: Array<{ payment_id?: string }>;
  id: string;
  reference_id?: string;
  state: string;
  total_money: SquareMoney;
}

export function createSquareSplitOrdersClient(env: SquarePaymentsClientEnv) {
  const validate = (value: unknown): value is { order: SquareSplitOrder } =>
    isRecord(value) &&
    isRecord(value.order) &&
    typeof value.order.id === "string" &&
    typeof value.order.state === "string" &&
    isRecord(value.order.total_money) &&
    Number.isSafeInteger(value.order.total_money.amount) &&
    value.order.total_money.currency === "CAD";
  return {
    async create(reference: string, totalCents: number, key: string) {
      const result = await postSquare(
        env,
        "/v2/orders",
        {
          idempotency_key: key,
          order: {
            location_id: env.locationId,
            reference_id: reference,
            line_items: [
              {
                name: "Training enrollment (including HST)",
                quantity: "1",
                base_price_money: { amount: totalCents, currency: "CAD" },
              },
            ],
          },
        },
        validate,
      );
      if (
        result.order.reference_id !== reference ||
        result.order.total_money.amount !== totalCents
      )
        throw new Error("Square order does not match training total");
      return result.order.id;
    },
    async pay(orderId: string, paymentIds: string[], key: string) {
      const result = await postSquare(
        env,
        `/v2/orders/${encodeURIComponent(orderId)}/pay`,
        {
          idempotency_key: key,
          payment_ids: paymentIds,
        },
        validate,
      );
      if (
        result.order.id !== orderId ||
        result.order.state !== "COMPLETED" ||
        !Array.isArray(result.order.tenders) ||
        result.order.tenders.length !== paymentIds.length ||
        !paymentIds.every((id) =>
          result.order.tenders!.some((tender) => tender.payment_id === id),
        )
      )
        throw new Error("Square split order payment is not confirmed");
    },
  };
}

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SquareWebhookHeaders {
  signature: string;
}

export interface VerifiedSquareWebhookEvent {
  createdAt?: string;
  eventId: string;
  eventType: string;
  merchantId?: string;
  orderId?: string;
  paymentId?: string;
  refund?: VerifiedSquareRefund;
  payloadSanitized: Record<string, unknown>;
}

export interface VerifiedSquareRefund {
  amountCents: number;
  currency: string;
  occurredAt: string;
  paymentId: string;
  refundId: string;
  status: string;
}

type SquareWebhookPayload = Record<string, unknown>;

export function getSquareWebhookHeaders(
  headers: Headers,
): SquareWebhookHeaders | null {
  const signature = headers.get("x-square-hmacsha256-signature");

  if (signature === null || signature.trim().length === 0) {
    return null;
  }

  return { signature };
}

export function verifySquareWebhookSignature(input: {
  notificationUrl: string;
  rawBody: string;
  signature: string;
  signatureKey: string;
}): boolean {
  const expectedSignature = createHmac("sha256", input.signatureKey)
    .update(`${input.notificationUrl}${input.rawBody}`, "utf8")
    .digest("base64");

  return timingSafeStringEqual(expectedSignature, input.signature.trim());
}

export function parseVerifiedSquareWebhook(
  rawBody: string,
): VerifiedSquareWebhookEvent {
  const payload = parseJsonObject(rawBody);
  const data = getObject(payload.data);
  const object = getObject(data?.object);
  const refund = getObject(object?.refund);
  const payment =
    getObject(object?.payment) ?? (refund === null ? getObject(object) : null);
  const order = getObject(object?.order);
  const orderUpdated = getObject(object?.order_updated);
  const eventId = getText(payload.event_id) ?? getText(payload.id);
  const eventType = getText(payload.type);

  if (eventId === null || eventType === null) {
    throw new Error("Square webhook payload must include event_id and type");
  }

  const createdAt = getText(payload.created_at);
  const merchantId = getText(payload.merchant_id);
  const orderId =
    getText(payment?.order_id) ??
    getText(order?.id) ??
    getText(orderUpdated?.order_id) ??
    (eventType === "order.updated" ? getText(data?.id) : null);
  const verifiedRefund = parseRefund(eventType, refund, createdAt);
  const paymentId = verifiedRefund?.paymentId ?? getText(payment?.id);

  return {
    ...(createdAt ? { createdAt } : {}),
    eventId,
    eventType,
    ...(merchantId ? { merchantId } : {}),
    ...(orderId ? { orderId } : {}),
    ...(paymentId ? { paymentId } : {}),
    ...(verifiedRefund ? { refund: verifiedRefund } : {}),
    payloadSanitized: sanitizeSquarePayload(payload),
  };
}

function parseRefund(
  eventType: string,
  refund: SquareWebhookPayload | null,
  eventCreatedAt: string | null,
): VerifiedSquareRefund | null {
  const isRefundEvent =
    eventType === "refund.created" || eventType === "refund.updated";

  if (!isRefundEvent) {
    return null;
  }

  if (refund === null) {
    throw new Error("Square refund webhook must include a refund object");
  }

  const amountMoney = getObject(refund.amount_money);
  const amountCents = amountMoney?.amount;
  const currency = getText(amountMoney?.currency);
  const paymentId = getText(refund.payment_id);
  const refundId = getText(refund.id);
  const status = getText(refund.status);
  const occurredAt =
    getText(refund.updated_at) ?? getText(refund.created_at) ?? eventCreatedAt;

  if (
    typeof amountCents !== "number" ||
    !Number.isSafeInteger(amountCents) ||
    amountCents < 0 ||
    currency === null ||
    paymentId === null ||
    refundId === null ||
    status === null ||
    occurredAt === null ||
    !isValidTimestamp(occurredAt)
  ) {
    throw new Error("Square refund webhook is malformed");
  }

  return {
    amountCents,
    currency: currency.toUpperCase(),
    occurredAt,
    paymentId,
    refundId,
    status: status.toUpperCase(),
  };
}

function parseJsonObject(rawBody: string): SquareWebhookPayload {
  const parsed: unknown = JSON.parse(rawBody);

  if (!isObject(parsed)) {
    throw new Error("Square webhook payload must be a JSON object");
  }

  return parsed;
}

function getObject(value: unknown): SquareWebhookPayload | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is SquareWebhookPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function sanitizeSquarePayload(value: unknown): Record<string, unknown> {
  return sanitizeValue(value) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([key, nestedValue]) => [
          key,
          isSensitiveSquareKey(key) ? "[redacted]" : sanitizeValue(nestedValue),
        ],
      ),
    );
  }

  return value;
}

function isSensitiveSquareKey(key: string): boolean {
  return /access|card|cvv|pan|secret|token/i.test(key);
}

function timingSafeStringEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

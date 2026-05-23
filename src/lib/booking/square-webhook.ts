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
  payloadSanitized: Record<string, unknown>;
}

type SquareWebhookPayload = Record<string, unknown>;

export function getSquareWebhookHeaders(headers: Headers): SquareWebhookHeaders | null {
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

export function parseVerifiedSquareWebhook(rawBody: string): VerifiedSquareWebhookEvent {
  const payload = parseJsonObject(rawBody);
  const data = getObject(payload.data);
  const object = getObject(data?.object);
  const payment = getObject(object?.payment) ?? getObject(object);
  const order = getObject(object?.order);
  const eventId = getText(payload.event_id) ?? getText(payload.id);
  const eventType = getText(payload.type);

  if (eventId === null || eventType === null) {
    throw new Error("Square webhook payload must include event_id and type");
  }

  const createdAt = getText(payload.created_at);
  const merchantId = getText(payload.merchant_id);
  const orderId = getText(payment?.order_id) ?? getText(order?.id);
  const paymentId = getText(payment?.id);

  return {
    ...(createdAt ? { createdAt } : {}),
    eventId,
    eventType,
    ...(merchantId ? { merchantId } : {}),
    ...(orderId ? { orderId } : {}),
    ...(paymentId ? { paymentId } : {}),
    payloadSanitized: sanitizeSquarePayload(payload),
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

function sanitizeSquarePayload(value: unknown): Record<string, unknown> {
  return sanitizeValue(value) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        isSensitiveSquareKey(key) ? "[redacted]" : sanitizeValue(nestedValue),
      ]),
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

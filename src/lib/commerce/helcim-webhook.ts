import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  HelcimCardTransactionResponse,
  HelcimTransactionReconciliationFields,
} from "./helcim-types";

export interface HelcimWebhookHeaders {
  id: string;
  signature: string;
  timestamp: string;
}

export interface VerifiedHelcimWebhook {
  amount?: number | string;
  approvalCode?: string;
  cardLast4?: string;
  cardType?: string;
  currency?: string;
  eventId: string;
  eventType: string;
  helcimInvoiceId?: number;
  helcimInvoiceNumber?: string;
  helcimTransactionId?: string;
  payloadRedacted?: Record<string, unknown>;
  status?: string;
}

type WebhookPayload = Record<string, unknown>;

const HELCIM_WEBHOOK_MAX_AGE_MS = 10 * 60 * 60 * 1000;

export function verifyHelcimWebhookSignature(
  headers: HelcimWebhookHeaders,
  rawBody: string,
  verifierToken: string,
  now = Date.now(),
): boolean {
  if (!isFreshTimestamp(headers.timestamp, now)) {
    return false;
  }

  const verifierKey = Buffer.from(verifierToken, "base64");
  const expectedSignature = createHmac("sha256", verifierKey)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`, "utf8")
    .digest("base64");

  return getSignatureCandidates(headers.signature).some((signature) => (
    timingSafeStringEqual(expectedSignature, signature)
  ));
}

export function parseVerifiedHelcimWebhook(
  headers: HelcimWebhookHeaders,
  rawBody: string,
): VerifiedHelcimWebhook {
  const payload = parseJsonObject(rawBody);
  const data = getObject(payload.data) ?? payload;
  const eventType = getText(payload.eventType) ?? getText(payload.type) ?? "helcim_webhook_received";
  const transactionId = getText(data.transactionId) ?? getText(data.id);
  const invoiceId = getNumber(data.invoiceId);

  return {
    eventId: headers.id,
    eventType,
    helcimTransactionId: transactionId ?? undefined,
    helcimInvoiceId: invoiceId ?? undefined,
    helcimInvoiceNumber: getText(data.invoiceNumber) ?? undefined,
    status: getText(data.status ?? data.paymentStatus ?? data.transactionStatus ?? data.approved) ?? undefined,
    amount: getNumberOrText(data.amount) ?? undefined,
    currency: getText(data.currency) ?? undefined,
  };
}

export function mergeHelcimCardTransactionDetails(
  event: VerifiedHelcimWebhook,
  details: HelcimCardTransactionResponse,
): VerifiedHelcimWebhook {
  const fields = normalizeHelcimCardTransactionDetails(details);

  return {
    ...event,
    amount: fields.amount ?? event.amount,
    approvalCode: fields.approvalCode ?? event.approvalCode,
    cardLast4: fields.cardLast4 ?? event.cardLast4,
    cardType: fields.cardType ?? event.cardType,
    currency: fields.currency ?? event.currency,
    helcimInvoiceNumber: fields.invoiceNumber ?? event.helcimInvoiceNumber,
    helcimTransactionId: fields.transactionId ?? event.helcimTransactionId,
    payloadRedacted: toHelcimPayloadRedacted(fields),
    status: fields.status ?? event.status,
  };
}

export function normalizeHelcimCardTransactionDetails(
  details: HelcimCardTransactionResponse,
): HelcimTransactionReconciliationFields {
  const card = getObject(details.card) ?? getObject(details.cardDetails) ?? getObject(details.paymentCard);
  const amount = getNumberOrText(
    details.amount ?? details.transactionAmount ?? details.amountPaid ?? details.totalAmount,
  );

  return {
    amount: amount ?? undefined,
    approvalCode: getText(details.approvalCode ?? details.authCode ?? details.authorizationCode) ?? undefined,
    cardLast4: getCardLast4(details, card) ?? undefined,
    cardType: getText(
      details.cardType ?? details.cardBrand ?? details.cardNetwork ?? card?.type ?? card?.brand,
    ) ?? undefined,
    currency: getText(details.currency) ?? undefined,
    invoiceNumber: getText(details.invoiceNumber ?? details.invoiceNo) ?? undefined,
    status: getText(details.status ?? details.transactionStatus ?? details.approved) ?? undefined,
    transactionId: getText(details.transactionId ?? details.cardTransactionId ?? details.id) ?? undefined,
  };
}

function toHelcimPayloadRedacted(
  fields: HelcimTransactionReconciliationFields,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

export function getHelcimWebhookHeaders(headers: Headers): HelcimWebhookHeaders | null {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");

  if (!id || !timestamp || !signature) {
    return null;
  }

  return { id, timestamp, signature };
}

function parseJsonObject(rawBody: string): WebhookPayload {
  const parsed: unknown = JSON.parse(rawBody);

  if (!isObject(parsed)) {
    throw new Error("Helcim webhook payload must be a JSON object");
  }

  return parsed;
}

function getObject(value: unknown): WebhookPayload | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is WebhookPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function getNumberOrText(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

function getCardLast4(details: WebhookPayload, card: WebhookPayload | null): string | null {
  return getText(
    details.cardLast4
      ?? details.last4
      ?? details.cardNumberLast4
      ?? card?.last4
      ?? card?.cardLast4
      ?? card?.cardNumberLast4
      ?? getCardNumberLast4(details.cardNumber)
      ?? getCardNumberLast4(card?.cardNumber),
  );
}

function getCardNumberLast4(value: unknown): string | null {
  const cardNumber = getText(value);

  return cardNumber ? cardNumber.slice(-4) : null;
}

function isFreshTimestamp(timestamp: string, now: number): boolean {
  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampMs = Number.parseInt(timestamp, 10) * 1000;

  return Math.abs(now - timestampMs) <= HELCIM_WEBHOOK_MAX_AGE_MS;
}

function getSignatureCandidates(signatureHeader: string): string[] {
  return signatureHeader
    .split(/\s+/)
    .map((signature) => signature.trim())
    .filter((signature) => signature.length > 0)
    .map((signature) => signature.includes(",") ? signature.slice(signature.indexOf(",") + 1) : signature)
    .filter((signature) => signature.length > 0);
}

function timingSafeStringEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

import { validateHelcimResponseHash } from "./helcim-hash";
import type { HelcimPayloadValue } from "./helcim-types";
import { parseCad } from "./money";

interface VerifiedPaymentPersistenceContext {
  error: string;
  orderId: string;
  transactionId: string;
}

interface PersistVerifiedPaymentInput {
  logError?: (message: string, context: VerifiedPaymentPersistenceContext) => void;
  markPaid: (orderId: string, transactionId: string) => Promise<void>;
  orderId: string;
  transactionId: string;
}

export interface VerifiablePendingOrder {
  amount: number;
  currency: string;
  helcimInvoiceId: number;
  helcimInvoiceNumber: string;
}

export type VerifiedPaymentFailureReason =
  | "invalid_hash"
  | "unapproved_payment"
  | "missing_transaction_id"
  | "wrong_amount"
  | "wrong_currency"
  | "wrong_invoice";

export type VerifiedPaymentValidation =
  | { ok: true; transactionId: string }
  | { ok: false; reason: VerifiedPaymentFailureReason };

interface VerifyHelcimPaymentInput {
  data: Record<string, HelcimPayloadValue>;
  hash: string;
  order: VerifiablePendingOrder;
  secretToken: string;
  validateHash?: (
    data: Record<string, HelcimPayloadValue>,
    secretToken: string,
    hash: string,
  ) => boolean;
}

const APPROVED_TEXT_VALUES = new Set(["approved", "completed", "success", "succeeded", "true"]);

export function verifyHelcimPayment({
  data,
  hash,
  order,
  secretToken,
  validateHash = validateHelcimResponseHash,
}: VerifyHelcimPaymentInput): VerifiedPaymentValidation {
  const isValidHash = validateHash(data, secretToken, hash);

  if (!isValidHash) {
    return { ok: false, reason: "invalid_hash" };
  }

  return validateVerifiedPaymentSemantics(data, order);
}

export function validateVerifiedPaymentSemantics(
  data: Record<string, HelcimPayloadValue>,
  order: VerifiablePendingOrder,
): VerifiedPaymentValidation {
  if (!hasApprovedPaymentIndicator(data)) {
    return { ok: false, reason: "unapproved_payment" };
  }

  const transactionId = getTextValue(data.transactionId ?? data.id);

  if (transactionId === null) {
    return { ok: false, reason: "missing_transaction_id" };
  }

  if (!amountMatches(data.amount, order.amount)) {
    return { ok: false, reason: "wrong_amount" };
  }

  if (!currencyMatches(data.currency, order.currency)) {
    return { ok: false, reason: "wrong_currency" };
  }

  if (!invoiceMatches(data, order)) {
    return { ok: false, reason: "wrong_invoice" };
  }

  return { ok: true, transactionId };
}

export async function persistVerifiedPayment({
  logError = console.error,
  markPaid,
  orderId,
  transactionId,
}: PersistVerifiedPaymentInput): Promise<boolean> {
  try {
    await markPaid(orderId, transactionId);
    return true;
  } catch (error) {
    logError("[checkout] Verified payment could not be persisted", {
      error: error instanceof Error ? error.message : "Unknown persistence error",
      orderId,
      transactionId,
    });
    return false;
  }
}

function hasApprovedPaymentIndicator(data: Record<string, HelcimPayloadValue>): boolean {
  if (data.approved === true) {
    return true;
  }

  if (typeof data.approved === "string") {
    return APPROVED_TEXT_VALUES.has(data.approved.trim().toLowerCase());
  }

  const status = getTextValue(data.status ?? data.paymentStatus ?? data.transactionStatus);

  return status !== null && APPROVED_TEXT_VALUES.has(status.trim().toLowerCase());
}

function amountMatches(paymentAmount: HelcimPayloadValue | undefined, orderAmount: number): boolean {
  if (typeof paymentAmount !== "number" && typeof paymentAmount !== "string") {
    return false;
  }

  try {
    return parseCad(paymentAmount) === parseCad(orderAmount);
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }

    return false;
  }
}

function currencyMatches(paymentCurrency: HelcimPayloadValue | undefined, orderCurrency: string): boolean {
  const currency = getTextValue(paymentCurrency);

  return currency === null || currency.trim().toUpperCase() === orderCurrency.toUpperCase();
}

function invoiceMatches(
  data: Record<string, HelcimPayloadValue>,
  order: VerifiablePendingOrder,
): boolean {
  const invoiceId = getTextValue(data.invoiceId);
  const invoiceNumber = getTextValue(data.invoiceNumber);

  if (invoiceId !== null && invoiceId !== String(order.helcimInvoiceId)) {
    return false;
  }

  if (invoiceNumber !== null && invoiceNumber !== order.helcimInvoiceNumber) {
    return false;
  }

  return true;
}

function getTextValue(value: HelcimPayloadValue | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

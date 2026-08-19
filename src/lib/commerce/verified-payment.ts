import { validateHelcimResponseHash } from "./helcim-hash";
import type { HelcimPayloadValue } from "./helcim-types";
import { classifyHelcimTransaction } from "./helcim-contract";
import { parseCad } from "./money";

interface VerifiedPaymentPersistenceContext {
  error: string;
  orderId: string;
  transactionId: string;
}

interface PersistVerifiedPaymentInput {
  logError?: (
    message: string,
    context: VerifiedPaymentPersistenceContext,
  ) => void;
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
  | "unknown_transaction_type"
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
  const classification = classifyHelcimTransaction({
    transactionType:
      getTextValue(data.type ?? data.transactionType) ?? undefined,
    status:
      getTextValue(
        data.status ?? data.paymentStatus ?? data.transactionStatus,
      ) ?? undefined,
  });
  if (classification.kind !== "purchase") {
    return { ok: false, reason: "unknown_transaction_type" };
  }
  if (!classification.successful) {
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
      error:
        error instanceof Error ? error.message : "Unknown persistence error",
      orderId,
      transactionId,
    });
    return false;
  }
}

function amountMatches(
  paymentAmount: HelcimPayloadValue | undefined,
  orderAmount: number,
): boolean {
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

function currencyMatches(
  paymentCurrency: HelcimPayloadValue | undefined,
  orderCurrency: string,
): boolean {
  const currency = getTextValue(paymentCurrency);

  return (
    currency !== null &&
    currency.trim().toUpperCase() === orderCurrency.toUpperCase()
  );
}

function invoiceMatches(
  data: Record<string, HelcimPayloadValue>,
  order: VerifiablePendingOrder,
): boolean {
  const invoiceId = getTextValue(data.invoiceId);
  const invoiceNumber = getTextValue(data.invoiceNumber);

  if (invoiceNumber === null || invoiceNumber !== order.helcimInvoiceNumber) {
    return false;
  }

  return invoiceId === null || invoiceId === String(order.helcimInvoiceId);
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

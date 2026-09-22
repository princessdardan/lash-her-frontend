/** Square Payments API limits for Canadian Afterpay, including tax/shipping.
 * https://developer.squareup.com/docs/payments-api/take-payments
 * Merchant and buyer eligibility can impose lower limits; the SDK checks those.
 */
export const SQUARE_AFTERPAY_MIN_CENTS = 100;
export const SQUARE_AFTERPAY_MAX_CENTS = 200_000;
export const SQUARE_AFTERPAY_LIMIT_MESSAGE =
  "Afterpay is available for eligible totals from C$1 to C$2,000, including tax and shipping, subject to approval.";

export type SquarePaymentMethod = "card" | "afterpay";

export interface SquareCheckoutPayment {
  sourceId: string;
  verificationToken?: string;
  method?: SquarePaymentMethod;
  /** The exact total shown in the Afterpay payment sheet. Never a price source. */
  expectedAmountCents?: number;
}

export function isSquareAfterpayAmountEligible(
  amountCents: number,
  currency = "CAD",
): boolean {
  return (
    currency === "CAD" &&
    Number.isSafeInteger(amountCents) &&
    amountCents >= SQUARE_AFTERPAY_MIN_CENTS &&
    amountCents <= SQUARE_AFTERPAY_MAX_CENTS
  );
}

export function validateSquareAfterpayPayment(
  payment: Pick<SquareCheckoutPayment, "method" | "expectedAmountCents">,
  amountCents: number,
  currency: string,
): string | null {
  if (payment.method !== "afterpay") return null;
  if (!isSquareAfterpayAmountEligible(amountCents, currency))
    return SQUARE_AFTERPAY_LIMIT_MESSAGE;
  if (payment.expectedAmountCents !== amountCents) {
    return "Your total changed. Review the total and try Afterpay again.";
  }
  return null;
}

/** Older card clients may omit method; unknown methods must never become cards. */
export function parseSquareCheckoutPayment(
  value: unknown,
): SquareCheckoutPayment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sourceId !== "string" ||
    !record.sourceId.trim() ||
    record.sourceId.length > 512
  )
    return null;
  if (
    record.method !== undefined &&
    record.method !== "card" &&
    record.method !== "afterpay"
  )
    return null;
  if (
    record.verificationToken !== undefined &&
    (typeof record.verificationToken !== "string" ||
      !record.verificationToken.trim() ||
      record.verificationToken.length > 2048)
  )
    return null;
  if (
    record.method === "afterpay" &&
    (!Number.isSafeInteger(record.expectedAmountCents) ||
      (record.expectedAmountCents as number) <= 0)
  )
    return null;
  return {
    sourceId: record.sourceId.trim(),
    ...(record.method ? { method: record.method } : {}),
    ...(typeof record.verificationToken === "string"
      ? { verificationToken: record.verificationToken.trim() }
      : {}),
    ...(record.method === "afterpay"
      ? { expectedAmountCents: record.expectedAmountCents as number }
      : {}),
  };
}

export function matchesSquarePaymentMethod(
  method: SquarePaymentMethod | undefined,
  sourceType: string | undefined,
): boolean {
  return method === "afterpay"
    ? sourceType === "BUY_NOW_PAY_LATER"
    : sourceType === undefined || sourceType === "CARD";
}

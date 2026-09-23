import {
  isSquareAfterpayAmountEligible,
  parseSquareCheckoutPayment,
  type SquareCheckoutPayment,
} from "./afterpay-policy";

export interface TrainingSplitPayment {
  method: "afterpay_card";
  expectedAmountCents: number;
  afterpayAmountCents: number;
  afterpay: SquareCheckoutPayment;
  card: SquareCheckoutPayment;
}

export function parseTrainingSplitPayment(
  value: unknown,
): TrainingSplitPayment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const afterpay = parseSquareCheckoutPayment(record.afterpay);
  const card = parseSquareCheckoutPayment(record.card);
  if (
    record.method !== "afterpay_card" ||
    !Number.isSafeInteger(record.expectedAmountCents) ||
    !isSquareAfterpayAmountEligible(record.afterpayAmountCents as number) ||
    !afterpay ||
    afterpay.method !== "afterpay" ||
    afterpay.expectedAmountCents !== record.afterpayAmountCents ||
    !card ||
    (card.method !== undefined && card.method !== "card") ||
    afterpay.sourceId === card.sourceId
  )
    return null;
  return {
    method: "afterpay_card",
    expectedAmountCents: record.expectedAmountCents as number,
    afterpayAmountCents: record.afterpayAmountCents as number,
    afterpay,
    card,
  };
}

export function validateTrainingSplitPayment(
  payment: Pick<
    TrainingSplitPayment,
    "expectedAmountCents" | "afterpayAmountCents"
  >,
  totalCents: number,
): string | null {
  if (payment.expectedAmountCents !== totalCents)
    return "Your total changed. Review the total and try again.";
  if (!isSquareAfterpayAmountEligible(payment.afterpayAmountCents))
    return "The Afterpay portion must be between C$1 and C$2,000, subject to approval.";
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents - payment.afterpayAmountCents < 100
  )
    return "The remaining card payment must be at least C$1.";
  return null;
}

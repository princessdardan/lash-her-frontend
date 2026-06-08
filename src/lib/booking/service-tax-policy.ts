/**
 * Ontario HST tax policy for service bookings paid via Square Payment Links.
 *
 * Rules:
 * - 13% HST is applied to the amount paid today only (deposits/full payments).
 * - Tips are excluded from tax.
 * - Amounts are in integer cents and rounded to the nearest cent.
 */

export const SERVICE_BOOKING_HST_POLICY_VERSION =
  "service-booking-hst-on-paid-today-v1";

export const SERVICE_BOOKING_HST_RATE = 0.13;

export const SERVICE_BOOKING_HST_PERCENTAGE = "13";

export const SERVICE_BOOKING_HST_TAX_NAME = "Ontario HST";

export const SERVICE_BOOKING_HST_TAX_UID = "ontario-hst";

export interface ServiceBookingHstQuote {
  expectedAmountCents: number;
  policyVersion: string;
  taxAmountCents: number;
  taxableAmountCents: number;
  taxName: string;
  taxRate: number;
}

/**
 * Calculate Ontario HST for a service booking based on the amount the client
 * pays today. The returned quote includes the original taxable amount, the
 * computed tax, and the expected total amount to be collected.
 *
 * @param amountPaidTodayCents - Positive integer cents paid today (deposit or
 *   full amount). Tips must be excluded before calling this function.
 * @returns A quote object describing the tax calculation.
 * @throws {TypeError} When amountPaidTodayCents is not a positive safe integer.
 */
export function calculateServiceBookingHstQuote(
  amountPaidTodayCents: number,
): ServiceBookingHstQuote {
  if (
    !Number.isFinite(amountPaidTodayCents) ||
    !Number.isInteger(amountPaidTodayCents) ||
    amountPaidTodayCents <= 0
  ) {
    throw new TypeError("amountPaidTodayCents must be a positive integer cents");
  }

  if (!Number.isSafeInteger(amountPaidTodayCents)) {
    throw new TypeError("amountPaidTodayCents must be a safe integer cents");
  }

  const taxAmountCents = Math.round(
    amountPaidTodayCents * SERVICE_BOOKING_HST_RATE,
  );
  const expectedAmountCents = amountPaidTodayCents + taxAmountCents;

  return {
    expectedAmountCents,
    policyVersion: SERVICE_BOOKING_HST_POLICY_VERSION,
    taxAmountCents,
    taxableAmountCents: amountPaidTodayCents,
    taxName: SERVICE_BOOKING_HST_TAX_NAME,
    taxRate: SERVICE_BOOKING_HST_RATE,
  };
}

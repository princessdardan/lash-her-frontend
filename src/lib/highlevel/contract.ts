/** Shared, non-secret contracts. Safe to import in consent controls. */
export const EMAIL_CONSENT_TEXT =
  "I agree to receive marketing emails, updates, and offers from Lash Her by Nataliea. I can unsubscribe at any time.";
export const SMS_CONSENT_TEXT =
  "I agree to receive recurring marketing text messages from Lash Her by Nataliea at the number provided. Consent is optional and is not a condition of purchase or course access. Message and data rates may apply. Reply STOP to unsubscribe or HELP for help.";
export const CONSENT_VERSION = "2026-10-20";
export type MarketingChoices = {
  marketingConsent?: boolean;
  smsMarketingConsent?: boolean;
};
export type CrmEntityType =
  | "submission"
  | "consent"
  | "order"
  | "enrollment"
  | "contact"
  | "delivery";
export type Channel = "email" | "sms";
export type ConsentChoice = "opted_in" | "not_opted_in" | "unsubscribed";
export type Journey =
  | "welcome"
  | "inquiry"
  | "training"
  | "course"
  | "purchase"
  | "reactivation";

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Never guess a country for an international-looking number. Local 10-digit numbers use the site's Canadian default. */
export function normalizePhone(value?: string | null): string | null {
  if (typeof value !== "string" || !value || !/^[+\d\s().-]+$/.test(value))
    return null;
  const digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("+"))
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  if (/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return `+${digits}`;
  return null;
}

export function validateMarketingChoices(
  input: MarketingChoices & { phone?: string | null },
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of ["marketingConsent", "smsMarketingConsent"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean")
      errors[field] = "Choose whether to receive marketing messages.";
  }
  if (input.smsMarketingConsent === true && !normalizePhone(input.phone))
    errors.phone =
      "Enter a valid phone number with country code to receive text messages.";
  return errors;
}

export function validIdentity(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    !email.includes("[redacted]") &&
    !email.endsWith(".invalid")
  );
}

export class HighLevelError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds = 60,
    public readonly ambiguous = false,
  ) {
    super(code);
    this.name = "HighLevelError";
  }
}

export type CheckoutMarketing = MarketingChoices & { phone?: string };
export function parseCheckoutMarketing(
  value: unknown,
): CheckoutMarketing | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input.phone !== undefined &&
    (typeof input.phone !== "string" || input.phone.length > 40)
  )
    return null;
  const choices = input as CheckoutMarketing;
  if (Object.keys(validateMarketingChoices(choices)).length) return null;
  return {
    marketingConsent: choices.marketingConsent === true,
    smsMarketingConsent: choices.smsMarketingConsent === true,
    ...(choices.smsMarketingConsent && choices.phone
      ? { phone: normalizePhone(choices.phone)! }
      : {}),
  };
}

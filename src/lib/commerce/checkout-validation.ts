export const CHECKOUT_CUSTOMER_NAME_MAX_LENGTH = 120;
export const CHECKOUT_EMAIL_MAX_LENGTH = 254;
export const CHECKOUT_SHIPPING_LINE_MAX_LENGTH = 160;
export const CHECKOUT_SHIPPING_LOCALITY_MAX_LENGTH = 80;
export const CHECKOUT_SHIPPING_POSTAL_CODE_MAX_LENGTH = 32;

const EMAIL_PATTERN = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;

export function normalizeCheckoutText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isValidCheckoutEmail(value: string): boolean {
  const email = value.trim().toLowerCase();

  return (
    email.length > 0 &&
    email.length <= CHECKOUT_EMAIL_MAX_LENGTH &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    EMAIL_PATTERN.test(email)
  );
}

export function isValidCheckoutText(value: string, maxLength: number): boolean {
  const normalizedValue = normalizeCheckoutText(value);

  return (
    normalizedValue.length > 0 &&
    normalizedValue.length <= maxLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

export function parseCheckoutText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = normalizeCheckoutText(value);

  return isValidCheckoutText(value, maxLength) ? normalizedValue : null;
}

export function parseOptionalCheckoutText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return null;
  }

  const normalizedValue = normalizeCheckoutText(value);

  if (normalizedValue.length === 0) {
    return undefined;
  }

  return normalizedValue.length <= maxLength ? normalizedValue : null;
}

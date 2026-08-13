import "server-only";

import { createHmac, randomBytes } from "node:crypto";

export type ShippingCustomerTokenPurpose = "decision" | "address-change";

export function issueShippingCustomerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShippingCustomerToken(
  token: string,
  purpose: ShippingCustomerTokenPurpose,
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return invalidTokenHash(purpose);
  return createHmac("sha256", getSecret(purpose)).update(token).digest("hex");
}

function getSecret(purpose: ShippingCustomerTokenPurpose): string {
  const name =
    purpose === "decision"
      ? "SHIPPING_DECISION_TOKEN_SECRET"
      : "ADDRESS_CHANGE_TOKEN_SECRET";
  const value = process.env[name]?.trim();
  if (!value || Buffer.byteLength(value) < 32)
    throw new Error(`${name} must contain at least 32 bytes`);
  return value;
}

function invalidTokenHash(purpose: ShippingCustomerTokenPurpose): string {
  return createHmac("sha256", getSecret(purpose))
    .update("invalid-token")
    .digest("hex");
}

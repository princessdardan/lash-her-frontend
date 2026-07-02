import crypto from "node:crypto";

import {
  SERVICE_NO_SHOW_POLICY_TEXT,
  SERVICE_NO_SHOW_POLICY_VERSION,
} from "./service-no-show-policy-copy";

export { SERVICE_NO_SHOW_POLICY_TEXT, SERVICE_NO_SHOW_POLICY_VERSION };

export interface ServiceNoShowPolicyAcceptanceInput {
  accepted: boolean;
  acceptedAt: Date;
  customerEmail: string;
  customerName: string;
  ipAddress?: string;
  maxChargeCents: number;
  policyText: string;
  userAgent?: string;
}

export interface ServiceNoShowPolicyAcceptance {
  accepted: boolean;
  acceptedAt: string;
  currency: "CAD";
  customerEmail: string;
  customerName: string;
  ipAddressHash?: string;
  maxChargeCents: number;
  policyTextHash: string;
  policyVersion: string;
  userAgentHash?: string;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Produces a stable, comparable form of the no-show policy text.
 * Trims surrounding whitespace, lowercases, and collapses internal
 * whitespace runs to a single space so minor formatting changes do
 * not change the policy identity.
 */
export function normalizeServiceNoShowPolicyText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns the SHA-256 hash of the normalized no-show policy text.
 * Only the hash (not the full mutable UI copy) should be stored in
 * audit metadata.
 */
export function hashServiceNoShowPolicyText(text: string): string {
  return sha256Hex(normalizeServiceNoShowPolicyText(text));
}

/**
 * Hashes an optional audit value (e.g. IP address or user agent) so
 * raw PII is never stored. Returns undefined when the value is absent.
 */
export function hashServiceNoShowAuditValue(
  value?: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return sha256Hex(value);
}

export function getCanonicalServiceNoShowPolicyEvidence(input: {
  acceptedAt: Date;
  customerEmail: string;
  customerName: string;
  ipAddress?: string;
  maxChargeCents: number;
  userAgent?: string;
}): ServiceNoShowPolicyAcceptance {
  return buildServiceNoShowPolicyAcceptance({
    accepted: true,
    policyText: SERVICE_NO_SHOW_POLICY_TEXT,
    ...input,
  });
}

export interface ServiceNoShowChargeAmounts {
  addOnAmountCents?: number;
  serviceAmountCents: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function dollarsToCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Calculates the maximum no-show charge from an explicit amount
 * breakdown or a best-effort extraction from a loose hold/offering
 * snapshot.
 *
 * Explicit cent fields (`serviceAmountCents`, `addOnAmountCents`) are
 * validated as positive safe integers and summed.
 *
 * Real booking snapshots store dollars (`fullPrice` and
 * `selectedAddOn.price`); these are converted to cents with rounding.
 * Negative or non-finite dollar values throw a clear error.
 *
 * Empty snapshots return 0 to stay defensive.
 */
export function calculateServiceNoShowMaxChargeCents(
  holdLike: ServiceNoShowChargeAmounts | Record<string, unknown>,
): number {
  if (typeof holdLike !== "object" || holdLike === null) {
    return 0;
  }

  const record = holdLike as Record<string, unknown>;
  const hasCentFields =
    "serviceAmountCents" in record || "addOnAmountCents" in record;

  if (hasCentFields) {
    if (!isPositiveSafeInteger(record.serviceAmountCents)) {
      throw new Error("serviceAmountCents must be a positive safe integer");
    }

    const serviceAmountCents = record.serviceAmountCents;

    if ("addOnAmountCents" in record) {
      if (!isPositiveSafeInteger(record.addOnAmountCents)) {
        throw new Error("addOnAmountCents must be a positive safe integer");
      }

      return serviceAmountCents + record.addOnAmountCents;
    }

    return serviceAmountCents;
  }

  const hasDollarFields = "fullPrice" in record || "selectedAddOn" in record;

  if (hasDollarFields) {
    let total = 0;

    if ("fullPrice" in record) {
      if (!isFiniteNonNegativeNumber(record.fullPrice)) {
        throw new Error("fullPrice must be a finite non-negative number");
      }

      total += dollarsToCents(record.fullPrice);
    }

    if (
      "selectedAddOn" in record &&
      typeof record.selectedAddOn === "object" &&
      record.selectedAddOn !== null
    ) {
      const addOnRecord = record.selectedAddOn as Record<string, unknown>;

      if ("price" in addOnRecord) {
        if (!isFiniteNonNegativeNumber(addOnRecord.price)) {
          throw new Error(
            "selectedAddOn.price must be a finite non-negative number",
          );
        }

        total += dollarsToCents(addOnRecord.price);
      }
    }

    return total;
  }

  return 0;
}

/**
 * Builds a normalized no-show policy acceptance record suitable for
 * persistent storage. Rejects invalid charge amounts, stores a hash
 * of the policy text, and hashes any provided IP/user-agent values.
 */
export function buildServiceNoShowPolicyAcceptance(
  input: ServiceNoShowPolicyAcceptanceInput,
): ServiceNoShowPolicyAcceptance {
  if (
    !Number.isFinite(input.maxChargeCents) ||
    !Number.isInteger(input.maxChargeCents) ||
    input.maxChargeCents <= 0
  ) {
    throw new Error("maxChargeCents must be a positive integer");
  }

  return {
    accepted: input.accepted,
    acceptedAt: input.acceptedAt.toISOString(),
    currency: "CAD",
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    ipAddressHash: hashServiceNoShowAuditValue(input.ipAddress),
    maxChargeCents: input.maxChargeCents,
    policyTextHash: hashServiceNoShowPolicyText(input.policyText),
    policyVersion: SERVICE_NO_SHOW_POLICY_VERSION,
    userAgentHash: hashServiceNoShowAuditValue(input.userAgent),
  };
}

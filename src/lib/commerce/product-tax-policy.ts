/**
 * Destination-based sales-tax policy for product checkout.
 *
 * Model (owner-attested via `product_tax_policy_versions`; this module encodes
 * the rates that a given attested `version` stands for):
 *
 * - Canada: destination-based GST/HST only. The business is a GST/HST
 *   registrant and is NOT separately registered to collect provincial PST
 *   (BC/SK/MB) or Quebec QST, so those provincial components are not charged.
 *   HST provinces are billed the combined HST; all other provinces/territories
 *   are billed 5% GST.
 * - United States: no tax collected. As a Canadian merchant without US nexus,
 *   we charge $0 US tax; the customer is responsible for any US import
 *   duty/tax, which is disclosed separately via the DDU import notice.
 * - Tax applies to the post-discount merchandise amount and, for shipped
 *   orders, the shipping charge (shipping is taxable in Canada at the
 *   destination rate).
 *
 * IMPORTANT: The rate values below are the rates encoded by
 * PRODUCT_TAX_POLICY_VERSION. They must be verified by the business/accountant
 * before the owner attests this version, and any rate change requires a new
 * version string + a fresh owner attestation. Checkout asserts that the
 * attested version exactly matches PRODUCT_TAX_POLICY_VERSION and fails closed
 * otherwise, so an attested-but-unimplemented version can never charge tax.
 */

export const PRODUCT_TAX_POLICY_VERSION =
  "product-tax-ca-gst-hst-destination-v1";

/** Place of supply for in-studio manual pickup orders (business is in Ontario). */
export const STUDIO_PICKUP_TAX_JURISDICTION = {
  country: "CA",
  region: "ON",
} as const;

interface CanadianDestinationRate {
  rate: number;
  taxName: "HST" | "GST";
}

/**
 * Combined destination GST/HST rate by province/territory. PST (BC/SK/MB) and
 * QST (QC) are intentionally excluded — see the module comment. Verify these
 * against CRA place-of-supply rules before attesting a new policy version.
 */
const CANADIAN_DESTINATION_RATES: Record<string, CanadianDestinationRate> = {
  ON: { rate: 0.13, taxName: "HST" },
  NB: { rate: 0.15, taxName: "HST" },
  NL: { rate: 0.15, taxName: "HST" },
  NS: { rate: 0.14, taxName: "HST" }, // reduced from 15% effective 2025-04-01
  PE: { rate: 0.15, taxName: "HST" },
  AB: { rate: 0.05, taxName: "GST" },
  BC: { rate: 0.05, taxName: "GST" },
  MB: { rate: 0.05, taxName: "GST" },
  SK: { rate: 0.05, taxName: "GST" },
  QC: { rate: 0.05, taxName: "GST" },
  NT: { rate: 0.05, taxName: "GST" },
  NU: { rate: 0.05, taxName: "GST" },
  YT: { rate: 0.05, taxName: "GST" },
};

const CANADIAN_PROVINCE_NAME_TO_CODE: Record<string, string> = {
  ONTARIO: "ON",
  QUEBEC: "QC",
  ALBERTA: "AB",
  "BRITISH COLUMBIA": "BC",
  MANITOBA: "MB",
  SASKATCHEWAN: "SK",
  "NOVA SCOTIA": "NS",
  "NEW BRUNSWICK": "NB",
  NEWFOUNDLAND: "NL",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "PRINCE EDWARD ISLAND": "PE",
  "NORTHWEST TERRITORIES": "NT",
  NUNAVUT: "NU",
  YUKON: "YT",
};

export interface ProductTaxQuote {
  policyVersion: string;
  taxableAmountCents: number;
  taxAmountCents: number;
  taxRate: number;
  taxName: "HST" | "GST" | "None";
  /** e.g. "CA-ON", or "US" when no tax is collected. */
  jurisdiction: string;
  collected: boolean;
}

export interface CalculateProductTaxInput {
  destinationCountry: string;
  destinationRegionCode?: string | null;
  taxableAmountCents: number;
}

/**
 * Normalize a Canadian province/territory to its 2-letter code. Accepts a code
 * or a full name. Returns null when it cannot be resolved to a known code.
 */
export function normalizeCanadianProvinceCode(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  const code = CANADIAN_PROVINCE_NAME_TO_CODE[normalized] ?? normalized;
  return Object.prototype.hasOwnProperty.call(CANADIAN_DESTINATION_RATES, code)
    ? code
    : null;
}

/**
 * Assert the attested tax policy version matches the rates implemented here.
 * Fails closed so an owner-attested version that this build does not implement
 * can never be used to charge tax.
 */
export function assertProductTaxPolicyVersionImplemented(
  attestedVersion: string,
): void {
  if (attestedVersion !== PRODUCT_TAX_POLICY_VERSION) {
    throw new Error(
      `Attested product tax policy version "${attestedVersion}" does not match the implemented version "${PRODUCT_TAX_POLICY_VERSION}"`,
    );
  }
}

/**
 * Compute destination-based product tax in integer cents.
 *
 * @throws {TypeError} when taxableAmountCents is not a non-negative safe integer.
 * @throws {Error} when the destination is Canada but the province is unknown
 *   (fail closed rather than silently under/over-charging).
 */
export function calculateProductTax(
  input: CalculateProductTaxInput,
): ProductTaxQuote {
  const { taxableAmountCents } = input;
  if (
    !Number.isFinite(taxableAmountCents) ||
    !Number.isInteger(taxableAmountCents) ||
    taxableAmountCents < 0
  ) {
    throw new TypeError(
      "taxableAmountCents must be a non-negative integer cents",
    );
  }
  if (!Number.isSafeInteger(taxableAmountCents)) {
    throw new TypeError("taxableAmountCents must be a safe integer cents");
  }

  const country = input.destinationCountry.trim().toUpperCase();

  // Only Canadian destinations are taxed. US (and anything not CA) collects no
  // tax by policy; the customer covers US import duty/tax via the DDU notice.
  if (country !== "CA") {
    return {
      policyVersion: PRODUCT_TAX_POLICY_VERSION,
      taxableAmountCents,
      taxAmountCents: 0,
      taxRate: 0,
      taxName: "None",
      jurisdiction: country || "UNKNOWN",
      collected: false,
    };
  }

  const provinceCode = normalizeCanadianProvinceCode(
    input.destinationRegionCode,
  );
  if (!provinceCode) {
    throw new Error(
      `Unsupported Canadian tax jurisdiction: "${input.destinationRegionCode ?? ""}"`,
    );
  }
  const { rate, taxName } = CANADIAN_DESTINATION_RATES[provinceCode];
  const taxAmountCents = Math.round(taxableAmountCents * rate);

  return {
    policyVersion: PRODUCT_TAX_POLICY_VERSION,
    taxableAmountCents,
    taxAmountCents,
    taxRate: rate,
    taxName,
    jurisdiction: `CA-${provinceCode}`,
    collected: true,
  };
}

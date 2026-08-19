import type { TProductShippingMetadata } from "@/types";

export type ShippingMetadataError =
  | "missing_fulfillment_mode"
  | "missing_weight"
  | "missing_packing_units"
  | "missing_customs_description"
  | "missing_country_of_origin"
  | "us_not_approved"
  | "missing_us_hts"
  | "missing_us_manufacturer"
  | "missing_us_regulatory_certification"
  | "expired_us_regulatory_certification"
  | "us_regulatory_contract_mismatch"
  | "missing_us_additional_tariff_details";

export type ValidatedShippingMetadata = TProductShippingMetadata & {
  fulfillmentMode: "physical";
  weightGrams: number;
  packingUnits: number;
  customsDescription: string;
  countryOfOrigin: string;
  hazardousMaterial?: false;
};

export type ProductCheckoutEligibility =
  | { status: "automated"; metadata: ValidatedShippingMetadata }
  | { status: "manual"; reason: "manual_fulfillment" | "hazardous" }
  | { status: "invalid"; reason: ShippingMetadataError };

export type ProductCheckoutMode = "automated" | "manual";

export interface UsRegulatoryCertificationContext {
  now?: Date;
  usShippingContract?: {
    version: string;
    effectiveFrom: string;
    effectiveUntil: string;
    tariffMetadataSchema: { version: string };
    fdaRequirements: { version: string };
  };
}

export function getProductCheckoutEligibility(
  metadata: TProductShippingMetadata | undefined,
  destination?: "CA" | "US",
  context?: UsRegulatoryCertificationContext,
): ProductCheckoutEligibility {
  if (!metadata?.fulfillmentMode) {
    return { status: "invalid", reason: "missing_fulfillment_mode" };
  }
  if (metadata.fulfillmentMode === "manual") {
    return { status: "manual", reason: "manual_fulfillment" };
  }
  if (metadata.hazardousMaterial) {
    return { status: "manual", reason: "hazardous" };
  }
  if (
    !Number.isInteger(metadata.weightGrams) ||
    (metadata.weightGrams ?? 0) <= 0
  ) {
    return { status: "invalid", reason: "missing_weight" };
  }
  if (
    !Number.isInteger(metadata.packingUnits) ||
    (metadata.packingUnits ?? 0) <= 0
  ) {
    return { status: "invalid", reason: "missing_packing_units" };
  }
  if (!metadata.customsDescription?.trim()) {
    return { status: "invalid", reason: "missing_customs_description" };
  }
  if (!/^[A-Z]{2}$/.test(metadata.countryOfOrigin ?? "")) {
    return { status: "invalid", reason: "missing_country_of_origin" };
  }
  if (destination === "US") {
    if (!metadata.usShippingApproved) {
      return { status: "invalid", reason: "us_not_approved" };
    }
    if (!/^\d{10}$/.test(metadata.hsTariffCode ?? "")) {
      return { status: "invalid", reason: "missing_us_hts" };
    }
    if (!hasCompleteManufacturer(metadata)) {
      return { status: "invalid", reason: "missing_us_manufacturer" };
    }
    const certification = metadata.usRegulatoryCertification;
    if (!hasCompleteRegulatoryCertification(certification)) {
      return {
        status: "invalid",
        reason: "missing_us_regulatory_certification",
      };
    }
    const now = context?.now ?? new Date();
    if (Date.parse(certification.validUntil) <= now.getTime()) {
      return {
        status: "invalid",
        reason: "expired_us_regulatory_certification",
      };
    }
    if (
      context?.usShippingContract &&
      !regulatoryCertificationMatchesContract(
        certification,
        context.usShippingContract,
      )
    ) {
      return { status: "invalid", reason: "us_regulatory_contract_mismatch" };
    }
    if (
      certification.additionalTariffApplicability === "required" &&
      !hasCompleteAdditionalTariffDetails(certification.additionalTariffDetails)
    ) {
      return {
        status: "invalid",
        reason: "missing_us_additional_tariff_details",
      };
    }
  }

  return {
    status: "automated",
    metadata: {
      ...metadata,
      fulfillmentMode: "physical",
      weightGrams: metadata.weightGrams!,
      packingUnits: metadata.packingUnits!,
      customsDescription: metadata.customsDescription.trim(),
      countryOfOrigin: metadata.countryOfOrigin!,
      hazardousMaterial: false,
    },
  };
}

function hasCompleteRegulatoryCertification(
  certification: TProductShippingMetadata["usRegulatoryCertification"],
): certification is NonNullable<
  TProductShippingMetadata["usRegulatoryCertification"]
> {
  if (!certification) return false;
  const reviewedAt = Date.parse(certification.reviewedAt);
  const validUntil = Date.parse(certification.validUntil);
  return (
    certification.version.trim().length > 0 &&
    certification.usShippingContractVersion.trim().length > 0 &&
    certification.tariffMetadataSchemaVersion.trim().length > 0 &&
    certification.fdaRequirementsVersion.trim().length > 0 &&
    certification.evidenceReference.trim().length > 0 &&
    Number.isFinite(reviewedAt) &&
    Number.isFinite(validUntil) &&
    validUntil > reviewedAt &&
    (certification.additionalTariffApplicability === "not_applicable" ||
      certification.additionalTariffApplicability === "required") &&
    (certification.fdaApplicability === "not_applicable" ||
      certification.fdaApplicability === "provider_assessed")
  );
}

function regulatoryCertificationMatchesContract(
  certification: NonNullable<
    TProductShippingMetadata["usRegulatoryCertification"]
  >,
  contract: NonNullable<UsRegulatoryCertificationContext["usShippingContract"]>,
): boolean {
  // The DDU contract's effective window (effectiveFrom/effectiveUntil) is
  // managed outside this storefront and is no longer enforced. A U.S. product is
  // eligible when its SKU certification versions match the active contract's
  // versions (the SKU's own `validUntil` expiry is still checked separately by
  // the caller). Keep these three version equalities in lockstep with the config.
  return (
    certification.usShippingContractVersion === contract.version &&
    certification.tariffMetadataSchemaVersion ===
      contract.tariffMetadataSchema.version &&
    certification.fdaRequirementsVersion === contract.fdaRequirements.version
  );
}

function hasCompleteAdditionalTariffDetails(
  details:
    | NonNullable<
        TProductShippingMetadata["usRegulatoryCertification"]
      >["additionalTariffDetails"]
    | undefined,
): boolean {
  return [details?.steel, details?.copper, details?.aluminum].every(
    (value) => Number.isInteger(value) && value! >= 0 && value! <= 100,
  );
}

export function resolveCheckoutMode(
  eligibilities: ProductCheckoutEligibility[],
): ProductCheckoutMode {
  const invalid = eligibilities.find((entry) => entry.status === "invalid");
  if (invalid?.status === "invalid") {
    throw new Error(
      `Product shipping metadata is incomplete (${invalid.reason})`,
    );
  }
  const modes = new Set(
    eligibilities.map((entry) =>
      entry.status === "automated" ? "automated" : "manual",
    ),
  );
  if (modes.size !== 1) {
    throw new Error("Manual and automated products require separate carts");
  }
  return modes.values().next().value ?? "automated";
}

export function resolveCheckoutModeFromLineItems(
  lineItems: ReadonlyArray<{ checkoutMode?: ProductCheckoutMode }>,
): ProductCheckoutMode {
  const modes = new Set(
    lineItems.map((lineItem) => lineItem.checkoutMode ?? "automated"),
  );
  if (modes.size !== 1) {
    throw new Error("Manual and automated products require separate carts");
  }
  return modes.values().next().value ?? "automated";
}

function hasCompleteManufacturer(metadata: TProductShippingMetadata): boolean {
  const textFieldsComplete = [
    metadata.manufacturerName,
    metadata.manufacturerAddress,
    metadata.manufacturerCity,
    metadata.manufacturerProvinceCode,
    metadata.manufacturerPostalCode,
  ].every((entry) => typeof entry === "string" && entry.trim().length > 0);

  return (
    textFieldsComplete &&
    /^[A-Z]{2}$/.test(metadata.manufacturerCountryCode ?? "")
  );
}

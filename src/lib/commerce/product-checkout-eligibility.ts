import type { TProductShippingMetadata } from "@/types";

export type ShippingMetadataError =
  | "missing_fulfillment_mode"
  | "missing_weight"
  | "missing_packing_units"
  | "missing_customs_description"
  | "missing_country_of_origin"
  | "us_not_approved"
  | "missing_us_hts"
  | "missing_us_manufacturer";

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

export function getProductCheckoutEligibility(
  metadata: TProductShippingMetadata | undefined,
  destination?: "CA" | "US",
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

export function resolveCheckoutMode(
  eligibilities: ProductCheckoutEligibility[],
): "automated" | "manual" {
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

function hasCompleteManufacturer(metadata: TProductShippingMetadata): boolean {
  return [
    metadata.manufacturerName,
    metadata.manufacturerAddress,
    metadata.manufacturerCity,
    metadata.manufacturerProvinceCode,
    metadata.manufacturerPostalCode,
    metadata.manufacturerCountryCode,
  ].every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

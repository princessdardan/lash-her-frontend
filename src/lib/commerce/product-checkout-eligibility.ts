import type { TProductShippingMetadata } from "@/types";

export type ShippingMetadataError =
  | "missing_fulfillment_mode"
  | "missing_weight"
  | "missing_dimensions"
  | "missing_customs_description"
  | "missing_country_of_origin"
  | "us_not_approved"
  | "missing_us_hts";

export type ValidatedShippingMetadata = TProductShippingMetadata & {
  fulfillmentMode: "physical";
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  isRigid: boolean;
  customsDescription: string;
  countryOfOrigin: string;
  hazardousMaterial?: false;
};

export type ProductCheckoutEligibility =
  | { status: "automated"; metadata: ValidatedShippingMetadata }
  | { status: "manual"; reason: "manual_fulfillment" | "hazardous" }
  | { status: "invalid"; reason: ShippingMetadataError };

export type ProductCheckoutMode = "automated" | "manual";

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
    !Number.isInteger(metadata.lengthCm) ||
    (metadata.lengthCm ?? 0) <= 0 ||
    !Number.isInteger(metadata.widthCm) ||
    (metadata.widthCm ?? 0) <= 0 ||
    !Number.isInteger(metadata.heightCm) ||
    (metadata.heightCm ?? 0) <= 0
  ) {
    return { status: "invalid", reason: "missing_dimensions" };
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
    // Manufacturer details are optional: when present they are forwarded to the
    // carrier customs declaration, but they no longer gate U.S. checkout.
  }

  return {
    status: "automated",
    metadata: {
      ...metadata,
      fulfillmentMode: "physical",
      weightGrams: metadata.weightGrams!,
      lengthCm: metadata.lengthCm!,
      widthCm: metadata.widthCm!,
      heightCm: metadata.heightCm!,
      isRigid: metadata.isRigid ?? true,
      customsDescription: metadata.customsDescription.trim(),
      countryOfOrigin: metadata.countryOfOrigin!,
      hazardousMaterial: false,
    },
  };
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

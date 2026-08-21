import type { CartInputItem, ValidatedCart } from "@/lib/commerce/cart";
import { buildValidatedCart } from "@/lib/commerce/cart";
import { getProductCheckoutEligibility } from "@/lib/commerce/product-checkout-eligibility";
import { toCheckoutCatalogProduct } from "@/lib/commerce/product-catalog";
import type {
  TProduct,
  TProductShippingMetadata,
  TPromotionCode,
} from "@/types";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  ProductShipmentCustomsLineSnapshot,
} from "@/lib/private-db/schema";
import {
  allocateDiscountedCustomsValues,
  splitCustomsLineValue,
} from "./customs";
import { selectSmallestPackage, type PackableLine } from "./packing";
import { createShippingFingerprint } from "./quote-token";
import type { CertifiedUsImportDisclosure } from "./quote-token";
import type { ShippingPackageProfile, ShippingRecipient } from "./types";

export interface PrepareShippingQuoteInput {
  items: CartInputItem[];
  products: TProduct[];
  promotionCode?: TPromotionCode | null;
  recipient: ShippingRecipient;
  profiles: ShippingPackageProfile[];
  usShippingEnabled: boolean;
  usImportDisclosure?: CertifiedUsImportDisclosure;
  usShippingContract?: FulfillmentProviderCertificationContractSnapshot;
  now?: Date;
}

export interface PreparedQuoteData {
  cart: ValidatedCart;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  fingerprint: string;
  merchandiseValueCents: number;
  packageSnapshot: ReturnType<typeof selectSmallestPackage>;
  usImportDisclosure?: CertifiedUsImportDisclosure;
}

export function prepareShippingQuote(
  input: PrepareShippingQuoteInput,
): PreparedQuoteData {
  if (input.recipient.countryCode === "US" && !input.usShippingEnabled) {
    throw new ShippingEligibilityError("U.S. shipping is not enabled");
  }
  if (
    input.recipient.countryCode === "US" &&
    (input.usImportDisclosure?.usImportTerms !== "DDU" ||
      !input.usImportDisclosure.usImportDisclosureVersion.trim() ||
      !input.usImportDisclosure.usImportDisclosureText.trim())
  ) {
    throw new ShippingEligibilityError(
      "U.S. DDU shipping certification is unavailable",
    );
  }
  if (
    input.recipient.countryCode === "US" &&
    input.usShippingContract?.importTerms !== "DDU"
  ) {
    throw new ShippingEligibilityError(
      "U.S. SKU certification contract is unavailable",
    );
  }
  if (
    input.recipient.countryCode !== "US" &&
    input.usImportDisclosure !== undefined
  ) {
    throw new ShippingEligibilityError(
      "U.S. import disclosure cannot be applied to this destination",
    );
  }
  const cart = buildValidatedCart(
    input.items,
    input.products.map(toCheckoutCatalogProduct),
    {
      promotionCode: input.promotionCode,
    },
  );
  const productsById = new Map(
    input.products.map((product) => [product._id, product]),
  );
  const prepared = cart.lineItems.map((line) => {
    const product = productsById.get(line.productId);
    if (!product) throw new ShippingEligibilityError("Product is unavailable");
    const variant = product.variants?.find(
      (candidate) => candidate._key === line.variantId,
    );
    const shipping = variant?.shipping ?? product.shipping;
    validateShippingMetadata(shipping, input.recipient.countryCode, {
      now: input.now,
      usShippingContract: input.usShippingContract,
    });
    return { line, shipping } as {
      line: typeof line;
      shipping: Required<
        Pick<
          TProductShippingMetadata,
          | "weightGrams"
          | "lengthCm"
          | "widthCm"
          | "heightCm"
          | "isRigid"
          | "customsDescription"
          | "countryOfOrigin"
        >
      > &
        TProductShippingMetadata;
    };
  });

  const packableLines: PackableLine[] = prepared.map(({ line, shipping }) => ({
    quantity: line.quantity,
    weightGrams: shipping.weightGrams,
    lengthCm: shipping.lengthCm,
    widthCm: shipping.widthCm,
    heightCm: shipping.heightCm,
    isRigid: shipping.isRigid,
  }));
  const packageSnapshot = selectSmallestPackage(packableLines, input.profiles);
  const merchandiseValueCents = toCents(cart.amount);
  const allocations = allocateDiscountedCustomsValues(
    prepared.map(({ line }) => ({
      key: lineKey(line.productId, line.variantId),
      quantity: line.quantity,
      merchandiseTotalCents: toCents(line.total),
    })),
    merchandiseValueCents,
  );
  const customsLines = prepared.flatMap(({ line, shipping }) => {
    const values = splitCustomsLineValue(
      allocations.get(lineKey(line.productId, line.variantId)) ?? 0,
      line.quantity,
    );
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].map(([unitValueCents, quantity]) => ({
      productId: line.productId,
      ...(line.variantId ? { variantId: line.variantId } : {}),
      sku: line.sku,
      description: shipping.customsDescription,
      quantity,
      unitValueCents,
      unitWeightGrams: shipping.weightGrams,
      countryOfOrigin: shipping.countryOfOrigin,
      ...(shipping.hsTariffCode ? { hsTariffCode: shipping.hsTariffCode } : {}),
      ...(shipping.manufacturerName
        ? { manufacturerName: shipping.manufacturerName }
        : {}),
      ...(shipping.manufacturerAddress
        ? { manufacturerAddress: shipping.manufacturerAddress }
        : {}),
      ...(shipping.manufacturerCity
        ? { manufacturerCity: shipping.manufacturerCity }
        : {}),
      ...(shipping.manufacturerProvinceCode
        ? { manufacturerProvinceCode: shipping.manufacturerProvinceCode }
        : {}),
      ...(shipping.manufacturerPostalCode
        ? { manufacturerPostalCode: shipping.manufacturerPostalCode }
        : {}),
      ...(shipping.manufacturerCountryCode
        ? { manufacturerCountryCode: shipping.manufacturerCountryCode }
        : {}),
      ...(shipping.usRegulatoryCertification
        ? {
            usRegulatoryCertification: toRegulatoryCertificationSnapshot(
              shipping.usRegulatoryCertification,
            ),
          }
        : {}),
    }));
  });
  const fingerprint = createShippingFingerprint({
    items: input.items,
    promotionCode: cart.promotionCode ?? null,
    recipient: input.recipient,
    packageSnapshot,
    customsLines,
    merchandiseValueCents,
    ...(input.usImportDisclosure ?? {}),
  });
  return {
    cart,
    customsLines,
    fingerprint,
    merchandiseValueCents,
    packageSnapshot,
    ...(input.usImportDisclosure
      ? { usImportDisclosure: input.usImportDisclosure }
      : {}),
  };
}

export class ShippingEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShippingEligibilityError";
  }
}

function validateShippingMetadata(
  value: TProductShippingMetadata | undefined,
  countryCode: "CA" | "US",
  context: {
    now?: Date;
    usShippingContract?: FulfillmentProviderCertificationContractSnapshot;
  },
): asserts value is Required<
  Pick<
    TProductShippingMetadata,
    | "weightGrams"
    | "lengthCm"
    | "widthCm"
    | "heightCm"
    | "isRigid"
    | "customsDescription"
    | "countryOfOrigin"
  >
> &
  TProductShippingMetadata {
  const eligibility = getProductCheckoutEligibility(
    value,
    countryCode,
    context,
  );
  if (eligibility.status !== "automated") {
    throw new ShippingEligibilityError(
      eligibility.status === "manual"
        ? "Product requires manual fulfillment"
        : `Product shipping metadata is incomplete (${eligibility.reason})`,
    );
  }
}

function lineKey(productId: string, variantId?: string): string {
  return `${productId}:${variantId ?? "default"}`;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

function toRegulatoryCertificationSnapshot(
  certification: NonNullable<
    TProductShippingMetadata["usRegulatoryCertification"]
  >,
): NonNullable<
  ProductShipmentCustomsLineSnapshot["usRegulatoryCertification"]
> {
  const details = certification.additionalTariffDetails;
  return {
    version: certification.version,
    usShippingContractVersion: certification.usShippingContractVersion,
    tariffMetadataSchemaVersion: certification.tariffMetadataSchemaVersion,
    fdaRequirementsVersion: certification.fdaRequirementsVersion,
    evidenceReference: certification.evidenceReference,
    reviewedAt: certification.reviewedAt,
    validUntil: certification.validUntil,
    additionalTariffApplicability: certification.additionalTariffApplicability,
    ...(details &&
    Number.isInteger(details.steel) &&
    Number.isInteger(details.copper) &&
    Number.isInteger(details.aluminum)
      ? {
          additionalTariffDetails: {
            steel: details.steel!,
            copper: details.copper!,
            aluminum: details.aluminum!,
          },
        }
      : {}),
    fdaApplicability: certification.fdaApplicability,
  };
}

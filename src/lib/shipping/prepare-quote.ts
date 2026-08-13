import type {
  CartInputItem,
  CatalogProduct,
  ValidatedCart,
} from "@/lib/commerce/cart";
import { buildValidatedCart } from "@/lib/commerce/cart";
import type {
  TProduct,
  TProductShippingMetadata,
  TPromotionCode,
} from "@/types";
import type { ProductShipmentCustomsLineSnapshot } from "@/lib/private-db/schema";
import {
  allocateDiscountedCustomsValues,
  splitCustomsLineValue,
} from "./customs";
import { selectSmallestPackage, type PackableLine } from "./packing";
import { createShippingFingerprint } from "./quote-token";
import type { ShippingPackageProfile, ShippingRecipient } from "./types";

export interface PrepareShippingQuoteInput {
  items: CartInputItem[];
  products: TProduct[];
  promotionCode?: TPromotionCode | null;
  recipient: ShippingRecipient;
  profiles: ShippingPackageProfile[];
  usShippingEnabled: boolean;
}

export interface PreparedQuoteData {
  cart: ValidatedCart;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  fingerprint: string;
  merchandiseValueCents: number;
  packageSnapshot: ReturnType<typeof selectSmallestPackage>;
}

export function prepareShippingQuote(
  input: PrepareShippingQuoteInput,
): PreparedQuoteData {
  if (input.recipient.countryCode === "US" && !input.usShippingEnabled) {
    throw new ShippingEligibilityError("U.S. shipping is not enabled");
  }
  const cart = buildValidatedCart(
    input.items,
    input.products.map(toCatalogProduct),
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
    validateShippingMetadata(shipping, input.recipient.countryCode);
    return { line, shipping } as {
      line: typeof line;
      shipping: Required<
        Pick<
          TProductShippingMetadata,
          | "weightGrams"
          | "packingUnits"
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
    packingUnits: shipping.packingUnits,
    ...(shipping.minimumPackageTier
      ? { minimumPackageTier: shipping.minimumPackageTier }
      : {}),
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
    }));
  });
  const fingerprint = createShippingFingerprint({
    items: input.items,
    promotionCode: cart.promotionCode ?? null,
    recipient: input.recipient,
    packageSnapshot,
    customsLines,
    merchandiseValueCents,
  });
  return {
    cart,
    customsLines,
    fingerprint,
    merchandiseValueCents,
    packageSnapshot,
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
): asserts value is Required<
  Pick<
    TProductShippingMetadata,
    "weightGrams" | "packingUnits" | "customsDescription" | "countryOfOrigin"
  >
> &
  TProductShippingMetadata {
  if (!value || value.fulfillmentMode !== "physical")
    throw new ShippingEligibilityError("Product requires manual fulfillment");
  if (!Number.isInteger(value.weightGrams) || (value.weightGrams ?? 0) <= 0)
    throw new ShippingEligibilityError("Product shipping weight is missing");
  if (!Number.isInteger(value.packingUnits) || (value.packingUnits ?? 0) <= 0)
    throw new ShippingEligibilityError("Product packing units are missing");
  if (
    !value.customsDescription?.trim() ||
    !/^[A-Z]{2}$/.test(value.countryOfOrigin ?? "")
  )
    throw new ShippingEligibilityError(
      "Product customs metadata is incomplete",
    );
  if (value.hazardousMaterial)
    throw new ShippingEligibilityError(
      "Hazardous products require manual fulfillment",
    );
  if (countryCode === "US") {
    if (!value.usShippingApproved)
      throw new ShippingEligibilityError(
        "A product is not approved for U.S. shipping",
      );
    if (!/^\d{10}$/.test(value.hsTariffCode ?? ""))
      throw new ShippingEligibilityError("U.S. tariff metadata is incomplete");
    if (
      ![
        value.manufacturerName,
        value.manufacturerAddress,
        value.manufacturerCity,
        value.manufacturerProvinceCode,
        value.manufacturerPostalCode,
        value.manufacturerCountryCode,
      ].every((entry) => entry?.trim())
    ) {
      throw new ShippingEligibilityError(
        "U.S. manufacturer metadata is incomplete",
      );
    }
  }
}

function toCatalogProduct(product: TProduct): CatalogProduct {
  return {
    id: product._id,
    sku: product.sku,
    title: product.title,
    price: product.price,
    discountPrice: product.discountPrice,
    currency: product.currency,
    isAvailable: product.isAvailable,
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      discountPrice: variant.discountPrice,
      isAvailable: variant.isAvailable,
    })),
  };
}

function lineKey(productId: string, variantId?: string): string {
  return `${productId}:${variantId ?? "default"}`;
}

function toCents(value: number): number {
  return Math.round(value * 100);
}

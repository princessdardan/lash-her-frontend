import type { CatalogProduct } from "./cart";
import {
  getProductCheckoutEligibility,
  type ProductCheckoutMode,
} from "./product-checkout-eligibility";
import type { TProduct, TProductShippingMetadata } from "@/types";

export function toCheckoutCatalogProduct(product: TProduct): CatalogProduct {
  return {
    id: product._id,
    sku: product.sku,
    title: product.title,
    price: product.price,
    discountPrice: product.discountPrice,
    currency: product.currency,
    isAvailable: product.isAvailable,
    checkoutMode: resolveCheckoutMode(product.shipping, product.isAvailable),
    variants: product.variants?.map((variant) => ({
      id: variant._key,
      sku: variant.sku,
      title: variant.title,
      price: variant.price,
      discountPrice: variant.discountPrice,
      isAvailable: variant.isAvailable,
      options: variant.options?.flatMap((option) =>
        option.name && option.value
          ? [{ label: option.name, value: option.value }]
          : [],
      ),
      checkoutMode: resolveCheckoutMode(
        variant.shipping ?? product.shipping,
        variant.isAvailable,
      ),
    })),
  };
}

/**
 * Resolve the checkout mode for a product/variant. Available items must carry
 * complete shipping metadata, so invalid metadata throws (a real config error
 * that Sanity publish validation should already prevent). Unavailable items
 * can't be purchased, so partial/legacy overrides on them degrade to an
 * undefined mode instead of throwing and 500-ing the whole cart preview.
 */
function resolveCheckoutMode(
  metadata: TProductShippingMetadata | undefined,
  isAvailable: boolean,
): ProductCheckoutMode | undefined {
  const eligibility = getProductCheckoutEligibility(metadata);
  if (eligibility.status === "invalid") {
    if (isAvailable) {
      throw new Error(
        `Product shipping metadata is incomplete (${eligibility.reason})`,
      );
    }
    return undefined;
  }
  return eligibility.status;
}

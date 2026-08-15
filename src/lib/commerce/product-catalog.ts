import type { CatalogProduct } from "./cart";
import { getProductCheckoutEligibility } from "./product-checkout-eligibility";
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
    checkoutMode: getCheckoutMode(product.shipping),
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
      checkoutMode: getCheckoutMode(variant.shipping ?? product.shipping),
    })),
  };
}

function getCheckoutMode(
  metadata: TProductShippingMetadata | undefined,
): "automated" | "manual" {
  const eligibility = getProductCheckoutEligibility(metadata);
  if (eligibility.status === "invalid") {
    throw new Error(
      `Product shipping metadata is incomplete (${eligibility.reason})`,
    );
  }
  return eligibility.status;
}

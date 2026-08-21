import "server-only";

import { log } from "@/lib/logging/logger";
import type { TProduct } from "@/types";

import {
  getProductStockLevels,
  stockLevelKey,
  type ProductStockLevel,
} from "./product-stock-store";

export {
  LOW_STOCK_THRESHOLD,
  stockStatusFor,
  type StockStatus,
} from "./product-stock-status";

function publishedId(id: string): string {
  return id.replace(/^drafts\./, "");
}

function withStock(
  product: TProduct,
  levels: Map<string, ProductStockLevel>,
): TProduct {
  const productId = publishedId(product._id);

  if (product.variants && product.variants.length > 0) {
    let anyTracked = false;
    const variants = product.variants.map((variant) => {
      const level = levels.get(stockLevelKey(productId, variant._key));
      if (!level) return variant; // untracked variant -> unlimited
      anyTracked = true;
      return {
        ...variant,
        availableQuantity: level.available,
        isAvailable: variant.isAvailable && level.available > 0,
      };
    });
    return anyTracked ? { ...product, variants } : product;
  }

  const level = levels.get(stockLevelKey(productId, null));
  if (!level) return product; // untracked product -> unlimited
  return {
    ...product,
    availableQuantity: level.available,
    isAvailable: product.isAvailable && level.available > 0,
  };
}

/**
 * Merge authoritative Postgres stock into storefront products: attaches a live
 * `availableQuantity` for display and flips `isAvailable` to false for any
 * sold-out product/variant so all existing sold-out plumbing (badges, cart
 * validation, variant selector) applies unchanged. Untracked items pass through
 * untouched. This is a best-effort display join — the atomic anti-oversell guard
 * is the reservation at checkout, not this read.
 */
export async function applyStockAvailability(
  products: readonly TProduct[],
): Promise<TProduct[]> {
  if (products.length === 0) return [...products];

  // Stock display is best-effort: if the inventory store is unreachable (e.g.
  // at build-time prerender before the DB is provisioned, or a transient
  // outage), fall back to showing products untracked. Overselling is still
  // prevented by the authoritative reservation guard at checkout.
  let levels: Map<string, ProductStockLevel>;
  try {
    levels = await getProductStockLevels(
      products.map((product) => publishedId(product._id)),
    );
  } catch (error) {
    log(
      "warn",
      "[product-stock] availability lookup failed; showing untracked",
      {
        error: error instanceof Error ? error.message : "unknown",
      },
    );
    return [...products];
  }
  if (levels.size === 0) return [...products];

  return products.map((product) => withStock(product, levels));
}

/** Convenience for a single product. Returns the input unchanged when untracked. */
export async function applyStockAvailabilityToProduct(
  product: TProduct,
): Promise<TProduct> {
  const [withLevels] = await applyStockAvailability([product]);
  return withLevels ?? product;
}

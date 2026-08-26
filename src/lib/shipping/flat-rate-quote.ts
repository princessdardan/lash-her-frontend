import type { ProductShipmentRateSnapshot } from "@/lib/private-db/schema";
import { PRODUCT_SHIPPING_SETTINGS } from "./product-shipping-config";
import {
  DEFAULT_FLAT_RATE_CENTS,
  roundUpToDollarCents,
  type ShippingZoneId,
  type SizeBucketId,
} from "./flat-rate-zones";

/**
 * A cache row's rate fields (the subset checkout needs). Null means the cache had
 * no entry for this zone+bucket and the conservative default applies.
 */
export interface FlatRateCacheEntry {
  postageType: string;
  title: string;
  amountCents: number;
  deliveryMaxBusinessDays: number | null;
}

/** Package type used for a flat-rate parcel when no cache row supplies one. */
export const FLAT_RATE_FALLBACK_POSTAGE_TYPE = "flat_rate_standard";
export const FLAT_RATE_FALLBACK_TITLE = "Standard shipping";

/**
 * Build the single customer-facing rate for a flat-rate order from the cache
 * (or the conservative default on a cache miss). The amount is rounded UP to the
 * next whole dollar. Signature requirement still follows the order's merchandise
 * value so high-value parcels keep signature-on-delivery.
 *
 * Shaped as a {@link ProductShipmentRateSnapshot} so the existing commit path
 * (order-store) consumes it unchanged: `insured`/`tracked` are true, and `id`
 * is a stable synthetic service code. At fulfillment the worker buys the
 * cheapest real service, so `postageType` here is informational.
 */
export function buildFlatRateRate(input: {
  zoneId: ShippingZoneId;
  sizeBucketId: SizeBucketId;
  merchandiseValueCents: number;
  cacheEntry: FlatRateCacheEntry | null;
}): ProductShipmentRateSnapshot {
  const { zoneId, sizeBucketId } = input;
  const baseCents =
    input.cacheEntry?.amountCents ?? DEFAULT_FLAT_RATE_CENTS[zoneId];
  const paymentAmountCents = roundUpToDollarCents(baseCents);
  const signatureRequired =
    input.merchandiseValueCents >=
    PRODUCT_SHIPPING_SETTINGS.signatureThresholdCents;
  return {
    id: `flat:${zoneId}:${sizeBucketId}`,
    postageType:
      input.cacheEntry?.postageType ?? FLAT_RATE_FALLBACK_POSTAGE_TYPE,
    title: input.cacheEntry?.title ?? FLAT_RATE_FALLBACK_TITLE,
    ...(input.cacheEntry?.deliveryMaxBusinessDays != null
      ? { deliveryMaxBusinessDays: input.cacheEntry.deliveryMaxBusinessDays }
      : {}),
    signatureAvailable: true,
    signatureRequired,
    paymentAmountCents,
    insuranceFeeCents: 0,
    insured: true,
    tracked: true,
    raw: {
      flatRate: true,
      zoneId,
      sizeBucketId,
      source: input.cacheEntry ? "cache" : "default",
    },
  };
}

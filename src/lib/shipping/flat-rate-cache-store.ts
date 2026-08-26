import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { shippingRateCache } from "@/lib/private-db/schema";
import type { FlatRateCacheEntry } from "./flat-rate-quote";
import type { ShippingZoneId, SizeBucketId } from "./flat-rate-zones";

/**
 * Read the cached flat rate for a zone + size bucket, or null when the cache has
 * no entry yet (caller applies the conservative default so a gap never blocks a
 * sale).
 */
export async function readFlatRateCacheEntry(
  zoneId: ShippingZoneId,
  sizeBucketId: SizeBucketId,
): Promise<FlatRateCacheEntry | null> {
  const [row] = await getPrivateDb()
    .select({
      postageType: shippingRateCache.postageType,
      title: shippingRateCache.title,
      amountCents: shippingRateCache.amountCents,
      deliveryMaxBusinessDays: shippingRateCache.deliveryMaxBusinessDays,
    })
    .from(shippingRateCache)
    .where(
      and(
        eq(shippingRateCache.zoneId, zoneId),
        eq(shippingRateCache.sizeBucketId, sizeBucketId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    postageType: row.postageType,
    title: row.title,
    amountCents: row.amountCents,
    deliveryMaxBusinessDays: row.deliveryMaxBusinessDays,
  };
}

export interface FlatRateCacheUpsert {
  zoneId: ShippingZoneId;
  sizeBucketId: SizeBucketId;
  countryCode: "CA" | "US";
  postageType: string;
  title: string;
  amountCents: number;
  deliveryMaxBusinessDays: number | null;
}

/**
 * Upsert one zone × size-bucket cache entry (used by the refresh cron). Keyed on
 * the unique (zone_id, size_bucket_id) index; refreshing overwrites the price
 * and stamps `computed_at`.
 */
export async function upsertFlatRateCacheEntry(
  input: FlatRateCacheUpsert,
  now: Date,
): Promise<void> {
  await getPrivateDb()
    .insert(shippingRateCache)
    .values({
      zoneId: input.zoneId,
      sizeBucketId: input.sizeBucketId,
      countryCode: input.countryCode,
      postageType: input.postageType,
      title: input.title,
      amountCents: input.amountCents,
      currency: "CAD",
      deliveryMaxBusinessDays: input.deliveryMaxBusinessDays,
      insured: true,
      tracked: true,
      computedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [shippingRateCache.zoneId, shippingRateCache.sizeBucketId],
      set: {
        countryCode: input.countryCode,
        postageType: input.postageType,
        title: input.title,
        amountCents: input.amountCents,
        deliveryMaxBusinessDays: input.deliveryMaxBusinessDays,
        computedAt: now,
        updatedAt: now,
      },
    });
}

/** Total cached entries (a health signal — the cron should keep this full). */
export async function countFlatRateCacheEntries(): Promise<number> {
  const [row] = await getPrivateDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(shippingRateCache);
  return row?.count ?? 0;
}

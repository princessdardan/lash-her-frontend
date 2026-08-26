import type { ProductShipmentPackageSnapshot } from "@/lib/private-db/schema";
import type { ShippingCountryCode } from "./types";

/**
 * Flat-rate shipping model.
 *
 * Customer-facing shipping cost is served from a precomputed cache keyed by
 * `{regional destination zone × parcel size bucket}` rather than a live per-order
 * carrier quote. A scheduled job prices a representative parcel per bucket to a
 * representative destination per zone (see {@link REPRESENTATIVE_PARCELS} /
 * {@link REPRESENTATIVE_DESTINATIONS}); checkout resolves an order's zone + size
 * bucket, reads the cached cents, rounds UP to the next dollar, and shows one
 * flat price. The real carrier label is still bought at fulfillment; the flat
 * price is final and the studio absorbs any variance.
 *
 * Everything here is source-controlled and owner-tunable. Zone membership and
 * bucket thresholds can change without touching the cache mechanics.
 */

export const SHIPPING_ZONE_IDS = [
  // Canada — origin province first, then by distance band.
  "ca_on",
  "ca_qc_atlantic",
  "ca_prairies",
  "ca_bc",
  "ca_north",
  // United States — Census regions.
  "us_northeast",
  "us_midwest",
  "us_south",
  "us_west",
] as const;

export type ShippingZoneId = (typeof SHIPPING_ZONE_IDS)[number];

/** Region (province/state) code → zone. Codes are 2-letter uppercase. */
const ZONE_BY_REGION: Record<string, ShippingZoneId> = {
  // Canada
  ON: "ca_on",
  QC: "ca_qc_atlantic",
  NB: "ca_qc_atlantic",
  NS: "ca_qc_atlantic",
  PE: "ca_qc_atlantic",
  NL: "ca_qc_atlantic",
  MB: "ca_prairies",
  SK: "ca_prairies",
  AB: "ca_prairies",
  BC: "ca_bc",
  YT: "ca_north",
  NT: "ca_north",
  NU: "ca_north",
  // United States — Northeast
  CT: "us_northeast",
  ME: "us_northeast",
  MA: "us_northeast",
  NH: "us_northeast",
  RI: "us_northeast",
  VT: "us_northeast",
  NJ: "us_northeast",
  NY: "us_northeast",
  PA: "us_northeast",
  // Midwest
  IL: "us_midwest",
  IN: "us_midwest",
  MI: "us_midwest",
  OH: "us_midwest",
  WI: "us_midwest",
  IA: "us_midwest",
  KS: "us_midwest",
  MN: "us_midwest",
  MO: "us_midwest",
  NE: "us_midwest",
  ND: "us_midwest",
  SD: "us_midwest",
  // South
  DE: "us_south",
  FL: "us_south",
  GA: "us_south",
  MD: "us_south",
  NC: "us_south",
  SC: "us_south",
  VA: "us_south",
  DC: "us_south",
  WV: "us_south",
  AL: "us_south",
  KY: "us_south",
  MS: "us_south",
  TN: "us_south",
  AR: "us_south",
  LA: "us_south",
  OK: "us_south",
  TX: "us_south",
  // West
  AZ: "us_west",
  CO: "us_west",
  ID: "us_west",
  MT: "us_west",
  NV: "us_west",
  NM: "us_west",
  UT: "us_west",
  WY: "us_west",
  AK: "us_west",
  CA: "us_west",
  HI: "us_west",
  OR: "us_west",
  WA: "us_west",
};

/**
 * Conservative fallback zone per country for an unrecognized region code — the
 * most-distant (most expensive) band, so an unknown region is never
 * under-priced. Paired with a conservative default rate at lookup time.
 */
const FALLBACK_ZONE: Record<ShippingCountryCode, ShippingZoneId> = {
  CA: "ca_north",
  US: "us_west",
};

/** Resolve an order's destination to a regional shipping zone. */
export function resolveShippingZone(
  countryCode: ShippingCountryCode,
  regionCode: string,
): ShippingZoneId {
  const normalized = regionCode.trim().toUpperCase();
  const zone = ZONE_BY_REGION[normalized];
  if (zone && zone.startsWith(countryCode === "US" ? "us_" : "ca_")) {
    return zone;
  }
  return FALLBACK_ZONE[countryCode];
}

export const SIZE_BUCKET_IDS = ["xs", "s", "m", "l", "xl", "xxl"] as const;
export type SizeBucketId = (typeof SIZE_BUCKET_IDS)[number];

/** Volumetric divisor (cm³ per kg) used for dimensional weight. Carrier-typical. */
export const DIM_WEIGHT_DIVISOR_CM3_PER_KG = 5000;

/**
 * Size buckets by billable weight (the greater of actual and dimensional
 * weight). Ordered ascending; the last bucket is the open-ended overflow.
 */
const BILLABLE_WEIGHT_BUCKETS: ReadonlyArray<{
  id: SizeBucketId;
  maxBillableGrams: number;
}> = [
  { id: "xs", maxBillableGrams: 250 },
  { id: "s", maxBillableGrams: 500 },
  { id: "m", maxBillableGrams: 1000 },
  { id: "l", maxBillableGrams: 2000 },
  { id: "xl", maxBillableGrams: 3000 },
  { id: "xxl", maxBillableGrams: Number.POSITIVE_INFINITY },
];

/** Dimensional weight (grams) for a parcel's outer dimensions. */
export function dimensionalWeightGrams(
  lengthCm: number,
  widthCm: number,
  heightCm: number,
): number {
  const volumeCm3 = lengthCm * widthCm * heightCm;
  return Math.ceil((volumeCm3 / DIM_WEIGHT_DIVISOR_CM3_PER_KG) * 1000);
}

/** Billable weight (grams): the greater of actual and dimensional weight. */
export function billableWeightGrams(
  snapshot: Pick<
    ProductShipmentPackageSnapshot,
    "totalWeightGrams" | "lengthCm" | "widthCm" | "heightCm"
  >,
): number {
  return Math.max(
    snapshot.totalWeightGrams,
    dimensionalWeightGrams(
      snapshot.lengthCm,
      snapshot.widthCm,
      snapshot.heightCm,
    ),
  );
}

/** Resolve an order's packed parcel to a size bucket by billable weight. */
export function resolveSizeBucket(
  snapshot: Pick<
    ProductShipmentPackageSnapshot,
    "totalWeightGrams" | "lengthCm" | "widthCm" | "heightCm"
  >,
): SizeBucketId {
  const billable = billableWeightGrams(snapshot);
  const bucket = BILLABLE_WEIGHT_BUCKETS.find(
    (candidate) => billable <= candidate.maxBillableGrams,
  );
  // The last bucket is open-ended, so `find` always matches.
  return (
    bucket ?? BILLABLE_WEIGHT_BUCKETS[BILLABLE_WEIGHT_BUCKETS.length - 1]!
  ).id;
}

export interface RepresentativeParcel {
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

/**
 * A representative parcel per size bucket that lands in that bucket, used by the
 * refresh job to price the bucket. Weight is set at the bucket ceiling so the
 * cached rate is conservative for the whole bucket.
 */
export const REPRESENTATIVE_PARCELS: Record<
  SizeBucketId,
  RepresentativeParcel
> = {
  xs: { weightGrams: 250, lengthCm: 20, widthCm: 15, heightCm: 3 },
  s: { weightGrams: 500, lengthCm: 25, widthCm: 18, heightCm: 4 },
  m: { weightGrams: 1000, lengthCm: 30, widthCm: 22, heightCm: 6 },
  l: { weightGrams: 2000, lengthCm: 34, widthCm: 24, heightCm: 8 },
  xl: { weightGrams: 3000, lengthCm: 36, widthCm: 26, heightCm: 12 },
  xxl: { weightGrams: 4500, lengthCm: 40, widthCm: 30, heightCm: 18 },
};

export interface RepresentativeDestination {
  city: string;
  province: string;
  postalCode: string;
  countryCode: ShippingCountryCode;
}

/** A representative destination per zone for the refresh job's rate query. */
export const REPRESENTATIVE_DESTINATIONS: Record<
  ShippingZoneId,
  RepresentativeDestination
> = {
  ca_on: {
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 2T6",
    countryCode: "CA",
  },
  ca_qc_atlantic: {
    city: "Montreal",
    province: "QC",
    postalCode: "H2Y 1C6",
    countryCode: "CA",
  },
  ca_prairies: {
    city: "Calgary",
    province: "AB",
    postalCode: "T2P 1J9",
    countryCode: "CA",
  },
  ca_bc: {
    city: "Vancouver",
    province: "BC",
    postalCode: "V6B 1A1",
    countryCode: "CA",
  },
  ca_north: {
    city: "Whitehorse",
    province: "YT",
    postalCode: "Y1A 2C6",
    countryCode: "CA",
  },
  us_northeast: {
    city: "New York",
    province: "NY",
    postalCode: "10001",
    countryCode: "US",
  },
  us_midwest: {
    city: "Chicago",
    province: "IL",
    postalCode: "60601",
    countryCode: "US",
  },
  us_south: {
    city: "Atlanta",
    province: "GA",
    postalCode: "30303",
    countryCode: "US",
  },
  us_west: {
    city: "Los Angeles",
    province: "CA",
    postalCode: "90012",
    countryCode: "US",
  },
};

/**
 * Conservative default flat rate (cents, pre-rounding) per zone, used only when
 * the cache has no entry for a zone+bucket (a refresh gap). Deliberately on the
 * high side so a gap over-charges slightly rather than blocking the sale or
 * under-charging the studio. Tunable.
 */
export const DEFAULT_FLAT_RATE_CENTS: Record<ShippingZoneId, number> = {
  ca_on: 1500,
  ca_qc_atlantic: 1800,
  ca_prairies: 2000,
  ca_bc: 2000,
  ca_north: 3500,
  us_northeast: 2800,
  us_midwest: 2800,
  us_south: 2800,
  us_west: 3000,
};

/** Round a cents amount UP to the next whole dollar (customer-facing rule). */
export function roundUpToDollarCents(amountCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.ceil(amountCents / 100) * 100;
}

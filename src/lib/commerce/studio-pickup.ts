/**
 * The single Lash Her studio pickup location. Customers who choose "pick up at
 * the studio" at checkout collect their order here; the order is fulfilled with
 * no shipping cost and taxed at the studio's place of supply
 * ({@link STUDIO_PICKUP_TAX_JURISDICTION} in product-tax-policy — Ontario).
 *
 * Source-controlled because there is exactly one location and it rarely changes;
 * it mirrors the address the public site's structured data already publishes. If
 * the studio ever moves, update this constant (and the Sanity contact record).
 */
export interface StudioPickupLocation {
  name: string;
  addressLine: string;
  city: string;
  regionCode: string;
  country: string;
}

export const STUDIO_PICKUP_LOCATION: StudioPickupLocation = {
  name: "Lash Her Studio",
  addressLine: "646 Oakwood Avenue",
  city: "Toronto",
  regionCode: "ON",
  country: "Canada",
};

/** Single-line, human-readable rendering of the studio pickup address. */
export function formatStudioPickupAddress(
  location: StudioPickupLocation = STUDIO_PICKUP_LOCATION,
): string {
  return `${location.addressLine}, ${location.city}, ${location.regionCode}`;
}

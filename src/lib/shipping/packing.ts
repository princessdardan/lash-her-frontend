import type { ProductShipmentPackageSnapshot } from "@/lib/private-db/schema";
import type { ShippingPackageProfile } from "./types";

/**
 * Clearance added to each axis of the stacked item footprint when testing box
 * fit, so items are never selected into a box with zero wiggle room. This only
 * affects box SELECTION; the parcel reported to the carrier is the chosen box's
 * own real dimensions. Tunable.
 */
export const PACKAGING_CLEARANCE_CM = 1;

export interface PackableLine {
  quantity: number;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  isRigid: boolean;
}

export function selectSmallestPackage(
  lines: readonly PackableLine[],
  profiles: readonly ShippingPackageProfile[],
): ProductShipmentPackageSnapshot {
  if (lines.length === 0) throw new Error("Shipping cart is empty");

  const contentsWeight = lines.reduce(
    (sum, line) =>
      sum +
      positiveInteger(line.weightGrams, "weight") *
        positiveInteger(line.quantity, "quantity"),
    0,
  );

  // Option A packing: every unit shares the largest footprint and stacks on the
  // height axis, plus a clearance allowance. Used only to choose a box; the
  // parcel we report to the carrier is the chosen box itself.
  let footprintLength = 0;
  let footprintWidth = 0;
  let stackedHeight = 0;
  let requiresRigidCapablePackage = false;
  for (const line of lines) {
    const quantity = positiveInteger(line.quantity, "quantity");
    footprintLength = Math.max(
      footprintLength,
      positiveInteger(line.lengthCm, "length"),
    );
    footprintWidth = Math.max(
      footprintWidth,
      positiveInteger(line.widthCm, "width"),
    );
    stackedHeight += positiveInteger(line.heightCm, "height") * quantity;
    if (line.isRigid) requiresRigidCapablePackage = true;
  }
  const requiredSpace: [number, number, number] = [
    footprintLength + PACKAGING_CLEARANCE_CM,
    footprintWidth + PACKAGING_CLEARANCE_CM,
    stackedHeight + PACKAGING_CLEARANCE_CM,
  ];

  const selected = [...profiles]
    .filter((profile) => profile.enabled)
    .sort((left, right) => left.rank - right.rank)
    .find(
      (profile) =>
        (profile.acceptsRigid || !requiresRigidCapablePackage) &&
        fitsWithinAnyOrientation(requiredSpace, [
          profile.lengthCm,
          profile.widthCm,
          profile.heightCm,
        ]) &&
        profile.maxWeightGrams >= contentsWeight + profile.tareWeightGrams,
    );

  if (!selected)
    throw new Error("No configured package can safely contain this order");

  return {
    profileId: selected.id,
    profileSlug: selected.slug,
    packageType: selected.packageType,
    lengthCm: selected.lengthCm,
    widthCm: selected.widthCm,
    heightCm: selected.heightCm,
    tareWeightGrams: selected.tareWeightGrams,
    totalWeightGrams: contentsWeight + selected.tareWeightGrams,
  };
}

/**
 * Fits the required space inside a box allowing free rotation: sort both
 * triples descending and compare axis-by-axis so a 30x20x5 need is not wrongly
 * rejected by a 20x30x5 box.
 */
function fitsWithinAnyOrientation(
  required: readonly [number, number, number],
  boxDimensions: readonly [number, number, number],
): boolean {
  const need = [...required].sort((left, right) => right - left);
  const have = [...boxDimensions].sort((left, right) => right - left);
  return need.every((value, index) => value <= have[index]!);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid shipping ${label}`);
  }
  return value;
}

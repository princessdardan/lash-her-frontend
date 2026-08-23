import type { ProductShipmentPackageSnapshot } from "@/lib/private-db/schema";
import type { ShippingPackageProfile } from "./types";

/**
 * Clearance reserved on each axis when testing box fit, so items are never
 * selected into a box with zero wiggle room. This only affects box SELECTION;
 * the parcel reported to the carrier is the chosen box's own real dimensions.
 * Tunable.
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

  // Validate every field up front (throws "Invalid shipping <x>") and gather the
  // aggregates the box search needs.
  let contentsWeight = 0;
  let requiresRigidCapablePackage = false;
  for (const line of lines) {
    const quantity = positiveInteger(line.quantity, "quantity");
    contentsWeight += positiveInteger(line.weightGrams, "weight") * quantity;
    positiveInteger(line.lengthCm, "length");
    positiveInteger(line.widthCm, "width");
    positiveInteger(line.heightCm, "height");
    if (line.isRigid) requiresRigidCapablePackage = true;
  }

  const selected = [...profiles]
    .filter((profile) => profile.enabled)
    .sort((left, right) => left.rank - right.rank)
    .find(
      (profile) =>
        (profile.acceptsRigid || !requiresRigidCapablePackage) &&
        profile.maxWeightGrams >= contentsWeight + profile.tareWeightGrams &&
        canContain(lines, profile),
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
 * A box can contain the order if EITHER packing model succeeds. Both are sound
 * (a "true" result is a concrete arrangement that physically fits), so their
 * union is also sound while accepting strictly more orders than either alone:
 *
 *  - Stacking model: every unit shares one footprint column and stacks on the
 *    height axis. Wins for tall/awkward single items and mixed footprints.
 *  - Floor-tiling model: units are laid out in a grid across the box floor and
 *    then in layers up the height. Wins for many thin items (e.g. lash trays)
 *    that the stacking model wrongly rejects by piling them into one tower.
 */
function canContain(
  lines: readonly PackableLine[],
  profile: ShippingPackageProfile,
): boolean {
  const box: [number, number, number] = [
    profile.lengthCm,
    profile.widthCm,
    profile.heightCm,
  ];
  return fitsByStacking(lines, box) || fitsByFloorTiling(lines, box);
}

/**
 * Every unit shares the largest footprint and stacks on the height axis, plus a
 * clearance allowance, then the whole tower is tested against the box in any
 * orientation. Conservative for many-item carts but robust for a single item
 * that is large on two axes.
 */
function fitsByStacking(
  lines: readonly PackableLine[],
  box: readonly [number, number, number],
): boolean {
  let footprintLength = 0;
  let footprintWidth = 0;
  let stackedHeight = 0;
  for (const line of lines) {
    footprintLength = Math.max(footprintLength, line.lengthCm);
    footprintWidth = Math.max(footprintWidth, line.widthCm);
    stackedHeight += line.heightCm * line.quantity;
  }
  return fitsWithinAnyOrientation(
    [
      footprintLength + PACKAGING_CLEARANCE_CM,
      footprintWidth + PACKAGING_CLEARANCE_CM,
      stackedHeight + PACKAGING_CLEARANCE_CM,
    ],
    box,
  );
}

/**
 * Lays the units out in an axis-aligned grid across the box floor and stacks
 * that grid in layers up the remaining axis, allowing 90° rotations of the
 * items and of which box axis is treated as "up". Mixed carts use a conservative
 * uniform bound — every unit is treated as the per-axis maximum across all lines
 * — so the capacity is never overstated (a "fits" result always holds for the
 * real, smaller items). One clearance allowance is reserved on each box axis.
 */
function fitsByFloorTiling(
  lines: readonly PackableLine[],
  box: readonly [number, number, number],
): boolean {
  const interior: [number, number, number] = [
    box[0] - PACKAGING_CLEARANCE_CM,
    box[1] - PACKAGING_CLEARANCE_CM,
    box[2] - PACKAGING_CLEARANCE_CM,
  ];
  if (interior.some((dimension) => dimension <= 0)) return false;

  let itemLength = 0;
  let itemWidth = 0;
  let itemHeight = 0;
  let totalUnits = 0;
  for (const line of lines) {
    itemLength = Math.max(itemLength, line.lengthCm);
    itemWidth = Math.max(itemWidth, line.widthCm);
    itemHeight = Math.max(itemHeight, line.heightCm);
    totalUnits += line.quantity;
  }

  return (
    gridCapacity([itemLength, itemWidth, itemHeight], interior) >= totalUnits
  );
}

/**
 * Maximum whole units of a single item box that tile into a container, trying
 * every axis-aligned orientation of the item.
 */
function gridCapacity(
  item: readonly [number, number, number],
  container: readonly [number, number, number],
): number {
  let best = 0;
  for (const [a, b, c] of orientations(item)) {
    const capacity =
      Math.floor(container[0] / a) *
      Math.floor(container[1] / b) *
      Math.floor(container[2] / c);
    if (capacity > best) best = capacity;
  }
  return best;
}

/** The six axis-aligned orientations of a box triple. */
function orientations(
  triple: readonly [number, number, number],
): Array<[number, number, number]> {
  const [x, y, z] = triple;
  return [
    [x, y, z],
    [x, z, y],
    [y, x, z],
    [y, z, x],
    [z, x, y],
    [z, y, x],
  ];
}

/**
 * Fits the required space inside a box allowing free rotation: sort both triples
 * descending and compare axis-by-axis so a 30x20x5 need is not wrongly rejected
 * by a 20x30x5 box.
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

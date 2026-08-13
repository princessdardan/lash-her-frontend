import type { ProductShipmentPackageSnapshot } from "@/lib/private-db/schema";
import type { ShippingPackageProfile } from "./types";

export interface PackableLine {
  quantity: number;
  packingUnits: number;
  weightGrams: number;
  minimumPackageTier?: string;
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
  const units = lines.reduce(
    (sum, line) =>
      sum +
      positiveInteger(line.packingUnits, "packing units") *
        positiveInteger(line.quantity, "quantity"),
    0,
  );
  const requiredRank = Math.max(
    0,
    ...lines.map((line) => {
      if (!line.minimumPackageTier) return 0;
      const profile = profiles.find(
        (candidate) => candidate.slug === line.minimumPackageTier,
      );
      if (!profile)
        throw new Error(
          `Unknown minimum package tier: ${line.minimumPackageTier}`,
        );
      return profile.rank;
    }),
  );

  const selected = [...profiles]
    .filter((profile) => profile.enabled)
    .sort((left, right) => left.rank - right.rank)
    .find(
      (profile) =>
        profile.rank >= requiredRank &&
        profile.capacityUnits >= units &&
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid shipping ${label}`);
  }
  return value;
}

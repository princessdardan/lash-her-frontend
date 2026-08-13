import assert from "node:assert/strict";
import test from "node:test";
import { selectSmallestPackage } from "./packing";

const profiles = [
  {
    id: "small",
    slug: "small",
    name: "Small",
    rank: 10,
    packageType: "thick_envelope",
    lengthCm: 20,
    widthCm: 15,
    heightCm: 4,
    tareWeightGrams: 40,
    maxWeightGrams: 500,
    capacityUnits: 2,
    enabled: true,
  },
  {
    id: "large",
    slug: "large",
    name: "Large",
    rank: 20,
    packageType: "parcel",
    lengthCm: 30,
    widthCm: 20,
    heightCm: 10,
    tareWeightGrams: 100,
    maxWeightGrams: 2000,
    capacityUnits: 8,
    enabled: true,
  },
];

test("selectSmallestPackage selects the lowest fitting enabled profile", () => {
  const packed = selectSmallestPackage(
    [{ quantity: 2, packingUnits: 1, weightGrams: 100 }],
    profiles,
  );
  assert.equal(packed.profileSlug, "small");
  assert.equal(packed.totalWeightGrams, 240);
});

test("selectSmallestPackage respects minimum tiers and total packed weight", () => {
  assert.equal(
    selectSmallestPackage(
      [
        {
          quantity: 1,
          packingUnits: 1,
          weightGrams: 100,
          minimumPackageTier: "large",
        },
      ],
      profiles,
    ).profileSlug,
    "large",
  );
  assert.equal(
    selectSmallestPackage(
      [{ quantity: 2, packingUnits: 1, weightGrams: 300 }],
      profiles,
    ).profileSlug,
    "large",
  );
});

test("selectSmallestPackage fails when no profile fits", () => {
  assert.throws(
    () =>
      selectSmallestPackage(
        [{ quantity: 10, packingUnits: 2, weightGrams: 500 }],
        profiles,
      ),
    /No configured package/,
  );
});

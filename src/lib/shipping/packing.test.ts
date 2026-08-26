import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGING_CLEARANCE_CM,
  SYNTHETIC_PACKAGE_PROFILE_SLUG,
  SYNTHETIC_PACKAGE_TARE_WEIGHT_GRAMS,
  selectSmallestPackage,
} from "./packing";
import type { ShippingPackageProfile } from "./types";

const profiles: ShippingPackageProfile[] = [
  {
    id: "box-30x22x5",
    slug: "mailer-box-30x22x5",
    name: "Mailer box 30 × 22 × 5 cm",
    rank: 10,
    packageType: "parcel",
    lengthCm: 30,
    widthCm: 22,
    heightCm: 5,
    tareWeightGrams: 90,
    maxWeightGrams: 2000,
    acceptsRigid: true,
    enabled: true,
  },
  {
    id: "box-36x26x4",
    slug: "mailer-box-36x26x4",
    name: "Mailer box 36 × 26 × 4 cm",
    rank: 20,
    packageType: "parcel",
    lengthCm: 36,
    widthCm: 26,
    heightCm: 4,
    tareWeightGrams: 120,
    maxWeightGrams: 3000,
    acceptsRigid: true,
    enabled: true,
  },
];

test("selects the smallest box that fits and reports its real dimensions", () => {
  const packed = selectSmallestPackage(
    [
      {
        quantity: 2,
        weightGrams: 100,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 1,
        isRigid: true,
      },
    ],
    profiles,
  );
  // Two 1 cm items stack to 2 cm on a 12x8 footprint — fits the smaller box.
  assert.equal(packed.profileSlug, "mailer-box-30x22x5");
  assert.equal(packed.packageType, "parcel");
  assert.equal(packed.lengthCm, 30);
  assert.equal(packed.widthCm, 22);
  assert.equal(packed.heightCm, 5);
  assert.equal(packed.totalWeightGrams, 100 * 2 + 90);
});

test("escalates to the larger box when the footprint is too big for the smaller one", () => {
  // 34 cm long (+1 clearance) exceeds the 30 cm box but fits the 36 cm box.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 200,
        lengthCm: 34,
        widthCm: 24,
        heightCm: 2,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, "mailer-box-36x26x4");
});

test("escalates to the larger box when the smaller box is over its weight limit", () => {
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 2500,
        lengthCm: 10,
        widthCm: 10,
        heightCm: 2,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, "mailer-box-36x26x4");
});

test("normalizes orientation so a rotated item still fits", () => {
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 100,
        lengthCm: 5,
        widthCm: 25,
        heightCm: 4,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, "mailer-box-30x22x5");
});

test("skips a flexible-only package when the contents are rigid", () => {
  const withPolyMailer: ShippingPackageProfile[] = [
    {
      id: "poly-mailer",
      slug: "poly-mailer",
      name: "Poly mailer",
      rank: 5,
      packageType: "thick_envelope",
      lengthCm: 40,
      widthCm: 30,
      heightCm: 5,
      tareWeightGrams: 20,
      maxWeightGrams: 1000,
      acceptsRigid: false,
      enabled: true,
    },
    ...profiles,
  ];
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 100,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 2,
        isRigid: true,
      },
    ],
    withPolyMailer,
  );
  assert.equal(packed.profileSlug, "mailer-box-30x22x5");
});

test("synthesizes a parcel from the contents when no box can contain the order", () => {
  // A 50×40×10 item exceeds every configured box. Packaging must not block the
  // sale: a parcel is computed from the item's own bounds (+clearance) so the
  // carrier can price it — a box that size can simply be bought.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 100,
        lengthCm: 50,
        widthCm: 40,
        heightCm: 10,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, SYNTHETIC_PACKAGE_PROFILE_SLUG);
  assert.equal(packed.packageType, "parcel");
  assert.equal(packed.lengthCm, 50 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.widthCm, 40 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.heightCm, 10 + PACKAGING_CLEARANCE_CM);
  // A synthesized parcel is larger than any real box, so its tare is floored at
  // the heaviest configured box's tare (120 g here) rather than the 60 g base.
  assert.equal(packed.tareWeightGrams, 120);
  assert.equal(packed.totalWeightGrams, 100 + 120);
});

test("synthesizes a taller parcel for a bulk quantity that overflows every box", () => {
  // 10 gel-pad-like units (12×8×3) can neither stack nor tile into the shallow
  // configured boxes — previously a hard 422. Now they yield a parcel whose
  // height is the summed stack (3 × 10) so the whole order still ships.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 10,
        weightGrams: 45,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 3,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, SYNTHETIC_PACKAGE_PROFILE_SLUG);
  assert.equal(packed.lengthCm, 12 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.widthCm, 8 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.heightCm, 3 * 10 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.totalWeightGrams, 45 * 10 + 120);
});

test("synthesizes a parcel even when no profiles are configured at all", () => {
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 100,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 2,
        isRigid: true,
      },
    ],
    [],
  );
  assert.equal(packed.profileSlug, SYNTHETIC_PACKAGE_PROFILE_SLUG);
  assert.equal(packed.heightCm, 2 + PACKAGING_CLEARANCE_CM);
  // No configured boxes to floor against, so the base synthetic tare applies.
  assert.equal(packed.tareWeightGrams, SYNTHETIC_PACKAGE_TARE_WEIGHT_GRAMS);
});

test("tiles many thin items across the floor instead of one tall tower", () => {
  // 8 lash trays (10x5x1) stack to 8 cm — taller than either box — but tile
  // flat across the 30x22 floor with room to spare. The old stacking-only model
  // wrongly rejected this; floor tiling accepts it into the smaller box.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 8,
        weightGrams: 35,
        lengthCm: 10,
        widthCm: 5,
        heightCm: 1,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, "mailer-box-30x22x5");
  assert.equal(packed.totalWeightGrams, 35 * 8 + 90);
});

test("tiles multiple thicker items that would over-stack a shallow box", () => {
  // 3 spoolies (12x8x3) stack to 9 cm (fails both boxes) but tile 2x2 across the
  // 30x22 floor in a single layer.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 3,
        weightGrams: 45,
        lengthCm: 12,
        widthCm: 8,
        heightCm: 3,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, "mailer-box-30x22x5");
});

test("synthesizes a parcel for a single item too thick for any configured box", () => {
  // Gel-pads shape (18×13×6): its own 6 cm thickness exceeds every box's depth,
  // so no tiling or rotation fits it. Rather than a hard rejection, a parcel of
  // the item's own size is quoted — the owner ships it in a box that deep.
  const packed = selectSmallestPackage(
    [
      {
        quantity: 1,
        weightGrams: 250,
        lengthCm: 18,
        widthCm: 13,
        heightCm: 6,
        isRigid: true,
      },
    ],
    profiles,
  );
  assert.equal(packed.profileSlug, SYNTHETIC_PACKAGE_PROFILE_SLUG);
  assert.equal(packed.lengthCm, 18 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.widthCm, 13 + PACKAGING_CLEARANCE_CM);
  assert.equal(packed.heightCm, 6 + PACKAGING_CLEARANCE_CM);
});

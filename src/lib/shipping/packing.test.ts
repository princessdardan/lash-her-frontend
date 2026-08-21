import assert from "node:assert/strict";
import test from "node:test";
import { selectSmallestPackage } from "./packing";
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

test("throws when no box can contain the order", () => {
  assert.throws(
    () =>
      selectSmallestPackage(
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
      ),
    /No configured package/,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_PACKAGE_TYPES,
  normalizePackageProfileFields,
  packageApprovalEvidenceDigest,
  PackageProfileValidationError,
  type PackageProfileFields,
} from "./package-profiles";

function validRaw(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug: "Mailer-Box-30x22x5",
    name: "Mailer box 30 × 22 × 5 cm",
    packageType: "parcel",
    rank: 10,
    lengthCm: 30,
    widthCm: 22,
    heightCm: 5,
    tareWeightGrams: 90,
    maxWeightGrams: 2_000,
    acceptsRigid: true,
    ...overrides,
  };
}

test("normalizePackageProfileFields lowercases the slug and returns the fields", () => {
  const fields = normalizePackageProfileFields(validRaw());
  assert.equal(fields.slug, "mailer-box-30x22x5");
  assert.equal(fields.packageType, "parcel");
  assert.equal(fields.lengthCm, 30);
  assert.equal(fields.acceptsRigid, true);
});

test("normalizePackageProfileFields defaults acceptsRigid to true when omitted", () => {
  const { acceptsRigid: _omit, ...raw } = validRaw();
  void _omit;
  assert.equal(normalizePackageProfileFields(raw).acceptsRigid, true);
});

test("normalizePackageProfileFields coerces numeric strings from form posts", () => {
  const fields = normalizePackageProfileFields(
    validRaw({ lengthCm: "30", maxWeightGrams: "2000", rank: "0" }),
  );
  assert.equal(fields.lengthCm, 30);
  assert.equal(fields.maxWeightGrams, 2_000);
  assert.equal(fields.rank, 0);
});

test("normalizePackageProfileFields rejects invalid input", () => {
  const cases: Array<Record<string, unknown>> = [
    { slug: "Not a Slug" },
    { slug: "trailing-" },
    { name: "" },
    { packageType: "crate" },
    { rank: -1 },
    { rank: 1.5 },
    { lengthCm: 0 },
    { widthCm: -3 },
    { heightCm: 2.5 },
    { maxWeightGrams: 0 },
    { tareWeightGrams: -1 },
  ];
  for (const override of cases) {
    assert.throws(
      () => normalizePackageProfileFields(validRaw(override)),
      PackageProfileValidationError,
      `expected rejection for ${JSON.stringify(override)}`,
    );
  }
});

test("every allowed package type normalizes", () => {
  for (const packageType of ALLOWED_PACKAGE_TYPES) {
    assert.equal(
      normalizePackageProfileFields(validRaw({ packageType })).packageType,
      packageType,
    );
  }
});

function digestInput(
  overrides: Partial<
    PackageProfileFields & {
      profileId: string;
      evidenceReference: string;
      version: string;
    }
  > = {},
) {
  return {
    ...normalizePackageProfileFields(validRaw()),
    profileId: "22222222-2222-4222-8222-222222222222",
    evidenceReference: "Measured physical box 2026-08-23",
    version: "owner-package-approval-v1",
    ...overrides,
  };
}

test("packageApprovalEvidenceDigest is 64 lowercase hex and deterministic", () => {
  const first = packageApprovalEvidenceDigest(digestInput());
  const second = packageApprovalEvidenceDigest(digestInput());
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
});

test("packageApprovalEvidenceDigest changes when any bound field changes", () => {
  const base = packageApprovalEvidenceDigest(digestInput());
  const variations = [
    digestInput({ profileId: "33333333-3333-4333-8333-333333333333" }),
    digestInput({ slug: "mailer-box-36x26x4" }),
    digestInput({ name: "Renamed box" }),
    digestInput({ packageType: "thick_envelope" }),
    digestInput({ lengthCm: 31 }),
    digestInput({ widthCm: 23 }),
    digestInput({ heightCm: 6 }),
    digestInput({ tareWeightGrams: 91 }),
    digestInput({ maxWeightGrams: 2_001 }),
    digestInput({ acceptsRigid: false }),
    digestInput({ rank: 20 }),
    digestInput({ evidenceReference: "A different evidence reference" }),
    digestInput({ version: "owner-package-approval-v2" }),
  ];
  const digests = new Set([
    base,
    ...variations.map((input) => packageApprovalEvidenceDigest(input)),
  ]);
  assert.equal(digests.size, variations.length + 1);
});

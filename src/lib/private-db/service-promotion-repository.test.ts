import assert from "node:assert/strict";
import test from "node:test";

import { createActiveServicePromotionResolver } from "@/lib/booking/operations/service-promotion-resolution";

const now = new Date("2026-07-29T16:00:00.000Z");

test("resolves a normalized active code for the exact held offering", async () => {
  let lookupInput: unknown;
  const resolver = createActiveServicePromotionResolver({
    findCandidate: async (input) => {
      lookupInput = input;
      return {
        code: "LASH10",
        discountType: "percentage",
        discountValue: 1000,
        effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        effectiveUntil: new Date("2026-08-01T00:00:00.000Z"),
        id: "promotion-1",
        internalTitle: "July offer",
        offeringId: "offering-nataliea-fill",
        status: "active",
      };
    },
  });

  const promotion = await resolver({
    code: " lash10 ",
    now,
    offeringId: "offering-nataliea-fill",
  });

  assert.deepEqual(lookupInput, {
    code: "LASH10",
    now,
    offeringId: "offering-nataliea-fill",
  });
  assert.deepEqual(promotion, {
    _id: "promotion-1",
    amount: 10,
    appliesTo: "services",
    code: "LASH10",
    discountType: "percentage",
    isEnabled: true,
    title: "July offer",
  });
});

test("rejects a candidate attached to another provider offering", async () => {
  const resolver = createActiveServicePromotionResolver({
    findCandidate: async () => ({
      code: "LASH10",
      discountType: "percentage",
      discountValue: 1000,
      effectiveFrom: null,
      effectiveUntil: null,
      id: "promotion-1",
      internalTitle: "Nataliea only",
      offeringId: "offering-nataliea-fill",
      status: "active",
    }),
  });

  assert.equal(
    await resolver({
      code: "LASH10",
      now,
      offeringId: "offering-another-provider-fill",
    }),
    null,
  );
});

test("rejects disabled, expired, and malformed promotion definitions", async () => {
  for (const candidate of [
    {
      code: "LASH10",
      discountType: "percentage",
      discountValue: 1000,
      effectiveFrom: null,
      effectiveUntil: null,
      id: "promotion-disabled",
      internalTitle: "Disabled",
      offeringId: "offering-1",
      status: "disabled",
    },
    {
      code: "LASH10",
      discountType: "fixed",
      discountValue: 1000,
      effectiveFrom: null,
      effectiveUntil: new Date("2026-07-01T00:00:00.000Z"),
      id: "promotion-expired",
      internalTitle: "Expired",
      offeringId: "offering-1",
      status: "active",
    },
    {
      code: "LASH10",
      discountType: "percentage",
      discountValue: 10001,
      effectiveFrom: null,
      effectiveUntil: null,
      id: "promotion-invalid",
      internalTitle: "Invalid",
      offeringId: "offering-1",
      status: "active",
    },
  ]) {
    const resolver = createActiveServicePromotionResolver({
      findCandidate: async () => candidate,
    });

    assert.equal(
      await resolver({
        code: "LASH10",
        now,
        offeringId: "offering-1",
      }),
      null,
    );
  }
});

test("invalid codes do not query the repository", async () => {
  let queried = false;
  const resolver = createActiveServicePromotionResolver({
    findCandidate: async () => {
      queried = true;
      return null;
    },
  });

  assert.equal(
    await resolver({ code: "bad code!", now, offeringId: "offering-1" }),
    null,
  );
  assert.equal(queried, false);
});

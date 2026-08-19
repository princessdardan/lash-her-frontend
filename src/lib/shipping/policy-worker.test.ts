import assert from "node:assert/strict";
import test from "node:test";

import { shippingClaimWindow } from "./policy-worker";

test("claim eligibility uses provider ship date while the outer deadline uses purchase date", () => {
  const purchasedAt = new Date("2026-08-01T12:00:00.000Z");
  const providerShipDateAt = new Date("2026-08-04T12:00:00.000Z");

  const window = shippingClaimWindow({
    providerShipDateAt,
    purchasedAt,
    waitingDays: 21,
    deadlineDays: 90,
  });

  assert.deepEqual(window, {
    eligibleAt: new Date("2026-08-25T12:00:00.000Z"),
    deadlineAt: new Date("2026-10-30T12:00:00.000Z"),
  });
});

test("claim eligibility fails closed without the documented provider ship date", () => {
  assert.equal(
    shippingClaimWindow({
      providerShipDateAt: null,
      purchasedAt: new Date("2026-08-01T12:00:00.000Z"),
      waitingDays: 21,
      deadlineDays: 90,
    }),
    null,
  );
});

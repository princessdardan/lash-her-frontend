import assert from "node:assert/strict";
import test from "node:test";

import {
  providerCertificationWindowAcceptsEvidence,
  providerContractWindowIsActive,
} from "./policy-admin";

test("provider certification evidence may precede or occur during the contract window", () => {
  const now = new Date("2026-08-15T12:00:00.000Z");
  assert.equal(
    providerCertificationWindowAcceptsEvidence(
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      now,
    ),
    true,
  );
  assert.equal(
    providerCertificationWindowAcceptsEvidence(
      "2026-08-16T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
      now,
    ),
    true,
  );
  assert.equal(
    providerCertificationWindowAcceptsEvidence(
      "2026-07-01T00:00:00.000Z",
      "2026-08-15T12:00:00.000Z",
      now,
    ),
    false,
  );
});

test("provider contract activity is start-inclusive and end-exclusive", () => {
  const effectiveFrom = "2026-08-15T12:00:00.000Z";
  const effectiveUntil = "2026-09-01T00:00:00.000Z";
  assert.equal(
    providerContractWindowIsActive(
      effectiveFrom,
      effectiveUntil,
      new Date("2026-08-15T11:59:59.999Z"),
    ),
    false,
  );
  assert.equal(
    providerContractWindowIsActive(
      effectiveFrom,
      effectiveUntil,
      new Date(effectiveFrom),
    ),
    true,
  );
  assert.equal(
    providerContractWindowIsActive(
      effectiveFrom,
      effectiveUntil,
      new Date(effectiveUntil),
    ),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import type { HelcimProductPaymentsCertificationContractSnapshot } from "@/lib/private-db/schema";

import {
  normalizeProviderCertificationSubmission,
  policyRouteStepUpScope,
  requireTorontoPolicyTimezone,
} from "./policy-route-contract";

const helcimContract: HelcimProductPaymentsCertificationContractSnapshot = {
  avs: {
    fieldNames: ["avsResponse"],
    matchCodes: ["y"],
    mismatchCodes: ["n"],
  },
  contract: "helcim_product_payments",
  cvv: {
    fieldNames: ["cvvResponse"],
    matchCodes: ["m"],
    mismatchCodes: ["n"],
  },
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  effectiveUntil: "2027-08-01T00:00:00.000Z",
  evidenceReference: "certification://helcim/sandbox-triples-v1",
  purchaseSuccessfulStatuses: ["approved"],
  purchaseTransactionTypes: ["purchase"],
  refundCorrelation: {
    merchantReferenceFields: ["merchantReference"],
    originalTransactionIdFields: ["originalTransactionId"],
    providerRefundIdFields: ["transactionId"],
  },
  refundSuccessfulStatuses: ["approved"],
  refundTransactionTypes: ["refund"],
  version: "helcim-product-payments-v1",
};

test("policy calendar accepts only the immutable Toronto timezone", () => {
  assert.equal(requireTorontoPolicyTimezone(undefined), "America/Toronto");
  assert.equal(
    requireTorontoPolicyTimezone(" America/Toronto "),
    "America/Toronto",
  );
  assert.throws(
    () => requireTorontoPolicyTimezone("UTC"),
    /must be America\/Toronto/,
  );
  assert.throws(
    () => requireTorontoPolicyTimezone("america\/toronto"),
    /must be America\/Toronto/,
  );
});

test("Helcim provider certification must equal the configured contract exactly", () => {
  const body = matchingHelcimBody();
  assert.deepEqual(
    normalizeProviderCertificationSubmission(body, helcimContract),
    {
      contractSnapshot: helcimContract,
      evidenceReference: helcimContract.evidenceReference,
      validUntil: helcimContract.effectiveUntil,
      version: helcimContract.version,
    },
  );

  const mutations: Array<[string, unknown]> = [
    ["scope", "canada"],
    ["version", "different"],
    ["evidenceReference", "certification://different"],
    ["validUntil", "2027-08-01T00:00:00.001Z"],
    [
      "contractSnapshot",
      { ...helcimContract, refundTransactionTypes: ["Refund"] },
    ],
  ];
  for (const [field, value] of mutations) {
    assert.throws(
      () =>
        normalizeProviderCertificationSubmission(
          { ...body, [field]: value },
          helcimContract,
        ),
      /must exactly match/,
      `${field} mismatch must fail closed`,
    );
  }
});

test("Helcim certification fails closed when no configured contract exists", () => {
  assert.throws(
    () => normalizeProviderCertificationSubmission(matchingHelcimBody(), null),
    /not configured/,
  );
});

test("Chit Chats certification preserves the submitted reviewed snapshot", () => {
  const snapshot = {
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "2027-08-01T00:00:00.000Z",
    evidenceReference: "certification://chitchats/staging",
    version: "chitchats-v1",
  };
  assert.deepEqual(
    normalizeProviderCertificationSubmission(
      {
        contractSnapshot: snapshot,
        evidenceReference: snapshot.evidenceReference,
        provider: "chitchats",
        validUntil: snapshot.effectiveUntil,
        version: snapshot.version,
      },
      null,
    ),
    {
      contractSnapshot: snapshot,
      evidenceReference: snapshot.evidenceReference,
      validUntil: snapshot.effectiveUntil,
      version: snapshot.version,
    },
  );
});

test("policy proof binds the full calendar CAS and closure snapshot", () => {
  const payload = {
    coverageEndsOn: "2028-05-15",
    coverageStartsOn: "2026-08-15",
    evidenceReference: "evidence://calendar/reviewed",
    expectedClosureSnapshotHash: "sha256:closures",
    expectedCurrentEffectiveId: "11111111-1111-4111-8111-111111111111",
    timezone: "America/Toronto",
    version: "calendar-2026-08-15",
  };
  const base = policyRouteStepUpScope("activate_calendar", payload);
  assert.equal(base.action, "shipping_policy:activate_calendar");
  assert.match(base.target, /^sha256:[0-9a-f]{64}$/);
  assert.equal(base.targetLabel, "Shipping policy: activate calendar");

  for (const [field, value] of Object.entries({
    coverageEndsOn: "2028-05-16",
    coverageStartsOn: "2026-08-16",
    evidenceReference: "evidence://calendar/different",
    expectedClosureSnapshotHash: "sha256:different",
    expectedCurrentEffectiveId: "22222222-2222-4222-8222-222222222222",
    timezone: "UTC",
    version: "calendar-different",
  })) {
    assert.notEqual(
      policyRouteStepUpScope("activate_calendar", {
        ...payload,
        [field]: value,
      }).target,
      base.target,
      `${field} must be bound to the proof`,
    );
  }
});

function matchingHelcimBody(): Record<string, unknown> {
  return {
    contractSnapshot: structuredClone(helcimContract),
    environment: "production",
    evidenceReference: helcimContract.evidenceReference,
    provider: "helcim",
    scope: "product_payments",
    validUntil: helcimContract.effectiveUntil,
    version: helcimContract.version,
  };
}

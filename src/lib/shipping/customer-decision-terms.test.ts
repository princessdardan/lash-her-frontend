import assert from "node:assert/strict";
import test from "node:test";

import {
  addressServiceSubstitutionDecisionTerms,
  addressSignatureDecisionTerms,
  hashCustomerDecisionConditions,
  lossDamageRemedyDecisionTerms,
} from "./customer-decision-terms";

test("decision hashes bind exact scope and stable proposed conditions", () => {
  const left = hashCustomerDecisionConditions("scope/a", {
    amount: 1200,
    nested: { b: true, a: "value" },
  });
  const reordered = hashCustomerDecisionConditions("scope/a", {
    nested: { a: "value", b: true },
    amount: 1200,
  });
  assert.equal(left, reordered);
  assert.notEqual(
    left,
    hashCustomerDecisionConditions("scope/b", {
      amount: 1200,
      nested: { a: "value", b: true },
    }),
  );
});

test("address and remedy builders produce immutable processor scopes", () => {
  assert.deepEqual(
    addressSignatureDecisionTerms({
      requestId: "request-1",
      sourceShipmentId: "shipment-1",
    }),
    {
      scopeKey: "address-change/request-1/shipment/shipment-1/signature",
      proposedConditions: {
        requestId: "request-1",
        sourceShipmentId: "shipment-1",
        signatureRequired: true,
      },
    },
  );
  assert.equal(
    addressServiceSubstitutionDecisionTerms({
      requestId: "request-1",
      sourceShipmentId: "shipment-1",
      originalPostageType: "original",
      substitutePostageType: "substitute",
      substituteAmountCents: 1234,
    }).scopeKey,
    "address-change/request-1/shipment/shipment-1/service-substitution",
  );
  assert.equal(
    lossDamageRemedyDecisionTerms({
      caseId: "case-1",
      remedyDeadlineAt: new Date("2026-08-20T12:00:00.000Z"),
    }).scopeKey,
    "loss_damage_remedy/case-1/2026-08-20T12:00:00.000Z",
  );
});

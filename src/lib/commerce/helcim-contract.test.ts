import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCertifiedCardEvidence,
  classifyHelcimTransaction,
} from "./helcim-contract";

test("Helcim classification requires exact certified type and status", () => {
  assert.deepEqual(
    classifyHelcimTransaction({
      transactionType: "purchase",
      status: "approved",
    }),
    {
      kind: "purchase",
      successful: true,
      normalizedStatus: "approved",
      normalizedType: "purchase",
    },
  );
  for (const status of [
    "not approved",
    "unsuccessful",
    "refund_pending",
    undefined,
  ]) {
    assert.equal(
      classifyHelcimTransaction({ transactionType: "purchase", status })
        .successful,
      false,
    );
  }
  assert.equal(
    classifyHelcimTransaction({ transactionType: "refund", status: "approved" })
      .kind,
    "unknown",
  );
  assert.equal(
    classifyHelcimTransaction({
      transactionType: "refund",
      status: "approved",
      originalTransactionId: "123",
    }).kind,
    "refund",
  );
});

test("missing or unknown AVS/CVV evidence holds fulfillment", () => {
  assert.deepEqual(
    assessCertifiedCardEvidence({ avsCode: "Y", cvvCode: "M" }),
    {
      status: "cleared",
      reasonCodes: [],
      avsCode: "Y",
      cvvCode: "M",
    },
  );
  assert.equal(assessCertifiedCardEvidence({}).status, "review_required");
  assert.equal(
    assessCertifiedCardEvidence({ avsCode: "unknown", cvvCode: "M" }).status,
    "review_required",
  );
});

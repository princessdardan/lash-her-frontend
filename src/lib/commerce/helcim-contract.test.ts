import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCertifiedCardEvidence,
  assessCertifiedOwnerReviewEvidence,
  classifyHelcimTransaction,
} from "./helcim-contract";
import {
  getHelcimContractIdentitySnapshot,
  readCertifiedHelcimEvidenceField,
  readCertifiedHelcimRefundCorrelationField,
} from "./helcim-certified-contract";

test("Helcim contract identity uses the caller's readiness timestamp", () => {
  const previous = process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
  process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = JSON.stringify({
    contract: "helcim_product_payments",
    version: "boundary-v1",
    evidenceReference: "sandbox-triple:boundary",
    effectiveFrom: "2026-08-16T00:00:00.000Z",
    effectiveUntil: "2026-09-01T00:00:00.000Z",
    purchaseTransactionTypes: ["purchase"],
    refundTransactionTypes: ["refund"],
    purchaseSuccessfulStatuses: ["approved"],
    refundSuccessfulStatuses: ["approved"],
    avs: {
      fieldNames: ["avsResponse"],
      matchCodes: ["y"],
      mismatchCodes: ["n"],
    },
    cvv: {
      fieldNames: ["cvvResponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    refundCorrelation: {
      providerRefundIdFields: ["transactionId"],
      originalTransactionIdFields: [],
      merchantReferenceFields: [],
    },
  });
  try {
    assert.equal(
      getHelcimContractIdentitySnapshot(new Date("2026-08-15T23:59:59.999Z")),
      null,
    );
    assert.equal(
      getHelcimContractIdentitySnapshot(new Date("2026-08-16T00:00:00.000Z"))
        ?.version,
      "boundary-v1",
    );
    assert.equal(
      getHelcimContractIdentitySnapshot(new Date("2026-09-01T00:00:00.000Z")),
      null,
    );
  } finally {
    if (previous === undefined)
      delete process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
    else process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = previous;
  }
});

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
    "refund",
  );
  assert.equal(
    classifyHelcimTransaction({
      transactionType: "refund",
      status: "approved",
      originalTransactionId: "123",
    }).kind,
    "refund",
  );
  assert.equal(
    classifyHelcimTransaction({
      transactionType: "purchase",
      status: "approved",
      originalTransactionId: "123",
    }).kind,
    "unknown",
  );
});

test("owner review accepts only configured explicit mismatches", () => {
  const previous = process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
  process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = JSON.stringify({
    contract: "helcim_product_payments",
    version: "test-v1",
    evidenceReference: "sandbox-triple:test",
    effectiveFrom: "2020-01-01T00:00:00.000Z",
    effectiveUntil: "2099-01-01T00:00:00.000Z",
    purchaseTransactionTypes: ["purchase"],
    refundTransactionTypes: ["refund"],
    purchaseSuccessfulStatuses: ["approved"],
    refundSuccessfulStatuses: ["settled"],
    avs: {
      fieldNames: ["card.avsResponse"],
      matchCodes: ["y"],
      mismatchCodes: ["n"],
    },
    cvv: {
      fieldNames: ["cvvResponse"],
      matchCodes: ["m"],
      mismatchCodes: ["n"],
    },
    refundCorrelation: {
      providerRefundIdFields: ["transactionId"],
      originalTransactionIdFields: ["originalTransactionId"],
      merchantReferenceFields: ["merchantReference"],
    },
  });
  try {
    assert.equal(
      assessCertifiedOwnerReviewEvidence({ avsCode: "N", cvvCode: "M" })
        .available,
      true,
    );
    assert.equal(
      readCertifiedHelcimEvidenceField(
        { card: { avsResponse: "N" }, avsResponse: "Y" },
        "avs",
      ),
      "N",
    );
    assert.equal(
      readCertifiedHelcimRefundCorrelationField(
        {
          transactionId: "uncertified",
          originalTransactionId: "captured-original",
        },
        "originalTransactionIdFields",
      ),
      "captured-original",
    );
    assert.equal(
      readCertifiedHelcimRefundCorrelationField(
        { originaltransactionid: "wrong-case" },
        "originalTransactionIdFields",
      ),
      undefined,
    );
    assert.equal(
      classifyHelcimTransaction({
        transactionType: "purchase",
        status: "settled",
      }).successful,
      false,
    );
    assert.equal(
      classifyHelcimTransaction({
        transactionType: "refund",
        status: "settled",
        originalTransactionId: "captured-original",
      }).successful,
      true,
    );
    assert.equal(
      assessCertifiedOwnerReviewEvidence({ avsCode: "N", cvvCode: "N" })
        .available,
      true,
    );
    assert.equal(
      assessCertifiedOwnerReviewEvidence({ avsCode: "", cvvCode: "M" })
        .available,
      false,
    );
    assert.equal(
      assessCertifiedOwnerReviewEvidence({ avsCode: "U", cvvCode: "M" })
        .available,
      false,
    );
  } finally {
    if (previous === undefined)
      delete process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON;
    else process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON = previous;
  }
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

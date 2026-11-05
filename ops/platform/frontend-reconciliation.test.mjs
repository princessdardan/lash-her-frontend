import assert from "node:assert/strict";
import test from "node:test";
import { assertReconciliationReceipts } from "./harness/owned-reconciliation-rows.mjs";
import { reconciliationProviderStage, assertReconciliationProviderCalls } from "./harness/owned-reconciliation-providers.mjs";

for (const kind of ["split", "capture"]) {
  test(`owned qualification refuses a missing ${kind} receipt`, async () => {
    const db = { query: async () => ({ rows: [] }) };
    await assert.rejects(assertReconciliationReceipts(assert, db, { [kind]: `owned-${kind}` }), /receipt must survive/);
  });
}

test("owned qualification refuses changed capture identity behind a completed status", async () => {
  const db = { query: async () => ({ rows: [{ status: "paid", provider_status: "COMPLETED", provider_payment_id: "unrelated-payment" }] }) };
  await assert.rejects(assertReconciliationReceipts(assert, db, { capture: "owned-capture" }), assert.AssertionError);
});

test("owned qualification refuses changed split identities behind a canceled stage", async () => {
  const db = { query: async () => ({ rows: [{ status: "pending", provider_order_id: "owned-split-order", provider_metadata: {
    splitPayment: { stage: "canceled", cardAmountCents: 400, afterpayAmountCents: 600,
      cardPaymentId: "unrelated-payment", afterpayPaymentId: "owned-split-afterpay", squareOrderId: "owned-split-order" },
  } }] }) };
  await assert.rejects(assertReconciliationReceipts(assert, db, { split: "owned-split" }), assert.AssertionError);
});

test("owned provider interception refuses unselected payments, verbs, suffixes and queries", () => {
  const origin = "https://connect.squareupsandbox.com";
  for (const [method, url] of [
    ["GET", `${origin}/v2/payments/owned-unselected`],
    ["DELETE", `${origin}/v2/payments/owned-capture-payment`],
    ["POST", `${origin}/v2/payments/owned-service-payment/complete`],
    ["GET", `${origin}/v2/payments/owned-capture-payment/extra`],
    ["GET", `${origin}/v2/payments/owned-capture-payment?unselected=true`],
    ["POST", "https://api.resend.com/emails?unselected=true"],
    ["GET", "https://connect.squareup.com/v2/payments/owned-capture-payment"],
  ]) assert.throws(() => reconciliationProviderStage(new Request(url, { method })), /OWNED_UNEXPECTED_FETCH/);
});

test("owned effect qualification refuses replay, missing calls and reordered batches", () => {
  const calls = [
    { stage: "email", method: "POST", path: "/emails" },
    { stage: "capture", method: "GET", path: "/v2/payments/owned-capture-payment" },
    { stage: "capture", method: "POST", path: "/v2/payments/owned-capture-payment/complete" },
  ];
  const check = actual => assertReconciliationProviderCalls(assert, actual, ["email", "capture"]);
  for (const actual of [[...calls, calls[2]], calls.slice(0, 2), [...calls.slice(1), calls[0]]]) assert.throws(() => check(actual), assert.AssertionError);
});

test("owned effect qualification refuses interleaved batches while allowing concurrent split legs", () => {
  const split = [
    { stage: "split", method: "GET", path: "/v2/payments/owned-split-card" },
    { stage: "split", method: "POST", path: "/v2/payments/owned-split-card/cancel" },
    { stage: "split", method: "GET", path: "/v2/payments/owned-split-afterpay" },
    { stage: "split", method: "POST", path: "/v2/payments/owned-split-afterpay/cancel" },
  ];
  const capture = [
    { stage: "capture", method: "GET", path: "/v2/payments/owned-capture-payment" },
    { stage: "capture", method: "POST", path: "/v2/payments/owned-capture-payment/complete" },
  ];
  assertReconciliationProviderCalls(assert, [...split, ...capture], ["split", "capture"]);
  assert.throws(() => assertReconciliationProviderCalls(assert, [split[0], ...capture, ...split.slice(1)], ["split", "capture"]), assert.AssertionError);
});

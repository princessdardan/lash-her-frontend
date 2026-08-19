import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeSquareProductOrder,
  squareCommerceIdempotencyKey,
  type ChargeSquareProductOrderDependencies,
} from "./square-commerce-checkout";
import type { SquareCreatePaymentResponse } from "@/lib/payments/square/payments-client";
import type { FinalizeSquareProductPaymentResult } from "@/lib/commerce/square-product-finalizer";

interface Harness {
  deps: ChargeSquareProductOrderDependencies;
  authorizeKeys: string[];
  captures: string[];
  voids: string[];
  voidsByKey: string[];
  finalizeCalls: () => number;
  emailedOrders: string[];
  errors: Array<{ message: string; meta: Record<string, unknown> }>;
}

function createHarness(overrides: {
  payment?: SquareCreatePaymentResponse["payment"];
  authorizeError?: Error;
  captureError?: Error;
  finalize?: FinalizeSquareProductPaymentResult["transition"];
  finalizeError?: Error;
  sendEmailError?: Error;
}): Harness {
  const authorizeKeys: string[] = [];
  const captures: string[] = [];
  const voids: string[] = [];
  const voidsByKey: string[] = [];
  const emailedOrders: string[] = [];
  const errors: Harness["errors"] = [];
  let finalizeCalls = 0;

  const deps: ChargeSquareProductOrderDependencies = {
    async authorizePayment(request) {
      authorizeKeys.push(request.idempotency_key);
      if (overrides.authorizeError) throw overrides.authorizeError;
      return {
        payment:
          overrides.payment ??
          ({
            id: "sq-pay-1",
            status: "APPROVED",
            reference_id: request.reference_id,
            source_type: "CARD",
            version_token: "v1",
            amount_money: request.amount_money,
          } satisfies SquareCreatePaymentResponse["payment"]),
      };
    },
    async capturePayment(paymentId) {
      captures.push(paymentId);
      if (overrides.captureError) throw overrides.captureError;
    },
    async voidPayment(paymentId) {
      voids.push(paymentId);
    },
    async voidPaymentByIdempotencyKey(key) {
      voidsByKey.push(key);
    },
    async finalize() {
      finalizeCalls += 1;
      if (overrides.finalizeError) throw overrides.finalizeError;
      return { transition: overrides.finalize ?? "applied" };
    },
    async sendConfirmationEmail(orderId) {
      if (overrides.sendEmailError) throw overrides.sendEmailError;
      emailedOrders.push(orderId);
    },
    logError(message, meta) {
      errors.push({ message, meta });
    },
  };

  return {
    deps,
    authorizeKeys,
    captures,
    voids,
    voidsByKey,
    finalizeCalls: () => finalizeCalls,
    emailedOrders,
    errors,
  };
}

const baseInput = {
  orderReference: "lh-abc",
  amountCents: 5_000,
  currency: "CAD" as const,
  sourceId: "cnon:card-nonce",
};

test("authorizes with a deterministic key, records, then captures", async () => {
  const harness = createHarness({});

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, {
    ok: true,
    squarePaymentId: "sq-pay-1",
    transition: "applied",
  });
  assert.deepEqual(harness.authorizeKeys, ["square-primary/lh-abc"]);
  assert.equal(squareCommerceIdempotencyKey("lh-abc"), "square-primary/lh-abc");
  assert.deepEqual(harness.captures, ["sq-pay-1"]);
  assert.deepEqual(harness.voids, []);
  assert.deepEqual(harness.emailedOrders, ["lh-abc"]);
});

test("does not re-capture on an already-applied replay", async () => {
  const harness = createHarness({ finalize: "already_applied" });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.emailedOrders, ["lh-abc"]);
});

test("voids the authorization and does not finalize when not approved", async () => {
  const harness = createHarness({
    payment: {
      id: "sq-pay-2",
      status: "PENDING",
      source_type: "CARD",
      amount_money: { amount: 5_000, currency: "CAD" },
    },
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, { ok: false, reason: "payment_not_authorized" });
  assert.deepEqual(harness.voids, ["sq-pay-2"]);
  assert.equal(harness.finalizeCalls(), 0);
  assert.deepEqual(harness.captures, []);
});

test("voids and does not finalize when the authorized amount mismatches", async () => {
  const harness = createHarness({
    payment: {
      id: "sq-pay-3",
      status: "APPROVED",
      source_type: "CARD",
      amount_money: { amount: 4_000, currency: "CAD" },
    },
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, { ok: false, reason: "amount_mismatch" });
  assert.deepEqual(harness.voids, ["sq-pay-3"]);
  assert.equal(harness.finalizeCalls(), 0);
});

test("voids by idempotency key when authorization throws", async () => {
  const harness = createHarness({
    authorizeError: new Error("network down"),
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, { ok: false, reason: "payment_failed" });
  assert.deepEqual(harness.voidsByKey, ["square-primary/lh-abc"]);
  assert.equal(harness.finalizeCalls(), 0);
});

test("voids the authorization when finalize throws (no orphaned capture)", async () => {
  const harness = createHarness({
    finalizeError: new Error("Payment obligation changed while finalizing"),
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, { ok: false, reason: "finalize_failed" });
  assert.deepEqual(harness.voids, ["sq-pay-1"]);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.emailedOrders, []);
});

test("voids the authorization on a finalize conflict", async () => {
  const harness = createHarness({ finalize: "amount_or_currency_mismatch" });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "amount_or_currency_mismatch",
  });
  assert.deepEqual(harness.voids, ["sq-pay-1"]);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.emailedOrders, []);
});

test("a failed capture after finalize still succeeds and is logged for reconciliation", async () => {
  const harness = createHarness({
    captureError: new Error("capture timeout"),
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.voids, []);
  assert.ok(
    harness.errors.some((entry) => entry.message.includes("capture after")),
  );
  assert.deepEqual(harness.emailedOrders, ["lh-abc"]);
});

test("a failed confirmation email does not fail the charge", async () => {
  const harness = createHarness({
    sendEmailError: new Error("resend unavailable"),
  });

  const result = await chargeSquareProductOrder(baseInput, harness.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.captures, ["sq-pay-1"]);
  assert.ok(
    harness.errors.some((entry) =>
      entry.message.includes("confirmation email"),
    ),
  );
});

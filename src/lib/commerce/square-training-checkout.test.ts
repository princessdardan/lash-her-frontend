import assert from "node:assert/strict";
import test from "node:test";

import {
  chargeSquareTrainingOrder,
  squareTrainingIdempotencyKey,
  type ChargeSquareTrainingOrderDependencies,
} from "./square-training-checkout";
import type { SquareCreatePaymentResponse } from "@/lib/payments/square/payments-client";
import type { SquareTrainingCardTransition } from "@/lib/commerce/square-training-card-finalizer";

interface Harness {
  deps: ChargeSquareTrainingOrderDependencies;
  authorizeKeys: string[];
  captures: string[];
  voids: string[];
  notified: string[];
}

function createHarness(overrides: {
  finalize?: SquareTrainingCardTransition;
  payment?: SquareCreatePaymentResponse["payment"];
}): Harness {
  const authorizeKeys: string[] = [];
  const captures: string[] = [];
  const voids: string[] = [];
  const notified: string[] = [];

  const deps: ChargeSquareTrainingOrderDependencies = {
    async authorizePayment(request) {
      authorizeKeys.push(request.idempotency_key);
      return {
        payment:
          overrides.payment ??
          ({
            id: "sq-train-1",
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
    },
    async voidPayment(paymentId) {
      voids.push(paymentId);
    },
    async voidPaymentByIdempotencyKey() {},
    async finalize() {
      return { transition: overrides.finalize ?? "applied" };
    },
    async sendNotifications(orderReference) {
      notified.push(orderReference);
    },
    logError() {},
  };

  return { deps, authorizeKeys, captures, voids, notified };
}

const baseInput = {
  orderReference: "lh-train",
  amountCents: 120_000,
  currency: "CAD" as const,
  sourceId: "cnon:card-nonce",
};

test("uses a training-namespaced idempotency key and notifies on success", async () => {
  const harness = createHarness({});

  const result = await chargeSquareTrainingOrder(baseInput, harness.deps);

  assert.deepEqual(result, {
    ok: true,
    squarePaymentId: "sq-train-1",
    transition: "applied",
  });
  assert.equal(
    squareTrainingIdempotencyKey("lh-train"),
    "square-training/lh-train",
  );
  assert.deepEqual(harness.authorizeKeys, ["square-training/lh-train"]);
  assert.deepEqual(harness.captures, ["sq-train-1"]);
  assert.deepEqual(harness.notified, ["lh-train"]);
});

test("does not re-capture on an already-applied replay but still notifies", async () => {
  const harness = createHarness({ finalize: "already_applied" });

  const result = await chargeSquareTrainingOrder(baseInput, harness.deps);

  assert.equal(result.ok, true);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.notified, ["lh-train"]);
});

test("voids the authorization on a finalize conflict and does not notify", async () => {
  const harness = createHarness({ finalize: "transaction_conflict" });

  const result = await chargeSquareTrainingOrder(baseInput, harness.deps);

  assert.deepEqual(result, {
    ok: false,
    reason: "transaction_conflict",
    retryWithNewReservation: true,
  });
  assert.deepEqual(harness.voids, ["sq-train-1"]);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.notified, []);
});

test("a lost success response recovers the recorded payment without authorizing a fresh token", async () => {
  for (const method of ["card", "afterpay"] as const) {
    const harness = createHarness({
      payment: {
        id: "sq-paid",
        status: "APPROVED",
        source_type: method === "afterpay" ? "BUY_NOW_PAY_LATER" : "CARD",
        amount_money: { amount: baseInput.amountCents, currency: "CAD" },
      },
    });
    let recorded: { squarePaymentId: string } | null = null;
    harness.deps.findRecordedPayment = async () => recorded;
    harness.deps.finalize = async ({ squarePaymentId }) => {
      recorded = { squarePaymentId };
      return { transition: "applied" };
    };
    const input = {
      ...baseInput,
      method,
      expectedAmountCents: baseInput.amountCents,
    };
    assert.equal(
      (await chargeSquareTrainingOrder(input, harness.deps)).ok,
      true,
    );
    const retry = await chargeSquareTrainingOrder(
      { ...input, sourceId: "fresh-token-after-lost-response" },
      harness.deps,
    );
    assert.deepEqual(retry, {
      ok: true,
      squarePaymentId: "sq-paid",
      transition: "already_applied",
    });
    assert.equal(harness.authorizeKeys.length, 1);
    assert.deepEqual(harness.captures, ["sq-paid"]);
    assert.deepEqual(harness.voids, []);
  }
});

test("an authorization error permits a new reservation only after cancellation is confirmed", async () => {
  for (const cancellationFails of [false, true]) {
    const harness = createHarness({});
    harness.deps.authorizePayment = async () => {
      throw new Error("Unknown authorization outcome");
    };
    harness.deps.voidPaymentByIdempotencyKey = async () => {
      if (cancellationFails) throw new Error("Cancellation unconfirmed");
    };
    const result = await chargeSquareTrainingOrder(baseInput, harness.deps);
    assert.deepEqual(result, {
      ok: false,
      reason: "payment_failed",
      retryWithNewReservation: !cancellationFails,
    });
    assert.deepEqual(harness.captures, []);
  }
});

test("a failed authorization cancellation keeps the reservation for reconciliation", async () => {
  const harness = createHarness({ finalize: "transaction_conflict" });
  harness.deps.voidPayment = async () => {
    throw new Error("Cancellation unconfirmed");
  };
  const result = await chargeSquareTrainingOrder(baseInput, harness.deps);
  assert.deepEqual(result, {
    ok: false,
    reason: "transaction_conflict",
    retryWithNewReservation: false,
  });
});

test("a concurrent paid result takes precedence over an idempotency conflict", async () => {
  const harness = createHarness({});
  let reads = 0;
  harness.deps.findRecordedPayment = async () =>
    ++reads === 1 ? null : { squarePaymentId: "sq-concurrent" };
  harness.deps.authorizePayment = async () => {
    throw new Error("IDEMPOTENCY_KEY_REUSED");
  };
  harness.deps.voidPaymentByIdempotencyKey = async () => {
    throw new Error("Payment already completed");
  };
  const result = await chargeSquareTrainingOrder(baseInput, harness.deps);
  assert.deepEqual(result, {
    ok: true,
    squarePaymentId: "sq-concurrent",
    transition: "already_applied",
  });
  assert.deepEqual(harness.captures, []);
});

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

  assert.deepEqual(result, { ok: false, reason: "transaction_conflict" });
  assert.deepEqual(harness.voids, ["sq-train-1"]);
  assert.deepEqual(harness.captures, []);
  assert.deepEqual(harness.notified, []);
});

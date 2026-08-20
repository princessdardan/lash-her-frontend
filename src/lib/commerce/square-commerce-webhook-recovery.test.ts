import assert from "node:assert/strict";
import test from "node:test";

import {
  recoverSquareCommercePayment,
  type RecoverSquareCommercePaymentDependencies,
} from "./square-commerce-webhook-recovery";

interface Harness {
  deps: RecoverSquareCommercePaymentDependencies;
  productFinalizeCalls: number;
  trainingFinalizeCalls: number;
  productEmails: string[];
  trainingNotifies: string[];
}

function createHarness(overrides: {
  productTransition?:
    | "applied"
    | "already_applied"
    | "amount_or_currency_mismatch";
  trainingTransition?: "applied" | "already_applied" | "transaction_conflict";
  sideEffectError?: Error;
}): Harness {
  const productEmails: string[] = [];
  const trainingNotifies: string[] = [];
  let productFinalizeCalls = 0;
  let trainingFinalizeCalls = 0;

  const deps: RecoverSquareCommercePaymentDependencies = {
    async finalizeProduct() {
      productFinalizeCalls += 1;
      return { transition: overrides.productTransition ?? "applied" };
    },
    async sendProductConfirmationEmail(orderReference) {
      if (overrides.sideEffectError) throw overrides.sideEffectError;
      productEmails.push(orderReference);
    },
    async finalizeTraining() {
      trainingFinalizeCalls += 1;
      return { transition: overrides.trainingTransition ?? "applied" };
    },
    async sendTrainingNotifications(orderReference) {
      if (overrides.sideEffectError) throw overrides.sideEffectError;
      trainingNotifies.push(orderReference);
    },
    logError() {},
  };

  return {
    deps,
    get productFinalizeCalls() {
      return productFinalizeCalls;
    },
    get trainingFinalizeCalls() {
      return trainingFinalizeCalls;
    },
    productEmails,
    trainingNotifies,
  } as Harness;
}

const productPayment = {
  orderReference: "lh-prod",
  kind: "product" as const,
  squarePaymentId: "sq-1",
  status: "COMPLETED",
  amountCents: 5_000,
  currency: "CAD",
};

test("recovers a completed product payment and re-drives the email", async () => {
  const harness = createHarness({});

  const result = await recoverSquareCommercePayment(
    productPayment,
    harness.deps,
  );

  assert.deepEqual(result, { status: "recovered" });
  assert.equal(harness.productFinalizeCalls, 1);
  assert.deepEqual(harness.productEmails, ["lh-prod"]);
});

test("reports duplicate when the product order was already finalized", async () => {
  const harness = createHarness({ productTransition: "already_applied" });

  const result = await recoverSquareCommercePayment(
    productPayment,
    harness.deps,
  );

  assert.deepEqual(result, { status: "duplicate" });
  assert.deepEqual(harness.productEmails, ["lh-prod"]);
});

test("ignores a non-completed payment without finalizing", async () => {
  const harness = createHarness({});

  const result = await recoverSquareCommercePayment(
    { ...productPayment, status: "APPROVED" },
    harness.deps,
  );

  assert.deepEqual(result, {
    status: "ignored",
    reason: "payment_not_completed",
  });
  assert.equal(harness.productFinalizeCalls, 0);
  assert.deepEqual(harness.productEmails, []);
});

test("recovers a completed training-card payment and re-drives notifications", async () => {
  const harness = createHarness({});

  const result = await recoverSquareCommercePayment(
    { ...productPayment, orderReference: "lh-train", kind: "training_card" },
    harness.deps,
  );

  assert.deepEqual(result, { status: "recovered" });
  assert.equal(harness.trainingFinalizeCalls, 1);
  assert.deepEqual(harness.trainingNotifies, ["lh-train"]);
});

test("reports a conflict on an amount mismatch without running the side effect", async () => {
  const harness = createHarness({
    productTransition: "amount_or_currency_mismatch",
  });

  const result = await recoverSquareCommercePayment(
    productPayment,
    harness.deps,
  );

  assert.deepEqual(result, {
    status: "conflict",
    reason: "amount_or_currency_mismatch",
  });
  assert.deepEqual(harness.productEmails, []);
});

test("reports retryable when the side effect fails so Square redelivers", async () => {
  const harness = createHarness({
    sideEffectError: new Error("resend down"),
  });

  const result = await recoverSquareCommercePayment(
    productPayment,
    harness.deps,
  );

  assert.deepEqual(result, {
    status: "retryable",
    reason: "side_effect_failed",
  });
});

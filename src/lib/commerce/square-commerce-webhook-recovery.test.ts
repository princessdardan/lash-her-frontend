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
  supplementalObligations: string[];
}

function createHarness(overrides: {
  productTransition?:
    | "applied"
    | "already_applied"
    | "amount_or_currency_mismatch";
  trainingTransition?: "applied" | "already_applied" | "transaction_conflict";
  supplementalTransition?:
    | "applied"
    | "already_applied"
    | "state_conflict"
    | "late_capture_refunded";
  sideEffectError?: Error;
}): Harness {
  const productEmails: string[] = [];
  const trainingNotifies: string[] = [];
  const supplementalObligations: string[] = [];
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
    async finalizeSupplemental(input) {
      supplementalObligations.push(input.obligationId);
      return { transition: overrides.supplementalTransition ?? "applied" };
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
    supplementalObligations,
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

test("recovers a completed supplemental obligation without a side effect", async () => {
  const harness = createHarness({});

  const result = await recoverSquareCommercePayment(
    {
      ...productPayment,
      orderReference: "obl-1",
      kind: "supplemental_obligation",
    },
    harness.deps,
  );

  assert.deepEqual(result, { status: "recovered" });
  assert.deepEqual(harness.supplementalObligations, ["obl-1"]);
  assert.deepEqual(harness.productEmails, []);
  assert.deepEqual(harness.trainingNotifies, []);
});

test("reports a supplemental conflict without a side effect", async () => {
  const harness = createHarness({ supplementalTransition: "state_conflict" });

  const result = await recoverSquareCommercePayment(
    {
      ...productPayment,
      orderReference: "obl-2",
      kind: "supplemental_obligation",
    },
    harness.deps,
  );

  assert.deepEqual(result, { status: "conflict", reason: "state_conflict" });
  assert.deepEqual(harness.supplementalObligations, ["obl-2"]);
});

test("acknowledges a late-capture-refunded supplemental payment", async () => {
  const harness = createHarness({
    supplementalTransition: "late_capture_refunded",
  });

  const result = await recoverSquareCommercePayment(
    {
      ...productPayment,
      orderReference: "obl-3",
      kind: "supplemental_obligation",
    },
    harness.deps,
  );

  // Money recorded + refund reserved by the finalizer; webhook acknowledges.
  assert.deepEqual(result, { status: "recovered" });
  assert.deepEqual(harness.supplementalObligations, ["obl-3"]);
});

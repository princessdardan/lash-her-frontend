import { execFileSync } from "node:child_process";
import test from "node:test";

const helperScript = String.raw`
  import assert from "node:assert/strict";

  import { createSquareProductRefunder } from "./src/lib/payments/square/product-refund.ts";

  function clientReturning(refund) {
    const requests = [];
    const client = {
      async refundPayment(request) {
        requests.push(request);
        return { refund };
      },
    };
    return { client, requests };
  }

  function clientThrowing(error) {
    return {
      async refundPayment() {
        throw error;
      },
    };
  }

  function squareApiError(status, code) {
    const error = new Error("Square API request failed with status " + status);
    error.name = "SquareApiError";
    error.status = status;
    error.code = code;
    return error;
  }

  const baseInput = {
    paymentId: "sq-payment-1",
    amountCents: 4200,
    currency: "CAD",
    idempotencyKey: "refund-key-1",
  };
`;

test("completed Square refund settles synchronously and forwards the idempotency key", () => {
  runRefundScenario(`
    const { client, requests } = clientReturning({
      id: "sq-refund-1",
      status: "COMPLETED",
      payment_id: "sq-payment-1",
      amount_money: { amount: 4200, currency: "CAD" },
    });
    const outcome = await createSquareProductRefunder(client).refundPayment({
      ...baseInput,
      reason: "Damaged in transit",
    });

    assert.deepEqual(outcome, {
      ok: true,
      refundId: "sq-refund-1",
      paymentId: "sq-payment-1",
      amountCents: 4200,
      currency: "CAD",
      settled: true,
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      idempotency_key: "refund-key-1",
      payment_id: "sq-payment-1",
      amount_money: { amount: 4200, currency: "CAD" },
      reason: "Damaged in transit",
    });
  `);
});

test("pending Square refund is accepted but not settled", () => {
  runRefundScenario(`
    const { client } = clientReturning({
      id: "sq-refund-2",
      status: "PENDING",
      payment_id: "sq-payment-1",
      amount_money: { amount: 4200, currency: "CAD" },
    });
    const outcome = await createSquareProductRefunder(client).refundPayment(baseInput);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.settled, false);
    assert.equal(outcome.refundId, "sq-refund-2");
  `);
});

test("rejected Square refund status is a deterministic failure", () => {
  runRefundScenario(`
    const { client } = clientReturning({
      id: "sq-refund-3",
      status: "REJECTED",
      payment_id: "sq-payment-1",
      amount_money: { amount: 4200, currency: "CAD" },
    });
    const outcome = await createSquareProductRefunder(client).refundPayment(baseInput);

    assert.deepEqual(outcome, {
      ok: false,
      deterministic: true,
      code: "SQUARE_REFUND_REJECTED",
    });
  `);
});

test("Square 4xx API error is deterministic and carries the Square code", () => {
  runRefundScenario(`
    const client = clientThrowing(squareApiError(400, "PAYMENT_NOT_REFUNDABLE"));
    const outcome = await createSquareProductRefunder(client).refundPayment(baseInput);

    assert.deepEqual(outcome, {
      ok: false,
      deterministic: true,
      code: "SQUARE_PAYMENT_NOT_REFUNDABLE",
    });
  `);
});

test("Square 409 conflict and 429 rate limit are transient (non-deterministic)", () => {
  runRefundScenario(`
    for (const status of [409, 429]) {
      const client = clientThrowing(squareApiError(status, "RATE_LIMITED"));
      const outcome = await createSquareProductRefunder(client).refundPayment(baseInput);
      assert.equal(outcome.ok, false, "status " + status + " should be a failure");
      assert.equal(outcome.deterministic, false, "status " + status + " should be transient");
    }
  `);
});

test("Square 5xx API error is a transient outcome coded by status", () => {
  runRefundScenario(`
    const client = clientThrowing(squareApiError(500));
    const outcome = await createSquareProductRefunder(client).refundPayment(baseInput);

    assert.deepEqual(outcome, {
      ok: false,
      deterministic: false,
      code: "SQUARE_500",
    });
  `);
});

test("network abort and unknown errors are transient with stable codes", () => {
  runRefundScenario(`
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    const abortOutcome = await createSquareProductRefunder(
      clientThrowing(abortError),
    ).refundPayment(baseInput);
    assert.deepEqual(abortOutcome, { ok: false, deterministic: false, code: "TIMEOUT" });

    const unknownOutcome = await createSquareProductRefunder(
      clientThrowing(new Error("boom")),
    ).refundPayment(baseInput);
    assert.deepEqual(unknownOutcome, { ok: false, deterministic: false, code: "OUTCOME_UNKNOWN" });
  `);
});

function runRefundScenario(assertions: string): void {
  const scenario = `${helperScript}\nvoid (async () => {\n${assertions}\n})()`;

  execFileSync(
    "./node_modules/.bin/tsx",
    ["--conditions=react-server", "--eval", scenario],
    {
      cwd: process.cwd(),
      stdio: "pipe",
    },
  );
}

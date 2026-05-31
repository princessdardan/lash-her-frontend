import assert from "node:assert/strict";
import test from "node:test";

import { createSquareReturnGetHandler } from "./route";

class RedirectCapture extends Error {
  constructor(readonly url: string) {
    super("redirect captured");
  }
}

function captureRedirect(url: string): never {
  throw new RedirectCapture(url);
}

async function runReturnRoute(input: {
  requestUrl: string;
  resultStatus: "booked" | "duplicate" | "ignored" | "paid_calendar_pending" | "unpaid";
}) {
  const finalizerCalls: unknown[] = [];
  const handler = createSquareReturnGetHandler({
    finalizeSquarePayment: async (finalizerInput) => {
      finalizerCalls.push(finalizerInput);
      return {
        duplicateEvent: input.resultStatus === "duplicate",
        finalized: input.resultStatus === "booked" || input.resultStatus === "paid_calendar_pending",
        status: input.resultStatus,
      };
    },
    redirectTo: captureRedirect,
  });

  try {
    await handler(new Request(input.requestUrl));
  } catch (error) {
    if (error instanceof RedirectCapture) {
      return { finalizerCalls, redirectUrl: error.url };
    }

    throw error;
  }

  throw new Error("Square return route did not redirect");
}

test("Square return passes query IDs as lookup hints and redirects with verified status", async () => {
  const result = await runReturnRoute({
    requestUrl: "https://example.com/api/booking/square/return?order_id=lh-sq-order&payment_id=pay_123",
    resultStatus: "paid_calendar_pending",
  });

  assert.deepEqual(result.finalizerCalls, [{
    orderId: "lh-sq-order",
    paymentId: "pay_123",
    source: "return",
  }]);
  assert.equal(
    result.redirectUrl,
    "https://example.com/booking/confirmation?payment=paid_calendar_pending",
  );
});

test("Square return redirects booked finalization with booked status", async () => {
  const result = await runReturnRoute({
    requestUrl: "https://example.com/api/booking/square/return?orderId=lh-sq-order&paymentId=pay_123",
    resultStatus: "booked",
  });

  assert.deepEqual(result.finalizerCalls, [{
    orderId: "lh-sq-order",
    paymentId: "pay_123",
    source: "return",
  }]);
  assert.equal(
    result.redirectUrl,
    "https://example.com/booking/confirmation?payment=booked",
  );
});

test("Square return redirects idempotent already-processed results without payment proof assumptions", async () => {
  const result = await runReturnRoute({
    requestUrl: "https://example.com/api/booking/square/return?reference_id=lh-sq-order&transaction_id=pay_123",
    resultStatus: "duplicate",
  });

  assert.deepEqual(result.finalizerCalls, [{
    orderId: "lh-sq-order",
    paymentId: "pay_123",
    source: "return",
  }]);
  assert.equal(
    result.redirectUrl,
    "https://example.com/booking/confirmation?payment=duplicate",
  );
});

test("Square mock return keeps local order/payment query names and redirects with unpaid status", async () => {
  const result = await runReturnRoute({
    requestUrl: "http://localhost:3000/api/booking/square/return?orderId=lh-sq-local&paymentId=mock-square-payment-1",
    resultStatus: "unpaid",
  });

  assert.deepEqual(result.finalizerCalls, [{
    orderId: "lh-sq-local",
    paymentId: "mock-square-payment-1",
    source: "return",
  }]);
  assert.equal(
    result.redirectUrl,
    "http://localhost:3000/booking/confirmation?payment=unpaid",
  );
});

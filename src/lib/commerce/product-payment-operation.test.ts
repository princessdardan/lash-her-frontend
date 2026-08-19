import assert from "node:assert/strict";
import test from "node:test";

import { waitForProductPaymentOperation } from "./product-payment-operation";

test("payment operation polling waits through exact pending states and returns the checkout token", async () => {
  const responses = [
    jsonResponse(202, { operationId: "operation-1", status: "queued" }),
    jsonResponse(202, { operationId: "operation-1", status: "processing" }),
    jsonResponse(200, {
      operationId: "operation-1",
      status: "ready",
      checkoutToken: "checkout-token",
    }),
  ];
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const delays: number[] = [];

  const result = await waitForProductPaymentOperation({
    operationId: "operation-1",
    fetchOperation: async (input, init) => {
      requests.push({ input, init });
      return responses.shift()!;
    },
    wait: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(result, {
    operationId: "operation-1",
    status: "ready",
    checkoutToken: "checkout-token",
  });
  assert.deepEqual(delays, [2_000, 2_000, 2_000]);
  assert.equal(requests.length, 3);
  assert.equal(
    requests[0]?.input,
    "/api/checkout/payment-operations/operation-1",
  );
  assert.deepEqual(requests[0]?.init, { cache: "no-store" });
});

test("payment operation polling stops on an unknown outcome", async () => {
  let calls = 0;
  const result = await waitForProductPaymentOperation({
    operationId: "operation-1",
    fetchOperation: async () => {
      calls += 1;
      return jsonResponse(409, {
        operationId: "operation-1",
        status: "outcome_unknown",
        error: "Provider outcome requires review",
      });
    },
    wait: async () => undefined,
  });

  assert.equal(calls, 1);
  assert.deepEqual(result, {
    operationId: "operation-1",
    status: "outcome_unknown",
    error: "Provider outcome requires review",
  });
});

test("payment operation polling fails closed on malformed pending status", async () => {
  const result = await waitForProductPaymentOperation({
    operationId: "operation-1",
    fetchOperation: async () =>
      jsonResponse(202, { operationId: "operation-1", status: "ready" }),
    wait: async () => undefined,
  });

  assert.deepEqual(result, {
    operationId: "operation-1",
    status: "failed",
    error: "Payment setup returned an invalid pending status.",
  });
});

test("payment operation polling returns a non-retry timeout result", async () => {
  const result = await waitForProductPaymentOperation({
    operationId: "operation-1",
    fetchOperation: async () =>
      jsonResponse(202, { operationId: "operation-1", status: "queued" }),
    maxAttempts: 2,
    wait: async () => undefined,
  });

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /Contact Lash Her before retrying/);
});

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

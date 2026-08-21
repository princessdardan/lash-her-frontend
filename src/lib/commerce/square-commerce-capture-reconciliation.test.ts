import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileUncapturedSquareCommercePayments,
  type SquareCaptureReconciliationDependencies,
} from "./square-commerce-capture-reconciliation";
import type { UncapturedSquareCommerceOrder } from "@/lib/commerce/order-store";

const now = new Date("2026-08-19T12:00:00.000Z");

function order(
  orderId: string,
  providerPaymentId: string,
): UncapturedSquareCommerceOrder {
  return {
    orderId,
    purpose: "product",
    providerPaymentId,
    providerMetadata: null,
  };
}

interface Harness {
  deps: SquareCaptureReconciliationDependencies;
  completed: string[];
  captured: string[];
  uncollected: string[];
  errors: string[];
}

function createHarness(input: {
  orders: UncapturedSquareCommerceOrder[];
  statusByPayment: Record<string, string>;
  getStatusError?: Record<string, Error>;
}): Harness {
  const completed: string[] = [];
  const captured: string[] = [];
  const uncollected: string[] = [];
  const errors: string[] = [];

  const deps: SquareCaptureReconciliationDependencies = {
    async findUncaptured() {
      return input.orders;
    },
    async getPaymentStatus(paymentId) {
      const error = input.getStatusError?.[paymentId];
      if (error) throw error;
      return input.statusByPayment[paymentId] ?? "UNKNOWN";
    },
    async completePayment(paymentId) {
      completed.push(paymentId);
    },
    async markCaptured(_orderReference, paymentId) {
      captured.push(paymentId);
    },
    async markUncollected(_orderReference, paymentId) {
      uncollected.push(paymentId);
    },
    logError(message) {
      errors.push(message);
    },
    logWarn(message) {
      errors.push(message);
    },
  };

  return { deps, completed, captured, uncollected, errors };
}

test("marks an already-completed payment as captured", async () => {
  const harness = createHarness({
    orders: [order("lh-1", "pay-1")],
    statusByPayment: { "pay-1": "COMPLETED" },
  });

  const summary = await reconcileUncapturedSquareCommercePayments(
    { now },
    harness.deps,
  );

  assert.deepEqual(summary, {
    checked: 1,
    captured: 1,
    completed: 0,
    uncollected: 0,
    failed: 0,
  });
  assert.deepEqual(harness.captured, ["pay-1"]);
  assert.deepEqual(harness.completed, []);
});

test("completes a still-authorized payment then marks it captured", async () => {
  const harness = createHarness({
    orders: [order("lh-2", "pay-2")],
    statusByPayment: { "pay-2": "APPROVED" },
  });

  const summary = await reconcileUncapturedSquareCommercePayments(
    { now },
    harness.deps,
  );

  assert.equal(summary.completed, 1);
  assert.deepEqual(harness.completed, ["pay-2"]);
  assert.deepEqual(harness.captured, ["pay-2"]);
});

test("flags a canceled authorization as uncollected revenue", async () => {
  const harness = createHarness({
    orders: [order("lh-3", "pay-3")],
    statusByPayment: { "pay-3": "CANCELED" },
  });

  const summary = await reconcileUncapturedSquareCommercePayments(
    { now },
    harness.deps,
  );

  assert.equal(summary.uncollected, 1);
  assert.deepEqual(harness.completed, []);
  assert.deepEqual(harness.captured, []);
  // Terminal state recorded so it drops out of future sweeps.
  assert.deepEqual(harness.uncollected, ["pay-3"]);
  assert.equal(harness.errors.length, 1);
});

test("counts a Square lookup error as a retryable failure", async () => {
  const harness = createHarness({
    orders: [order("lh-4", "pay-4")],
    statusByPayment: {},
    getStatusError: { "pay-4": new Error("square down") },
  });

  const summary = await reconcileUncapturedSquareCommercePayments(
    { now },
    harness.deps,
  );

  assert.equal(summary.failed, 1);
  assert.equal(summary.checked, 1);
});

test("reconciles a mixed batch independently", async () => {
  const harness = createHarness({
    orders: [
      order("lh-a", "pay-a"),
      order("lh-b", "pay-b"),
      order("lh-c", "pay-c"),
    ],
    statusByPayment: {
      "pay-a": "COMPLETED",
      "pay-b": "APPROVED",
      "pay-c": "FAILED",
    },
  });

  const summary = await reconcileUncapturedSquareCommercePayments(
    { now },
    harness.deps,
  );

  assert.deepEqual(summary, {
    checked: 3,
    captured: 1,
    completed: 1,
    uncollected: 1,
    failed: 0,
  });
});

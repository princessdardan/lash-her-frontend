import type { UncapturedSquareCommerceOrder } from "@/lib/commerce/order-store";

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 100;

export interface SquareCaptureReconciliationSummary {
  checked: number;
  /** Already COMPLETED at Square (our synchronous capture was a false negative). */
  captured: number;
  /** We completed a still-authorized payment. */
  completed: number;
  /** Authorization lost/canceled — order is paid locally but funds are uncollected. */
  uncollected: number;
  /** Transient errors; will be retried on the next sweep. */
  failed: number;
}

export interface ReconcileUncapturedSquareCommercePaymentsInput {
  now: Date;
  graceMs?: number;
  limit?: number;
}

export interface SquareCaptureReconciliationDependencies {
  findUncaptured: (input: {
    paidBefore: Date;
    limit: number;
  }) => Promise<UncapturedSquareCommerceOrder[]>;
  getPaymentStatus: (paymentId: string) => Promise<string>;
  completePayment: (paymentId: string) => Promise<void>;
  markCaptured: (orderReference: string, paymentId: string) => Promise<void>;
  markUncollected: (orderReference: string, paymentId: string) => Promise<void>;
  logError: (message: string, meta: Record<string, unknown>) => void;
  logWarn: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Reconcile Square commerce orders that are locally paid but whose capture the
 * synchronous charge could not confirm. For each, re-check the authoritative
 * Square payment status and: complete a still-authorized payment, mark an
 * already-completed one, or flag a lost authorization as uncollected revenue
 * (order paid but no funds — needs manual intervention). Closes the residual
 * true-capture-failure window the webhook cannot (Square never sends a completed
 * event for a payment it never captured).
 */
export async function reconcileUncapturedSquareCommercePayments(
  input: ReconcileUncapturedSquareCommercePaymentsInput,
  dependencies: SquareCaptureReconciliationDependencies,
): Promise<SquareCaptureReconciliationSummary> {
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const paidBefore = new Date(input.now.getTime() - graceMs);

  const orders = await dependencies.findUncaptured({ paidBefore, limit });

  const summary: SquareCaptureReconciliationSummary = {
    checked: orders.length,
    captured: 0,
    completed: 0,
    uncollected: 0,
    failed: 0,
  };

  for (const order of orders) {
    try {
      const status = (
        await dependencies.getPaymentStatus(order.providerPaymentId)
      ).toUpperCase();

      if (status === "COMPLETED") {
        await dependencies.markCaptured(order.orderId, order.providerPaymentId);
        summary.captured += 1;
        continue;
      }

      if (status === "APPROVED") {
        await dependencies.completePayment(order.providerPaymentId);
        await dependencies.markCaptured(order.orderId, order.providerPaymentId);
        summary.completed += 1;
        continue;
      }

      if (status === "CANCELED" || status === "FAILED") {
        // Terminal: transition out of the swept set so it is not re-checked
        // forever, and alert once for manual follow-up.
        await dependencies.markUncollected(
          order.orderId,
          order.providerPaymentId,
        );
        dependencies.logError(
          "[square-capture-reconciliation] paid order has uncollected funds",
          {
            orderId: order.orderId,
            squarePaymentId: order.providerPaymentId,
            status,
          },
        );
        summary.uncollected += 1;
        continue;
      }

      dependencies.logWarn(
        "[square-capture-reconciliation] unexpected payment status",
        {
          orderId: order.orderId,
          squarePaymentId: order.providerPaymentId,
          status,
        },
      );
      summary.failed += 1;
    } catch (error) {
      dependencies.logError(
        "[square-capture-reconciliation] order reconciliation failed",
        {
          orderId: order.orderId,
          squarePaymentId: order.providerPaymentId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * Live wiring for the reconciliation cron. Returns null when Square commerce is
 * not enabled (nothing to reconcile).
 */
export async function runSquareCommerceCaptureReconciliation(input: {
  now: Date;
}): Promise<SquareCaptureReconciliationSummary | null> {
  const [
    { getSquareCommerceEnv },
    { createSquarePaymentsClient },
    {
      findUncapturedSquareCommerceOrders,
      markSquareCommerceOrderCaptured,
      markSquareCommerceOrderUncollected,
    },
    { log },
  ] = await Promise.all([
    import("@/lib/env/private-checkout"),
    import("@/lib/payments/square/payments-client"),
    import("@/lib/commerce/order-store"),
    import("@/lib/logging/logger"),
  ]);

  const env = getSquareCommerceEnv();
  if (env === null) {
    return null;
  }

  const client = createSquarePaymentsClient(env);

  return reconcileUncapturedSquareCommercePayments(
    { now: input.now },
    {
      findUncaptured: findUncapturedSquareCommerceOrders,
      getPaymentStatus: async (paymentId) =>
        (await client.getPayment(paymentId)).payment.status,
      completePayment: async (paymentId) => {
        await client.completePayment(paymentId);
      },
      markCaptured: markSquareCommerceOrderCaptured,
      markUncollected: markSquareCommerceOrderUncollected,
      logError: (message, meta) => log("error", message, meta),
      logWarn: (message, meta) => log("warn", message, meta),
    },
  );
}

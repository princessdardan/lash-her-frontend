import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { isChitChatsShippingEnabled } from "@/lib/shipping/config";
import { isSquareCommerceCheckoutEnabled } from "@/lib/env/private-checkout";
import { runShippingOperationWorker } from "@/lib/shipping/operation-worker";
import { drainQueuedProductOrderRefunds } from "@/lib/shipping/customer-refunds";
import {
  abandonExpiredQuotes,
  enqueueShipmentOperation,
  listShipmentsDueForPolling,
  redactExpiredShipmentPii,
} from "@/lib/shipping/shipment-store";

export const defaultDependencies = {
  now: () => new Date(),
  isSquareCommerceCheckoutEnabled,
  isChitChatsShippingEnabled,
  drainQueuedProductOrderRefunds,
  abandonExpiredQuotes,
  listShipmentsDueForPolling,
  enqueueShipmentOperation,
  runShippingOperationWorker,
  redactExpiredShipmentPii,
};

type ProductRefundRecoveryRunner = (
  task: () => ReturnType<typeof drainQueuedProductOrderRefunds>,
) => ReturnType<typeof drainQueuedProductOrderRefunds>;

type ShippingPreparationResult = {
  enabled: boolean;
  abandoned: number;
  queued: number;
};
type ShippingPreparationRecoveryRunner = (
  task: () => Promise<ShippingPreparationResult>,
) => Promise<ShippingPreparationResult>;
type ShippingExecutionRecoveryRunner = (
  task: () => ReturnType<typeof runShippingOperationWorker>,
) => ReturnType<typeof runShippingOperationWorker>;

export function createShippingWorkerCronHandler(
  dependencies: typeof defaultDependencies = defaultDependencies,
  runRefundRecovery: ProductRefundRecoveryRunner = (task) => task(),
  runPreparationRecovery: ShippingPreparationRecoveryRunner = (task) => task(),
  runExecutionRecovery: ShippingExecutionRecoveryRunner = (task) => task(),
): (req: Request) => Promise<Response> {
  return async function shippingWorkerCron(req: Request): Promise<Response> {
    if (!authorized(req)) return new Response(null, { status: 401 });
    try {
      return await runShippingWorkerCron(
        dependencies,
        runRefundRecovery,
        runPreparationRecovery,
        runExecutionRecovery,
      );
    } catch (error) {
      if (error instanceof WriterAdmissionError) {
        return NextResponse.json(
          {
            error:
              "This operation is temporarily unavailable. Please retry shortly.",
          },
          {
            status: 503,
            headers: { "cache-control": "no-store", "retry-after": "30" },
          },
        );
      }
      return NextResponse.json(
        {
          error: "Shipping worker failed",
          incident: createHash("sha256")
            .update(error instanceof Error ? error.message : "unknown")
            .digest("hex")
            .slice(0, 12),
        },
        { status: 503 },
      );
    }
  };
}

async function runShippingWorkerCron(
  dependencies: typeof defaultDependencies,
  runRefundRecovery: ProductRefundRecoveryRunner,
  runPreparationRecovery: ShippingPreparationRecoveryRunner,
  runExecutionRecovery: ShippingExecutionRecoveryRunner,
): Promise<Response> {
  const now = dependencies.now();
  // Manual Square refunds queue a row (via the admin refund route) and are
  // executed here. Independent of Chit Chats shipping being enabled.
  const refunds = await runRefundRecovery(async () =>
    dependencies.isSquareCommerceCheckoutEnabled()
      ? dependencies.drainQueuedProductOrderRefunds()
      : { processed: 0, succeeded: 0, needsReview: 0, refunds: [] },
  );
  const refundSummary = {
    processed: refunds.processed,
    succeeded: refunds.succeeded,
    needsReview: refunds.needsReview,
  };
  const preparation = await runPreparationRecovery(() =>
    prepareShipping(dependencies, now),
  );
  if (!preparation.enabled) {
    return NextResponse.json(
      { enabled: false, queued: 0, refunds: refundSummary },
      { status: refunds.needsReview > 0 ? 503 : 200 },
    );
  }
  const { abandoned, queued } = preparation;
  const operations = await runExecutionRecovery(() =>
    dependencies.runShippingOperationWorker(),
  );
  const redacted = await dependencies.redactExpiredShipmentPii(now);
  return NextResponse.json(
    { queued, abandoned, operations, redacted, refunds: refundSummary },
    {
      status:
        operations.deadLettered > 0 ||
        operations.retried > 0 ||
        operations.fenced > 0 ||
        refunds.needsReview > 0
          ? 503
          : 200,
    },
  );
}

async function prepareShipping(
  dependencies: typeof defaultDependencies,
  now: Date,
): Promise<ShippingPreparationResult> {
  if (!dependencies.isChitChatsShippingEnabled())
    return { enabled: false, abandoned: 0, queued: 0 };
  const abandoned = await dependencies.abandonExpiredQuotes(now);
  const due = await dependencies.listShipmentsDueForPolling(now, 100);
  let queued = 0;
  for (const shipment of due) {
    if (!shipment.providerShipmentId) continue;
    const bucket = pollingBucket(shipment.status, now);
    await dependencies.enqueueShipmentOperation({
      shipmentId: shipment.id,
      type: "tracking",
      idempotencyKey: `tracking/${shipment.id}/${shipment.stateVersion}/${bucket}`,
      operationPayloadHash: createHash("sha256")
        .update(`${shipment.id}:${shipment.stateVersion}:${bucket}`)
        .digest("hex"),
      payload: { expectedShipmentStateVersion: shipment.stateVersion },
    });
    queued += 1;
  }
  return { enabled: true, abandoned, queued };
}

function pollingBucket(status: string, now: Date): number {
  const interval =
    status === "purchase_pending"
      ? 60_000
      : status === "label_ready"
        ? 30 * 60_000
        : ["accepted", "in_transit"].includes(status)
          ? 2 * 60 * 60_000
          : 6 * 60 * 60_000;
  return Math.floor(now.getTime() / interval);
}

function authorized(req: Request): boolean {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const accepted = [
    process.env.CHITCHATS_WORKER_CRON_SECRET,
    process.env.CRON_SECRET,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return Boolean(
    token && accepted.some((secret) => constantTimeEqual(token, secret)),
  );
}

function constantTimeEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

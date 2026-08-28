import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
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

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 401 });
  try {
    return await runShippingWorkerCron();
  } catch (error) {
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
}

async function runShippingWorkerCron(): Promise<Response> {
  const now = new Date();
  // Manual Square refunds queue a row (via the admin refund route) and are
  // executed here. Independent of Chit Chats shipping being enabled.
  const refunds = isSquareCommerceCheckoutEnabled()
    ? await drainQueuedProductOrderRefunds()
    : { processed: 0, succeeded: 0, needsReview: 0, refunds: [] };
  const refundSummary = {
    processed: refunds.processed,
    succeeded: refunds.succeeded,
    needsReview: refunds.needsReview,
  };
  if (!isChitChatsShippingEnabled()) {
    return NextResponse.json(
      { enabled: false, queued: 0, refunds: refundSummary },
      { status: refunds.needsReview > 0 ? 503 : 200 },
    );
  }
  const abandoned = await abandonExpiredQuotes(now);
  const due = await listShipmentsDueForPolling(now, 100);
  let queued = 0;
  for (const shipment of due) {
    if (!shipment.providerShipmentId) continue;
    const bucket = pollingBucket(shipment.status, now);
    await enqueueShipmentOperation({
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
  const operations = await runShippingOperationWorker();
  const redacted = await redactExpiredShipmentPii(now);
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

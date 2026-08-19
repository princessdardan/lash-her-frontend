import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isChitChatsShippingEnabled } from "@/lib/shipping/config";
import { runShippingOperationWorker } from "@/lib/shipping/operation-worker";
import { drainProductPaymentRiskAlerts } from "@/lib/shipping/risk-alert-drain";
import { getShippingPolicyEnforcementMode } from "@/lib/shipping/policy";
import { runPaymentObligationInitializationWorker } from "@/lib/commerce/product-payment-obligation-worker";
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
  const riskAlerts = await drainProductPaymentRiskAlerts(now);
  const mode = getShippingPolicyEnforcementMode();
  const paymentInitializations =
    mode === "enforce"
      ? await runPaymentObligationInitializationWorker({ now })
      : { claimed: 0, succeeded: 0, failed: 0, outcomeUnknown: 0 };
  if (!isChitChatsShippingEnabled()) {
    return NextResponse.json(
      { enabled: false, queued: 0, riskAlerts, paymentInitializations },
      {
        status:
          riskAlerts.deadLettered > 0 ||
          paymentInitializations.failed > 0 ||
          paymentInitializations.outcomeUnknown > 0
            ? 503
            : 200,
      },
    );
  }
  if (mode !== "enforce") {
    return NextResponse.json(
      {
        enabled: true,
        mode,
        mutated: false,
        queued: 0,
        riskAlerts,
        paymentInitializations,
      },
      { status: riskAlerts.deadLettered > 0 ? 503 : 200 },
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
    {
      queued,
      abandoned,
      operations,
      riskAlerts,
      paymentInitializations,
      redacted,
    },
    {
      status:
        operations.deadLettered > 0 ||
        operations.retried > 0 ||
        operations.fenced > 0 ||
        riskAlerts.deadLettered > 0 ||
        riskAlerts.retried > 0 ||
        paymentInitializations.failed > 0 ||
        paymentInitializations.outcomeUnknown > 0
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

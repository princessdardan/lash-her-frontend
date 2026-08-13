import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createChitChatsClient } from "@/lib/shipping/chitchats-client";
import {
  getChitChatsConfig,
  isChitChatsShippingEnabled,
} from "@/lib/shipping/config";
import {
  sendShipmentNotification,
  type ShipmentNotificationKind,
} from "@/lib/shipping/notifications";
import {
  abandonExpiredQuotes,
  getShipmentNotificationContext,
  listShipmentsDueForPolling,
  markShipmentNotificationSent,
  redactExpiredShipmentPii,
  recordShipmentEvent,
  updateShipmentFromProvider,
} from "@/lib/shipping/shipment-store";
import {
  normalizeChitChatsStatus,
  normalizeChitChatsTransition,
  stripSignedLabelUrls,
} from "@/lib/shipping/status";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return new Response(null, { status: 401 });
  if (!isChitChatsShippingEnabled())
    return NextResponse.json({ enabled: false, polled: 0 });
  const client = createChitChatsClient(getChitChatsConfig());
  const due = await listShipmentsDueForPolling(new Date(), 100);
  let failures = 0;
  let notifications = 0;
  for (const local of due) {
    if (!local.providerShipmentId) continue;
    try {
      const provider = await client.getShipment(local.providerShipmentId);
      const normalized = normalizeChitChatsTransition(local.status, provider);
      await updateShipmentFromProvider({
        id: local.id,
        status: normalized,
        providerStatus: provider.status,
        rawShipment: stripSignedLabelUrls(provider),
        trackingNumber: provider.carrier_tracking_code,
        trackingUrl: provider.tracking_url,
        actualPostageCents: moneyToCents(provider.postage_fee),
        actualInsuranceCents: moneyToCents(provider.insurance_fee),
      });
      for (const event of provider.tracking_events ?? []) {
        const occurredAt = event.created_at
          ? new Date(event.created_at)
          : new Date();
        if (Number.isNaN(occurredAt.getTime())) continue;
        await recordShipmentEvent({
          shipmentId: local.id,
          fingerprint: createHash("sha256")
            .update(
              JSON.stringify([
                local.id,
                event.type,
                event.title,
                event.status,
                event.created_at,
              ]),
            )
            .digest("hex"),
          providerStatus: event.status ?? undefined,
          normalizedStatus: normalized,
          description: event.title ?? undefined,
          payload: Object.fromEntries(
            Object.entries(event).filter(([key]) => !key.includes("url")),
          ),
          occurredAt,
        });
      }
      notifications += await notifyIfNeeded(local.id, normalized);
    } catch {
      failures += 1;
    }
  }
  const abandoned = await abandonExpiredQuotes();
  const redacted = await redactExpiredShipmentPii();
  return NextResponse.json(
    { polled: due.length, failures, notifications, abandoned, redacted },
    { status: failures === due.length && due.length > 0 ? 503 : 200 },
  );
}

async function notifyIfNeeded(
  shipmentId: string,
  status: ReturnType<typeof normalizeChitChatsStatus>,
): Promise<number> {
  const context = await getShipmentNotificationContext(shipmentId);
  if (!context) return 0;
  let kind: ShipmentNotificationKind | null = null;
  if (
    ["accepted", "in_transit"].includes(status) &&
    !context.acceptedEmailSentAt
  )
    kind = "accepted";
  if (status === "exception" && !context.exceptionEmailSentAt)
    kind = "exception";
  if (status === "delivered" && !context.deliveredEmailSentAt)
    kind = "delivered";
  if (!kind) return 0;
  await sendShipmentNotification(context, kind);
  await markShipmentNotificationSent(shipmentId, kind);
  return 1;
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

function moneyToCents(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

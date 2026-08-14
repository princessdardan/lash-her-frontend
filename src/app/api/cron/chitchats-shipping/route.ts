import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ChitChatsApiError,
  createChitChatsClient,
} from "@/lib/shipping/chitchats-client";
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
  claimCleanupJobs,
  completeShipmentJob,
  getShipmentForCleanup,
  getShipmentNotificationContext,
  listShipmentsDueForPolling,
  markShipmentNotificationSent,
  redactExpiredShipmentPii,
  recordShipmentEvent,
  retryShipmentJob,
  updateShipmentFromProvider,
} from "@/lib/shipping/shipment-store";
import {
  normalizeChitChatsStatus,
  normalizeChitChatsTransition,
  stripSignedLabelUrls,
} from "@/lib/shipping/status";
import { parseProviderMoneyCents } from "@/lib/shipping/provider-money";

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
        actualPurchaseTotalCents: parseProviderMoneyCents(
          provider.purchase_amount,
        ),
        actualPostageCents: parseProviderMoneyCents(provider.postage_fee),
        actualInsuranceCents: parseProviderMoneyCents(provider.insurance_fee),
        actualDeliveryFeeCents: parseProviderMoneyCents(provider.delivery_fee),
        actualTariffFeeCents: parseProviderMoneyCents(provider.tariff_fee),
        actualFdaPriorNotificationFeeCents: parseProviderMoneyCents(
          provider.fda_prior_notification_fee,
        ),
        actualFederalTaxCents: parseProviderMoneyCents(provider.federal_tax),
        actualProvincialTaxCents: parseProviderMoneyCents(
          provider.provincial_tax,
        ),
        estimatedDeliveryAt: provider.estimated_delivery_at,
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
  const cleanup = await processCleanupJobs(client);
  const redacted = await redactExpiredShipmentPii();
  return NextResponse.json(
    {
      polled: due.length,
      failures: failures + cleanup.failures,
      notifications,
      abandoned,
      cleanup,
      redacted,
    },
    { status: failures + cleanup.failures > 0 ? 503 : 200 },
  );
}

async function processCleanupJobs(
  client: ReturnType<typeof createChitChatsClient>,
): Promise<{ claimed: number; completed: number; failures: number }> {
  const jobs = await claimCleanupJobs();
  let completed = 0;
  let failures = 0;
  for (const job of jobs) {
    const shipment = await getShipmentForCleanup(job.shipmentId);
    if (!shipment) {
      await completeShipmentJob(job.id, { outcomeCode: "local_missing" });
      completed += 1;
      continue;
    }
    try {
      let providerId = shipment.providerShipmentId;
      if (!providerId) {
        const matches = (
          await client.findShipments(shipment.publicReference)
        ).filter(
          (candidate) =>
            candidate.order_id === shipment.publicReference ||
            candidate.id === shipment.providerShipmentId,
        );
        if (matches.length !== 1) {
          await completeShipmentJob(job.id, {
            outcomeCode:
              matches.length === 0
                ? "provider_draft_not_found"
                : "ambiguous_provider_drafts",
            manualReview: matches.length > 1,
          });
          completed += 1;
          continue;
        }
        providerId = matches[0]!.id;
      }
      const provider = await client.getShipment(providerId);
      if (provider.status !== "unpaid") {
        await completeShipmentJob(job.id, {
          outcomeCode: `not_deletable:${provider.status}`,
          manualReview: true,
        });
        completed += 1;
        continue;
      }
      await client.deleteShipment(providerId);
      await completeShipmentJob(job.id, { outcomeCode: "provider_deleted" });
      completed += 1;
    } catch (error) {
      if (error instanceof ChitChatsApiError && error.status === 404) {
        await completeShipmentJob(job.id, {
          outcomeCode: "provider_not_found",
        });
        completed += 1;
        continue;
      }
      failures += 1;
      await retryShipmentJob(job.id, {
        error: error instanceof Error ? error.message : "Cleanup failed",
        retryAfterSeconds:
          error instanceof ChitChatsApiError ? error.retryAfterSeconds : null,
      });
    }
  }
  return { claimed: jobs.length, completed, failures };
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

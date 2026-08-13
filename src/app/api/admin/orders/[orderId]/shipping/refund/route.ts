import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { createChitChatsClient } from "@/lib/shipping/chitchats-client";
import { getChitChatsConfig } from "@/lib/shipping/config";
import {
  claimShipmentRefund,
  updateShipmentFromProvider,
} from "@/lib/shipping/shipment-store";
import {
  normalizeChitChatsStatus,
  stripSignedLabelUrls,
} from "@/lib/shipping/status";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const { orderId } = await params;
  const shipment = await claimShipmentRefund(orderId);
  if (!shipment?.providerShipmentId)
    return NextResponse.json(
      { error: "Shipment cannot be refunded" },
      { status: 409 },
    );
  try {
    const provider = await createChitChatsClient(
      getChitChatsConfig(),
    ).refundShipment(shipment.providerShipmentId);
    const status = normalizeChitChatsStatus(provider);
    await updateShipmentFromProvider({
      id: shipment.id,
      status: status === "voided" ? "voided" : "refund_pending",
      providerStatus: provider.status,
      rawShipment: stripSignedLabelUrls(provider),
      trackingNumber: provider.carrier_tracking_code,
      trackingUrl: provider.tracking_url,
    });
    await recordAdminAuditBestEffort({
      action: "fulfillment.postage_refund",
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: shipment.id,
      targetType: "product_shipment",
      metadata: { orderId },
    });
    return NextResponse.json({
      status: status === "voided" ? "voided" : "refund_pending",
    });
  } catch (error) {
    await updateShipmentFromProvider({
      id: shipment.id,
      status: "manual_review",
      providerStatus: shipment.providerStatus ?? "unknown",
      rawShipment: shipment.rawShipment ?? {},
    });
    await recordAdminAuditBestEffort({
      action: "fulfillment.postage_refund",
      actor,
      domain: "fulfillment",
      outcome: "failure",
      reason: error instanceof Error ? error.message : "Unknown error",
      targetId: shipment.id,
      targetType: "product_shipment",
      metadata: { orderId, refundOutcomeUnknown: true },
    });
    return NextResponse.json(
      { error: "Postage refund outcome is unknown and requires review" },
      { status: 503 },
    );
  }
}

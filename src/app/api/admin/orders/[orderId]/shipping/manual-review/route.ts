import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { acknowledgeShipmentManualReview } from "@/lib/shipping/shipment-store";

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
  const shipmentId = await acknowledgeShipmentManualReview(orderId);
  if (!shipmentId)
    return NextResponse.json(
      { error: "Shipment is not in manual review" },
      { status: 409 },
    );
  await recordAdminAuditBestEffort({
    action: "fulfillment.manual_review_acknowledged",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: shipmentId,
    targetType: "product_shipment",
    metadata: { orderId },
  });
  return NextResponse.json({ acknowledged: true });
}

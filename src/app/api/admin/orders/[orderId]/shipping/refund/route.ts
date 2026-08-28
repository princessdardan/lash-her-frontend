import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { enqueueRefundOperationForOrder } from "@/lib/shipping/shipment-store";
import { isChitChatsShippingEnabled } from "@/lib/shipping/config";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (!isChitChatsShippingEnabled())
    return NextResponse.json(
      { error: "Chit Chats shipping is not enabled" },
      { status: 503 },
    );
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const { orderId } = await params;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const shipmentId =
    typeof body?.shipmentId === "string" ? body.shipmentId : "";
  const expectedStateVersion = Number(body?.expectedStateVersion);
  if (
    !shipmentId ||
    !Number.isInteger(expectedStateVersion) ||
    expectedStateVersion < 1
  )
    return NextResponse.json(
      { error: "Shipment generation and expected version are required" },
      { status: 400 },
    );
  const operation = await enqueueRefundOperationForOrder({
    orderReference: orderId,
    shipmentId,
    expectedStateVersion,
    idempotencyKey: `postage-refund/${shipmentId}/${expectedStateVersion}`,
  });
  if (!operation)
    return NextResponse.json(
      { error: "Shipment changed or is not the refundable active generation" },
      { status: 409 },
    );
  await recordAdminAuditBestEffort({
    action: "fulfillment.postage_refund_queued",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: shipmentId,
    targetType: "product_shipment",
    metadata: { orderId, operationId: operation.id, expectedStateVersion },
  });
  return NextResponse.json(
    { operationId: operation.id, shipmentId, status: operation.status },
    {
      status: 202,
      headers: { "Cache-Control": "no-store", "Retry-After": "2" },
    },
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { enqueuePurchaseOperationForOrder } from "@/lib/shipping/shipment-store";
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
  const measuredWeightGrams = Number(body?.measuredWeightGrams);
  const shipDateInput = typeof body?.shipDate === "string" ? body.shipDate : "";
  const parsedShipDate = /^\d{4}-\d{2}-\d{2}$/.test(shipDateInput)
    ? new Date(`${shipDateInput}T00:00:00.000Z`)
    : new Date(NaN);
  const shipDate =
    Number.isFinite(parsedShipDate.getTime()) &&
    parsedShipDate.toISOString().slice(0, 10) === shipDateInput
      ? shipDateInput
      : "";
  if (
    !shipmentId ||
    !Number.isInteger(expectedStateVersion) ||
    expectedStateVersion < 1 ||
    !Number.isInteger(measuredWeightGrams) ||
    measuredWeightGrams <= 0 ||
    measuredWeightGrams > 50_000 ||
    !shipDate
  ) {
    return NextResponse.json(
      {
        error:
          "Shipment generation, version, measured weight, and ship date are required",
      },
      { status: 400 },
    );
  }
  const operation = await enqueuePurchaseOperationForOrder({
    orderReference: orderId,
    shipmentId,
    expectedStateVersion,
    idempotencyKey: `purchase/${shipmentId}/${expectedStateVersion}`,
    payload: { measuredWeightGrams, shipDate },
  });
  if (!operation)
    return NextResponse.json(
      {
        error:
          "Shipment changed, is not active, or funding/risk clearance is unavailable",
      },
      { status: 409 },
    );
  await recordAdminAuditBestEffort({
    action: "fulfillment.postage_purchase_queued",
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

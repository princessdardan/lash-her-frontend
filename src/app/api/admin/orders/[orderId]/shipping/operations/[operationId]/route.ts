import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/admin/auth";
import { getShipmentOperationForOrder } from "@/lib/shipping/shipment-store";

export async function GET(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ operationId: string; orderId: string }>;
  },
): Promise<Response> {
  await requirePermission("fulfillment:manage");
  const { operationId, orderId } = await params;
  const shipmentId = new URL(req.url).searchParams.get("shipmentId")?.trim();
  if (!shipmentId) {
    return NextResponse.json(
      { error: "shipmentId is required" },
      { status: 400 },
    );
  }
  const operation = await getShipmentOperationForOrder({
    operationId,
    orderReference: orderId,
    shipmentId,
  });
  if (!operation) {
    return NextResponse.json({ error: "Operation not found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      attemptCount: operation.attemptCount,
      lastError: operation.lastError,
      operationId: operation.id,
      outcomeCode: operation.outcomeCode,
      outcomeUnknown: operation.outcomeUnknown,
      shipmentId: operation.shipmentId,
      stateVersion: operation.stateVersion,
      status: operation.status,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

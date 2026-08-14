import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  applyApprovedAddressChange,
  discardPreparedAddressChangeShipment,
  reconcileAddressChangePostage,
} from "@/lib/shipping/address-changes";
import {
  processProductOrderRefund,
  queueProductOrderRefund,
} from "@/lib/shipping/customer-refunds";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const { requestId } = await params;
  try {
    await reconcileAddressChangePostage(requestId);
    const result = await applyApprovedAddressChange(requestId);
    const providerDraftCleaned = true;
    let refundStatus: string | null = null;
    if (result.refundDecreaseCents >= 100) {
      const refund = await queueProductOrderRefund({
        orderReference: result.orderReference,
        amountCents: result.refundDecreaseCents,
        reason: "Address change reduced shipping price",
        requestedByAdminUserId: actor.user.id,
      });
      refundStatus = (await processProductOrderRefund(refund.id)).status;
    }
    await recordAdminAuditBestEffort({
      action: "fulfillment.address_change_applied",
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: requestId,
      targetType: "product_order_address_change_request",
      metadata: { ...result, refundStatus, providerDraftCleaned },
    });
    return NextResponse.json({ ...result, refundStatus, providerDraftCleaned });
  } catch (error) {
    const providerDraftCleaned =
      await discardPreparedAddressChangeShipment(requestId);
    await recordAdminAuditBestEffort({
      action: "fulfillment.address_change_applied",
      actor,
      domain: "fulfillment",
      outcome: "failure",
      reason:
        error instanceof Error ? error.message : "Address application failed",
      targetId: requestId,
      targetType: "product_order_address_change_request",
      metadata: { providerDraftCleaned },
    });
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Address application failed",
      },
      { status: 409 },
    );
  }
}

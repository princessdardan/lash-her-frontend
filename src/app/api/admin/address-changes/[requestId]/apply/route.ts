import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  applyApprovedAddressChange,
  reconcileAddressChangePostage,
} from "@/lib/shipping/address-changes";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
  const { requestId } = await params;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const expectedStateVersion = body?.expectedStateVersion;
  if (
    typeof expectedStateVersion !== "number" ||
    !Number.isInteger(expectedStateVersion) ||
    expectedStateVersion < 1
  ) {
    return NextResponse.json(
      { error: "A valid expectedStateVersion is required" },
      { status: 400 },
    );
  }
  try {
    await requireRecentAdminAuthentication({
      action: "fulfillment.address_change_apply",
      target: JSON.stringify({ requestId, expectedStateVersion }),
    });
    const reconciliation = await reconcileAddressChangePostage(
      requestId,
      expectedStateVersion,
    );
    if (!reconciliation.prepared) {
      return NextResponse.json(
        {
          status: reconciliation.awaitingDecision
            ? "awaiting_customer_decision"
            : "queued",
          operationId: reconciliation.operationId,
        },
        { status: 202 },
      );
    }
    const result = await applyApprovedAddressChange({
      requestId,
      requestedByAdminUserId: actor.user.id,
      expectedStateVersion,
    });
    await recordAdminAuditBestEffort({
      action: "fulfillment.address_change_applied",
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: requestId,
      targetType: "product_order_address_change_request",
      metadata: result,
    });
    return NextResponse.json(
      {
        ...result,
        refundStatus: result.refundOperationIds?.length
          ? "queued"
          : "not_required",
      },
      {
        status:
          result.refundOperationIds?.length ||
          result.preparedRefreshPending ||
          result.preparedPurchasePending
            ? 202
            : 200,
      },
    );
  } catch (error) {
    await recordAdminAuditBestEffort({
      action: "fulfillment.address_change_applied",
      actor,
      domain: "fulfillment",
      outcome: "failure",
      reason:
        error instanceof Error ? error.message : "Address application failed",
      targetId: requestId,
      targetType: "product_order_address_change_request",
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

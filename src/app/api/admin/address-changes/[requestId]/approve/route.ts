import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  approveAddressChange,
  recordAddressPhoneCallbackEvidence,
} from "@/lib/shipping/address-changes";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import {
  addressApprovalStepUpScope,
  type AddressApprovalPayload,
} from "@/lib/shipping/address-approval-step-up";

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
  try {
    await assertConfiguredFulfillmentOwner(actor.user.id);
  } catch {
    return NextResponse.json(
      {
        error:
          "Only the configured fulfillment owner may approve address changes",
      },
      { status: 403 },
    );
  }
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
  const responsibility =
    body?.responsibility === "customer" || body?.responsibility === "lash_her"
      ? body.responsibility
      : undefined;
  const action =
    body?.action === "fraud_clearance"
      ? "fraud_clearance"
      : body?.action === "address_approval"
        ? "address_approval"
        : body?.action === "record_phone_callback"
          ? "record_phone_callback"
          : null;
  if (!action)
    return NextResponse.json(
      { error: "Approval action is required" },
      { status: 400 },
    );
  const expectedStateVersion =
    typeof body?.expectedStateVersion === "number" &&
    Number.isInteger(body.expectedStateVersion) &&
    body.expectedStateVersion > 0
      ? body.expectedStateVersion
      : null;
  if (expectedStateVersion === null)
    return NextResponse.json(
      { error: "Expected address-request version is required" },
      { status: 400 },
    );
  const rationale =
    typeof body?.rationale === "string"
      ? body.rationale.trim().slice(0, 1_000)
      : "";
  const callbackEvidenceReference =
    typeof body?.callbackEvidenceReference === "string"
      ? body.callbackEvidenceReference.trim().slice(0, 500)
      : "";
  const payload: AddressApprovalPayload = {
    action,
    callbackEvidenceReference,
    expectedStateVersion,
    rationale,
    responsibility,
  };
  const stepUp = addressApprovalStepUpScope(requestId, payload);
  let stepUpAuthenticatedAt: Date;
  try {
    stepUpAuthenticatedAt = await requireRecentAdminAuthentication(stepUp);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Step-up authentication is required",
        stepUp,
      },
      { status: 409 },
    );
  }
  try {
    if (action === "record_phone_callback") {
      const recorded = await recordAddressPhoneCallbackEvidence({
        requestId,
        adminUserId: actor.user.id,
        expectedStateVersion,
        rationale,
        evidenceReference: callbackEvidenceReference,
        stepUpAuthenticatedAt,
      });
      await recordAdminAuditBestEffort({
        action: "fulfillment.address_phone_callback_recorded",
        actor,
        domain: "fulfillment",
        outcome: "success",
        targetId: requestId,
        targetType: "product_order_address_change_request",
        metadata: { callbackEvidenceId: recorded.id },
      });
      return NextResponse.json(recorded, { status: 201 });
    }
    const result = await approveAddressChange({
      requestId,
      adminUserId: actor.user.id,
      action,
      expectedCallbackEvidenceReference: callbackEvidenceReference,
      expectedStateVersion,
      responsibility,
      rationale,
      stepUpAuthenticatedAt,
    });
    await recordAdminAuditBestEffort({
      action: "fulfillment.address_change_approved",
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: requestId,
      targetType: "product_order_address_change_request",
      metadata: {
        approvalComplete: result.complete,
        responsibility: responsibility ?? null,
      },
    });
    return NextResponse.json(result, { status: result.complete ? 200 : 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval failed" },
      { status: 409 },
    );
  }
}

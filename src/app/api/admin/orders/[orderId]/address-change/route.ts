import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  issueAddressChange,
  revokeAddressChanges,
} from "@/lib/shipping/address-changes";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";
import { addressRevocationStepUpScope } from "@/lib/shipping/address-approval-step-up";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
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
      { error: "Customer links are disabled outside enforce mode" },
      { status: 409 },
    );
  }
  const { orderId } = await params;
  let issued: Awaited<ReturnType<typeof issueAddressChange>>;
  try {
    issued = await issueAddressChange({
      orderReference: orderId,
      notificationOrigin: req.nextUrl.origin,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Address change could not be issued",
      },
      { status: 409 },
    );
  }
  await recordAdminAuditBestEffort({
    action: "fulfillment.address_change_issued",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: issued.id,
    targetType: "product_order_address_change_request",
    metadata: { orderId },
  });
  return NextResponse.json({ id: issued.id }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
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
      { error: "Customer links are disabled outside enforce mode" },
      { status: 409 },
    );
  }
  const { orderId } = await params;
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const requestId =
    typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const expectedStateVersion =
    typeof body?.expectedStateVersion === "number" &&
    Number.isInteger(body.expectedStateVersion) &&
    body.expectedStateVersion > 0
      ? body.expectedStateVersion
      : null;
  const rationale =
    typeof body?.rationale === "string"
      ? body.rationale.trim().slice(0, 1_000)
      : "";
  const evidenceReference =
    typeof body?.evidenceReference === "string"
      ? body.evidenceReference.trim().slice(0, 500)
      : "";
  if (
    !requestId ||
    expectedStateVersion === null ||
    rationale.length < 10 ||
    evidenceReference.length < 6
  )
    return NextResponse.json(
      { error: "Request, version, rationale, and evidence are required" },
      { status: 400 },
    );
  const stepUp = addressRevocationStepUpScope({
    evidenceReference,
    expectedStateVersion,
    orderReference: orderId,
    rationale,
    requestId,
  });
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
  let revoked: number;
  try {
    revoked = await revokeAddressChanges({
      evidenceReference,
      expectedStateVersion,
      orderReference: orderId,
      rationale,
      requestId,
      requestedByAdminUserId: actor.user.id,
      stepUpAuthenticatedAt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Revocation failed" },
      { status: 409 },
    );
  }
  await recordAdminAuditBestEffort({
    action: "fulfillment.address_change_revoked",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: orderId,
    targetType: "checkout_order",
    metadata: { revoked },
  });
  return NextResponse.json({ revoked });
}

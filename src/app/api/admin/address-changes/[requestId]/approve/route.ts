import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { approveAddressChange } from "@/lib/shipping/address-changes";

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
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const responsibility =
    body?.responsibility === "customer" || body?.responsibility === "lash_her"
      ? body.responsibility
      : undefined;
  const rationale = typeof body?.rationale === "string" ? body.rationale : "";
  const evidence =
    body?.evidence && typeof body.evidence === "object"
      ? (body.evidence as Record<string, unknown>)
      : undefined;
  try {
    const stepUpAuthenticatedAt = await requireRecentAdminAuthentication();
    const result = await approveAddressChange({
      requestId,
      adminUserId: actor.user.id,
      responsibility,
      rationale,
      stepUpAuthenticatedAt,
      phoneCallbackCompleted: body?.phoneCallbackCompleted === true,
      providerEvidenceAvailable: body?.providerEvidenceAvailable === true,
      evidence,
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
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approval failed" },
      { status: 409 },
    );
  }
}

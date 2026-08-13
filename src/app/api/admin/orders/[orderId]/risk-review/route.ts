import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { recordProductOrderRiskReview } from "@/lib/shipping/risk-review";
import { activateShipmentForPaidOrder } from "@/lib/shipping/shipment-store";

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
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const decision = body?.decision;
  const rationale = typeof body?.rationale === "string" ? body.rationale : "";
  if (decision !== "clear_false_positive" && decision !== "escalate")
    return NextResponse.json(
      { error: "Risk decision is invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  try {
    const result = await recordProductOrderRiskReview({
      orderReference: orderId,
      reviewerAdminUserId: actor.user.id,
      decision,
      rationale,
    });
    if (result.cleared) await activateShipmentForPaidOrder(orderId);
    await recordAdminAuditBestEffort({
      action: `fulfillment.risk_${decision}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: orderId,
      targetType: "checkout_order",
      metadata: { cleared: result.cleared },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Risk review failed" },
      { status: 409 },
    );
  }
}

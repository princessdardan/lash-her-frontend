import { NextResponse, type NextRequest } from "next/server";
import {
  requirePermission,
  requireRecentAdminAuthentication,
} from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { recordProductOrderRiskReview } from "@/lib/shipping/risk-review";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
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
  const incidentId =
    typeof body?.incidentId === "string" ? body.incidentId.trim() : "";
  const expectedIncidentStateVersion = Number(body?.stateVersion);
  const rationale = typeof body?.rationale === "string" ? body.rationale : "";
  if (
    (decision !== "clear_false_positive" && decision !== "escalate") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      incidentId,
    ) ||
    !Number.isInteger(expectedIncidentStateVersion) ||
    expectedIncidentStateVersion < 1
  )
    return NextResponse.json(
      { error: "Risk decision is invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  try {
    const stepUpAuthenticatedAt =
      decision === "clear_false_positive"
        ? await requireRecentAdminAuthentication({
            action: "risk:clear_false_positive",
            target: incidentId,
          })
        : undefined;
    const result = await recordProductOrderRiskReview({
      orderReference: orderId,
      incidentId,
      expectedIncidentStateVersion,
      reviewerAdminUserId: actor.user.id,
      decision,
      rationale,
      stepUpAuthenticatedAt,
    });
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

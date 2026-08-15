import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  issueCustomerDecision,
  revokeCustomerDecisions,
  type CustomerDecisionKind,
} from "@/lib/shipping/customer-decisions";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

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
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const kind = parseDecisionKind(body?.kind);
  if (kind === "service_substitution" || kind === "signature_requirement") {
    return NextResponse.json(
      { error: "Address consent decisions are issued by the address workflow" },
      { status: 409 },
    );
  }
  const allowedOutcomes = Array.isArray(body?.allowedOutcomes)
    ? body.allowedOutcomes.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const expiresAt =
    typeof body?.expiresAt === "string"
      ? new Date(body.expiresAt)
      : new Date(NaN);
  const shipmentId =
    typeof body?.shipmentId === "string" ? body.shipmentId : undefined;
  const caseId = typeof body?.caseId === "string" ? body.caseId : undefined;
  if (
    !kind ||
    !Number.isFinite(expiresAt.getTime()) ||
    (kind === "loss_damage_remedy" ? !caseId : !shipmentId)
  )
    return NextResponse.json(
      { error: "Decision request is invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  const issued = await issueCustomerDecision({
    orderReference: orderId,
    caseId,
    shipmentId,
    kind,
    scopeKey:
      typeof body?.scopeKey === "string" && body.scopeKey.trim()
        ? body.scopeKey.trim()
        : `${kind}/${caseId ?? shipmentId}/${expiresAt.toISOString()}`,
    proposedConditions:
      body?.proposedConditions && typeof body.proposedConditions === "object"
        ? (body.proposedConditions as Record<string, unknown>)
        : undefined,
    allowedOutcomes,
    expiresAt,
    notificationOrigin: req.nextUrl.origin,
  });
  await recordAdminAuditBestEffort({
    action: "fulfillment.customer_decision_issued",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: issued.id,
    targetType: "product_order_customer_decision",
    metadata: { orderId, kind, allowedOutcomes },
  });
  return NextResponse.json({ id: issued.id }, { status: 201 });
}

function parseDecisionKind(value: unknown): CustomerDecisionKind | null {
  return typeof value === "string" &&
    [
      "missed_handoff",
      "loss_damage_remedy",
      "service_substitution",
      "signature_requirement",
    ].includes(value)
    ? (value as CustomerDecisionKind)
    : null;
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
  const kind = typeof body?.kind === "string" ? body.kind.trim() : undefined;
  const revoked = await revokeCustomerDecisions({
    orderReference: orderId,
    kind,
  });
  await recordAdminAuditBestEffort({
    action: "fulfillment.customer_decision_revoked",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: orderId,
    targetType: "checkout_order",
    metadata: { kind: kind ?? null, revoked },
  });
  return NextResponse.json({ revoked });
}

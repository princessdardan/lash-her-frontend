import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  issueCustomerDecision,
  revokeCustomerDecisions,
} from "@/lib/shipping/customer-decisions";
import { sendShippingCustomerLinkEmail } from "@/lib/shipping/customer-link-email";
import { getShippingPolicyEnforcementMode } from "@/lib/shipping/policy";

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
  if (getShippingPolicyEnforcementMode() !== "enforce")
    return NextResponse.json(
      { error: "Customer links are disabled outside enforce mode" },
      { status: 409 },
    );
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const kind =
    typeof body?.kind === "string" ? body.kind.trim().slice(0, 80) : "";
  const allowedOutcomes = Array.isArray(body?.allowedOutcomes)
    ? body.allowedOutcomes.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const expiresAt =
    typeof body?.expiresAt === "string"
      ? new Date(body.expiresAt)
      : new Date(NaN);
  if (!kind || !Number.isFinite(expiresAt.getTime()))
    return NextResponse.json(
      { error: "Decision request is invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  const issued = await issueCustomerDecision({
    orderReference: orderId,
    caseId: typeof body?.caseId === "string" ? body.caseId : undefined,
    kind,
    scopeKey:
      typeof body?.scopeKey === "string" && body.scopeKey.trim()
        ? body.scopeKey.trim()
        : `${kind}/${typeof body?.caseId === "string" ? body.caseId : orderId}/${expiresAt.toISOString()}`,
    proposedConditions:
      body?.proposedConditions && typeof body.proposedConditions === "object"
        ? (body.proposedConditions as Record<string, unknown>)
        : undefined,
    allowedOutcomes,
    expiresAt,
  });
  const link = new URL("/orders/shipping-decision", req.nextUrl.origin);
  link.searchParams.set("token", issued.token);
  await sendShippingCustomerLinkEmail({
    to: issued.email,
    orderReference: orderId,
    link: link.toString(),
    purpose: "decision",
    idempotencyKey: `shipping-decision/${issued.id}`,
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("fulfillment:manage");
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

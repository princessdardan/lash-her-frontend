import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  issueAddressChange,
  revokeAddressChanges,
} from "@/lib/shipping/address-changes";
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
  const { orderId } = await params;
  const issued = await issueAddressChange({ orderReference: orderId });
  const link = new URL("/orders/address-change", req.nextUrl.origin);
  link.searchParams.set("token", issued.token);
  await sendShippingCustomerLinkEmail({
    to: issued.email,
    orderReference: orderId,
    link: link.toString(),
    purpose: "address-change",
    idempotencyKey: `address-change/${issued.id}`,
  });
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
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const { orderId } = await params;
  const revoked = await revokeAddressChanges(orderId);
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

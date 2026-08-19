import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders } from "@/lib/private-db/schema";
import { openProductShippingCaseAsOperator } from "@/lib/shipping/cases";
import { assertShippingPolicyMutationAllowed } from "@/lib/shipping/policy";

const TYPES = new Set([
  "postage_failure",
  "delay",
  "loss",
  "damage",
  "refused",
  "unclaimed",
  "return_to_sender",
  "claim",
]);

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
  try {
    assertShippingPolicyMutationAllowed();
  } catch {
    return NextResponse.json(
      { error: "Shipping policy mutations require enforce mode" },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body || typeof body.type !== "string" || !TYPES.has(body.type))
    return NextResponse.json(
      { error: "Case type is invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  const [order] = await getPrivateDb()
    .select({ id: checkoutOrders.id })
    .from(checkoutOrders)
    .where(eq(checkoutOrders.orderId, orderId))
    .limit(1);
  if (!order)
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  const created = await openProductShippingCaseAsOperator({
    orderId: order.id,
    shipmentId:
      typeof body.shipmentId === "string" ? body.shipmentId : undefined,
    type: body.type as Parameters<
      typeof openProductShippingCaseAsOperator
    >[0]["type"],
    cause: typeof body.cause === "string" ? body.cause : undefined,
    actorAdminUserId: actor.user.id,
  });
  await recordAdminAuditBestEffort({
    action: "fulfillment.shipping_case_opened",
    actor,
    domain: "fulfillment",
    outcome: "success",
    targetId: created.id,
    targetType: "product_shipping_case",
    metadata: { orderId, type: created.type },
  });
  return NextResponse.json({ id: created.id }, { status: 201 });
}

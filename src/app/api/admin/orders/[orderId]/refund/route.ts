import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import { queueProductOrderRefundAllocations } from "@/lib/shipping/customer-refunds";
import { isSquareCommerceCheckoutEnabled } from "@/lib/env/private-checkout";
import { assertConfiguredFulfillmentOwner } from "@/lib/shipping/configured-owner";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("payments:refund");
  await assertConfiguredFulfillmentOwner(actor.user.id);
  if (!isSquareCommerceCheckoutEnabled())
    return NextResponse.json(
      { error: "Square commerce refunds are not enabled" },
      { status: 503 },
    );
  if (req.headers.get("origin") !== req.nextUrl.origin)
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const body = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const amountCents =
    body?.amountCents === undefined ? undefined : Number(body.amountCents);
  const paymentTransactionId =
    typeof body?.paymentTransactionId === "string"
      ? body.paymentTransactionId.trim()
      : undefined;
  const component = ["merchandise", "tax", "outbound_shipping"].includes(
    String(body?.component),
  )
    ? (body?.component as "merchandise" | "tax" | "outbound_shipping")
    : undefined;
  if (
    !reason ||
    (amountCents !== undefined && !Number.isInteger(amountCents)) ||
    (paymentTransactionId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        paymentTransactionId,
      ))
  )
    return NextResponse.json(
      { error: "Refund reason and amount are invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  try {
    const queued = await queueProductOrderRefundAllocations({
      orderReference: orderId,
      paymentTransactionId,
      amountCents,
      component,
      reason,
      requestedByAdminUserId: actor.user.id,
    });
    const result = queued[0];
    if (!result) throw new Error("No refundable payment transaction was found");
    // Durable reservation only: the queued Square refund(s) are executed by the
    // shipping worker cron (runs every minute), not inline in this request.
    await recordAdminAuditBestEffort({
      action: "payments.product_refund",
      actor,
      domain: "payments",
      outcome: "success",
      targetId: result.id,
      targetType: "product_order_refund",
      metadata: {
        orderId,
        amountCents: result.amountCents,
        status: "queued",
        refundCount: queued.length,
      },
    });
    return NextResponse.json(
      {
        id: result.id,
        operationId: result.id,
        status: "queued",
        refunds: queued.map((refund) => ({
          id: refund.id,
          paymentTransactionId: refund.paymentTransactionId,
          amountCents: refund.amountCents,
          status: refund.status,
        })),
      },
      { status: 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refund failed" },
      { status: 409 },
    );
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  processProductOrderRefund,
  queueProductOrderRefund,
} from "@/lib/shipping/customer-refunds";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const actor = await requirePermission("payments:refund");
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
  if (!reason || (amountCents !== undefined && !Number.isInteger(amountCents)))
    return NextResponse.json(
      { error: "Refund reason and amount are invalid" },
      { status: 400 },
    );
  const { orderId } = await params;
  try {
    const queued = await queueProductOrderRefund({
      orderReference: orderId,
      amountCents,
      reason,
      requestedByAdminUserId: actor.user.id,
    });
    const result = await processProductOrderRefund(queued.id);
    await recordAdminAuditBestEffort({
      action: "payments.product_refund",
      actor,
      domain: "payments",
      outcome: result.status === "succeeded" ? "success" : "failure",
      targetId: result.id,
      targetType: "product_order_refund",
      metadata: {
        orderId,
        amountCents: result.amountCents,
        status: result.status,
      },
    });
    return NextResponse.json(
      { id: result.id, status: result.status },
      { status: result.status === "succeeded" ? 200 : 202 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refund failed" },
      { status: 409 },
    );
  }
}

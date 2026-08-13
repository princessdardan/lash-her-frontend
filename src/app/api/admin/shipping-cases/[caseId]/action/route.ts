import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/admin/auth";
import { recordAdminAuditBestEffort } from "@/lib/admin/audit-log";
import {
  createShipmentGeneration,
  updateProductShippingCase,
} from "@/lib/shipping/cases";
import { eq } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders, productShippingCases } from "@/lib/private-db/schema";
import {
  processProductOrderRefund,
  queueProductOrderRefund,
} from "@/lib/shipping/customer-refunds";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ caseId: string }> },
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
  const { caseId } = await params;
  try {
    let result: { id: string };
    if (body?.action === "replacement" || body?.action === "reshipment") {
      if (body.action === "replacement" && body.inventoryConfirmed !== true) {
        const [caseOrder] = await getPrivateDb()
          .select({ orderReference: checkoutOrders.orderId })
          .from(productShippingCases)
          .innerJoin(
            checkoutOrders,
            eq(productShippingCases.orderId, checkoutOrders.id),
          )
          .where(eq(productShippingCases.id, caseId))
          .limit(1);
        if (!caseOrder) throw new Error("Shipping case was not found");
        const refund = await queueProductOrderRefund({
          orderReference: caseOrder.orderReference,
          reason: "Customer selected replacement but inventory was unavailable",
          caseId,
          automated: true,
        });
        await processProductOrderRefund(refund.id);
        result = await updateProductShippingCase({
          caseId,
          action: "resolve",
          remedyChoice: "refund_inventory_unavailable",
        });
      } else {
        result = await createShipmentGeneration({
          caseId,
          purpose: body.action,
          inventoryConfirmed: body.inventoryConfirmed === true,
        });
      }
    } else if (
      ["acknowledge", "claim", "inspect", "resolve"].includes(
        String(body?.action),
      )
    ) {
      result = await updateProductShippingCase({
        caseId,
        action: body!.action as "acknowledge" | "claim" | "inspect" | "resolve",
        cause: typeof body?.cause === "string" ? body.cause : undefined,
        providerClaimReference:
          typeof body?.providerClaimReference === "string"
            ? body.providerClaimReference
            : undefined,
        evidenceChecklist:
          body?.evidenceChecklist && typeof body.evidenceChecklist === "object"
            ? (body.evidenceChecklist as Record<string, boolean>)
            : undefined,
        remedyChoice:
          typeof body?.remedyChoice === "string"
            ? body.remedyChoice
            : undefined,
      });
    } else {
      return NextResponse.json(
        { error: "Case action is invalid" },
        { status: 400 },
      );
    }
    await recordAdminAuditBestEffort({
      action: `fulfillment.shipping_case_${String(body?.action)}`,
      actor,
      domain: "fulfillment",
      outcome: "success",
      targetId: caseId,
      targetType: "product_shipping_case",
      metadata: { resultId: result.id },
    });
    return NextResponse.json({ id: result.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Case action failed" },
      { status: 409 },
    );
  }
}

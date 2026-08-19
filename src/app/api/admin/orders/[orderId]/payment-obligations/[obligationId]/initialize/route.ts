import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/admin/auth";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  productOrderAddressChangeRequests,
} from "@/lib/private-db/schema";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ orderId: string; obligationId: string }> },
): Promise<Response> {
  await requirePermission("fulfillment:manage");
  return readOperation(context.params);
}

export async function POST(): Promise<Response> {
  await requirePermission("fulfillment:manage");
  return NextResponse.json(
    {
      error:
        "Payment operation polling is read-only; use the reconciliation endpoint for owner actions",
    },
    { status: 405 },
  );
}

async function readOperation(
  params: Promise<{ orderId: string; obligationId: string }>,
): Promise<Response> {
  const { orderId, obligationId } = await params;
  const [row] = await getPrivateDb()
    .select({ obligation: orderPaymentObligations, order: checkoutOrders })
    .from(orderPaymentObligations)
    .innerJoin(
      checkoutOrders,
      eq(orderPaymentObligations.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(checkoutOrders.orderId, orderId),
        eq(checkoutOrders.purpose, "product"),
        eq(orderPaymentObligations.id, obligationId),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
        isNull(orderPaymentObligations.quarantinedAt),
      ),
    )
    .limit(1);
  if (!row) {
    return NextResponse.json(
      { error: "Payment operation was not found" },
      { status: 404 },
    );
  }
  const operation = row.obligation;
  const payable = await isOperationPayable(row, new Date());
  if (
    operation.initializationStatus === "ready" &&
    operation.providerCheckoutId &&
    payable
  ) {
    return NextResponse.json({
      operationId: operation.id,
      status: "ready",
      checkoutToken: operation.providerCheckoutId,
    });
  }
  if (operation.initializationStatus === "ready" && !payable) {
    return NextResponse.json(
      {
        operationId: operation.id,
        status: "unavailable",
        error: "This payment offer is no longer available",
      },
      { status: 409 },
    );
  }
  if (operation.initializationStatus === "failed") {
    return NextResponse.json(
      {
        operationId: operation.id,
        status: operation.initializationOutcome ?? "failed",
        error:
          operation.initializationOutcome === "outcome_unknown"
            ? "Provider outcome requires manual reconciliation"
            : "Payment session initialization failed",
      },
      { status: 409 },
    );
  }
  return NextResponse.json(
    {
      operationId: operation.id,
      status:
        operation.initializationOutcome === "claimed" ? "processing" : "queued",
    },
    { status: 202 },
  );
}

async function isOperationPayable(
  row: {
    obligation: typeof orderPaymentObligations.$inferSelect;
    order: typeof checkoutOrders.$inferSelect;
  },
  now: Date,
): Promise<boolean> {
  const { obligation, order } = row;
  if (
    obligation.status !== "pending" ||
    (obligation.expiresAt !== null && obligation.expiresAt <= now)
  ) {
    return false;
  }
  if (obligation.purpose === "primary") return order.status === "pending";
  if (order.status !== "paid") return false;
  if (obligation.purpose === "manual_shipping") {
    return (
      order.fulfillmentMode === "manual_pickup" &&
      order.manualFulfillmentStatus === "paid_pending_dispatch"
    );
  }
  if (!obligation.sourceReferenceId) return false;
  const [request] = await getPrivateDb()
    .select({ id: productOrderAddressChangeRequests.id })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, obligation.sourceReferenceId),
        eq(productOrderAddressChangeRequests.orderId, order.id),
        eq(
          productOrderAddressChangeRequests.supplementalObligationId,
          obligation.id,
        ),
        eq(productOrderAddressChangeRequests.status, "approved"),
        eq(
          productOrderAddressChangeRequests.reconciliationState,
          "awaiting_supplemental_payment",
        ),
      ),
    )
    .limit(1);
  return Boolean(request);
}

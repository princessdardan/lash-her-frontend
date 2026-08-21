import { and, eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  productOrderAddressChangeRequests,
} from "@/lib/private-db/schema";
import {
  isSupplementalPaymentOfferSessionAuthorized,
  SUPPLEMENTAL_PAYMENT_OFFER_COOKIE,
} from "@/lib/commerce/supplemental-payment-offers";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const { operationId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      operationId,
    )
  ) {
    return NextResponse.json(
      { error: "Payment operation was not found" },
      { status: 404 },
    );
  }
  const [row] = await getPrivateDb()
    .select({ obligation: orderPaymentObligations, order: checkoutOrders })
    .from(orderPaymentObligations)
    .innerJoin(
      checkoutOrders,
      eq(orderPaymentObligations.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(orderPaymentObligations.id, operationId),
        eq(checkoutOrders.purpose, "product"),
        isNull(orderPaymentObligations.quarantinedAt),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
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
  if (
    operation.purpose !== "primary" &&
    !(await isSupplementalPaymentOfferSessionAuthorized(
      req.cookies.get(SUPPLEMENTAL_PAYMENT_OFFER_COOKIE)?.value ?? "",
      operation.id,
    ))
  ) {
    return NextResponse.json(
      { error: "Payment operation was not found" },
      { status: 404 },
    );
  }
  const headers = { "cache-control": "no-store, max-age=0" };
  const payable = await isOperationPayable(row, new Date());
  const paymentUrl = getSquarePaymentLinkUrl(operation.disclosureSnapshot);
  if (
    operation.initializationStatus === "ready" &&
    paymentUrl !== null &&
    payable
  ) {
    return NextResponse.json(
      {
        operationId: operation.id,
        status: "ready",
        paymentUrl,
      },
      { headers },
    );
  }
  if (operation.initializationStatus === "ready" && !payable) {
    return NextResponse.json(
      {
        operationId: operation.id,
        status: "unavailable",
        error: "This payment offer is no longer available.",
      },
      { status: 409, headers },
    );
  }
  if (operation.initializationStatus === "failed") {
    return NextResponse.json(
      {
        operationId: operation.id,
        status: operation.initializationOutcome ?? "failed",
        error:
          operation.initializationOutcome === "outcome_unknown"
            ? "Payment setup requires reconciliation. No duplicate session was created."
            : "Payment setup could not be completed.",
      },
      { status: 409, headers },
    );
  }
  return NextResponse.json(
    {
      operationId: operation.id,
      status:
        operation.initializationOutcome === "claimed" ? "processing" : "queued",
    },
    { status: 202, headers },
  );
}

function getSquarePaymentLinkUrl(disclosureSnapshot: unknown): string | null {
  if (
    typeof disclosureSnapshot !== "object" ||
    disclosureSnapshot === null ||
    Array.isArray(disclosureSnapshot)
  ) {
    return null;
  }
  const url = (disclosureSnapshot as Record<string, unknown>)
    .squarePaymentLinkUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
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

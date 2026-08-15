import { type NextRequest } from "next/server";

import { handleOperationReview } from "../../handler";
import type { FulfillmentOperationReviewKind } from "@/lib/shipping/operations-actions";

const KINDS = new Set<FulfillmentOperationReviewKind>([
  "provider_job",
  "shipment_generation",
  "customer_decision",
  "refund",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> },
): Promise<Response> {
  const { id, kind } = await params;
  if (!KINDS.has(kind as FulfillmentOperationReviewKind)) {
    return Response.json(
      { error: "Operation kind is invalid" },
      { status: 400 },
    );
  }
  return handleOperationReview(request, {
    entityId: id,
    kind: kind as FulfillmentOperationReviewKind,
  });
}

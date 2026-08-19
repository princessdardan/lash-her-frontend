import { type NextRequest } from "next/server";

import { handleOperationReview } from "../../../operation-reviews/handler";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ observationId: string }> },
): Promise<Response> {
  const { observationId } = await params;
  return handleOperationReview(request, {
    entityId: observationId,
    kind: "return_observation",
  });
}

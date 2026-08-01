import "server-only";

import { getPrivateDb } from "./client";
import { squarePaymentRefundEvents } from "./schema";

export interface SquareRefundEventRecordInput {
  amountCents: number;
  currency: string;
  occurredAt: Date;
  payloadSanitized: Record<string, unknown>;
  providerEventId: string;
  squarePaymentId: string;
  squareRefundId: string;
  status: string;
}

export async function recordSquareRefundEvent(
  input: SquareRefundEventRecordInput,
): Promise<{ duplicate: boolean }> {
  const [inserted] = await getPrivateDb()
    .insert(squarePaymentRefundEvents)
    .values(input)
    .onConflictDoNothing({
      target: squarePaymentRefundEvents.providerEventId,
    })
    .returning({ id: squarePaymentRefundEvents.id });

  return { duplicate: inserted === undefined };
}

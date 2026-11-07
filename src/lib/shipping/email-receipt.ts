import "server-only";
import { eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { getPrivateDb } from "@/lib/private-db/client";
import { customerEmailOutbox } from "@/lib/private-db/schema";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { decryptCustomerEmailOutboxValue } from "@/lib/commerce/customer-email-outbox-cipher";
import {
  enqueueCustomerEmailWithResult,
  type EnqueueCustomerEmailInput,
} from "@/lib/commerce/customer-email-outbox";

// A conflict or suppressed insert is not proof of a durable handoff. Inspect the
// encrypted receipt without changing legacy enqueue counts or off-mode results.
export async function enqueueShippingEmail<T extends object>(
  input: EnqueueCustomerEmailInput<T>,
  executor: Pick<
    ReturnType<typeof getPrivateDb>,
    "insert" | "select"
  > = getPrivateDb(),
): Promise<void> {
  const inserted = await enqueueCustomerEmailWithResult(input, executor);
  try {
    const [row] = await executor
      .select()
      .from(customerEmailOutbox)
      .where(
        eq(
          customerEmailOutbox.providerIdempotencyKey,
          input.providerIdempotencyKey.trim(),
        ),
      )
      .limit(1);
    if (
      !row ||
      (inserted.id !== null && row.id !== inserted.id) ||
      row.kind !== input.kind ||
      row.orderId !== (input.orderDatabaseId ?? null) ||
      row.deliveryProvider !== "resend" ||
      !["queued", "sending", "failed", "sent"].includes(row.status) ||
      (row.status === "sent" && !row.providerMessageId?.trim()) ||
      decryptCustomerEmailOutboxValue(row.recipientCiphertext, "recipient") !==
        input.recipient.trim().toLowerCase() ||
      !isDeepStrictEqual(
        decryptCustomerEmailOutboxValue(row.templateDataCiphertext, "payload"),
        input.payload,
      )
    ) {
      markWriterOperationUncertain();
    }
  } catch {
    markWriterOperationUncertain();
  }
}

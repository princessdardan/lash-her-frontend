import "server-only";

import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import { checkoutOrders, customerEmailOutbox } from "@/lib/private-db/schema";

import {
  decryptCustomerEmailOutboxValue,
  encryptCustomerEmailOutboxValue,
} from "./customer-email-outbox-cipher";

export type CustomerEmailOutboxKind =
  | "product_order_confirmation"
  | "shipping_customer_link"
  | "shipping_customer_update"
  | "shipping_policy_alert"
  | "shipping_shipment_notification";

export type CustomerOrderEmailOutboxKind = Exclude<
  CustomerEmailOutboxKind,
  "shipping_policy_alert"
>;

export const CUSTOMER_EMAIL_MAX_DELIVERY_ATTEMPTS = 8;

interface EnqueueCustomerEmailBase<TPayload extends object> {
  payload: TPayload;
  providerIdempotencyKey: string;
  recipient: string;
  now?: Date;
}

export type EnqueueCustomerEmailInput<TPayload extends object> =
  EnqueueCustomerEmailBase<TPayload> &
    (
      | {
          kind: "shipping_policy_alert";
          orderDatabaseId?: never;
        }
      | {
          kind: CustomerOrderEmailOutboxKind;
          orderDatabaseId: string;
        }
    );

export type CustomerEmailOutboxTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

type CustomerEmailOutboxExecutor = Pick<
  ReturnType<typeof getPrivateDb>,
  "insert" | "select"
>;

export async function enqueueCustomerEmail<TPayload extends object>(
  input: EnqueueCustomerEmailInput<TPayload>,
  executor: CustomerEmailOutboxExecutor = getPrivateDb(),
): Promise<boolean> {
  const recipient = input.recipient.trim().toLowerCase();
  const idempotencyKey = input.providerIdempotencyKey.trim();
  if (!recipient || !idempotencyKey) {
    throw new Error("Email outbox recipient and idempotency key are required");
  }
  const now = input.now ?? new Date();
  const redactionDueAt = await resolveCustomerEmailRedactionDeadline(
    executor,
    input,
    now,
  );
  const [inserted] = await executor
    .insert(customerEmailOutbox)
    .values({
      ...(input.kind === "shipping_policy_alert"
        ? {}
        : { orderId: input.orderDatabaseId }),
      kind: input.kind,
      recipientCiphertext: encryptCustomerEmailOutboxValue(
        recipient,
        "recipient",
      ),
      templateDataCiphertext: encryptCustomerEmailOutboxValue(
        input.payload,
        "payload",
      ),
      providerIdempotencyKey: idempotencyKey,
      status: "queued",
      availableAt: now,
      redactionDueAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: customerEmailOutbox.providerIdempotencyKey,
    })
    .returning({ id: customerEmailOutbox.id });
  return inserted !== undefined;
}

async function resolveCustomerEmailRedactionDeadline<TPayload extends object>(
  executor: Pick<CustomerEmailOutboxExecutor, "select">,
  input: EnqueueCustomerEmailInput<TPayload>,
  now: Date,
): Promise<Date> {
  const rowDeadline = new Date(now.getTime() + 365 * 24 * 60 * 60_000);
  if (input.kind === "shipping_policy_alert") return rowDeadline;
  const [order] = await executor
    .select({ piiRedactionDueAt: checkoutOrders.piiRedactionDueAt })
    .from(checkoutOrders)
    .where(
      and(
        eq(checkoutOrders.id, input.orderDatabaseId),
        eq(checkoutOrders.purpose, "product"),
        isNull(checkoutOrders.redactedAt),
        gt(checkoutOrders.piiRedactionDueAt, now),
      ),
    )
    .limit(1);
  if (!order) {
    throw new Error(
      "Customer-order email requires an active linked product order before its privacy deadline",
    );
  }
  return order.piiRedactionDueAt < rowDeadline
    ? order.piiRedactionDueAt
    : rowDeadline;
}

export interface ClaimedCustomerEmail {
  decodeError?: string;
  id: string;
  kind: CustomerEmailOutboxKind;
  payload: unknown;
  providerIdempotencyKey: string;
  recipient: string;
}

export async function claimCustomerEmails(input: {
  leaseOwner: string;
  limit?: number;
  leaseForMs?: number;
  now?: Date;
}): Promise<ClaimedCustomerEmail[]> {
  const now = input.now ?? new Date();
  const leaseOwner = input.leaseOwner.trim();
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  if (!leaseOwner) throw new Error("Email outbox lease owner is required");
  const leaseExpiresAt = new Date(
    now.getTime() + (input.leaseForMs ?? 5 * 60_000),
  );

  const rows = await getPrivateDb().transaction(async (tx) => {
    const claimed = await tx
      .select()
      .from(customerEmailOutbox)
      .where(
        and(
          lte(customerEmailOutbox.availableAt, now),
          gt(customerEmailOutbox.redactionDueAt, now),
          isNull(customerEmailOutbox.redactedAt),
          or(
            inArray(customerEmailOutbox.status, ["queued", "failed"]),
            and(
              eq(customerEmailOutbox.status, "sending"),
              lt(customerEmailOutbox.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(customerEmailOutbox.availableAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (claimed.length === 0) return [];
    await tx
      .update(customerEmailOutbox)
      .set({
        status: "sending",
        leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        inArray(
          customerEmailOutbox.id,
          claimed.map((row) => row.id),
        ),
      );
    return claimed;
  });

  return rows.map((row) => {
    try {
      return {
        id: row.id,
        kind: parseKind(row.kind),
        payload: decryptCustomerEmailOutboxValue(
          row.templateDataCiphertext,
          "payload",
        ),
        providerIdempotencyKey: row.providerIdempotencyKey,
        recipient: parseRecipient(
          decryptCustomerEmailOutboxValue(row.recipientCiphertext, "recipient"),
        ),
      };
    } catch (error) {
      return {
        id: row.id,
        kind: "product_order_confirmation" as const,
        payload: null,
        providerIdempotencyKey: row.providerIdempotencyKey,
        recipient: "",
        decodeError:
          error instanceof Error
            ? error.message
            : "Customer email outbox decryption failed",
      };
    }
  });
}

export async function completeCustomerEmail(input: {
  id: string;
  leaseOwner: string;
  providerMessageId: string;
  now?: Date;
  onCompleted?: (transaction: CustomerEmailOutboxTransaction) => Promise<void>;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(customerEmailOutbox)
      .set({
        status: "sent",
        providerMessageId: input.providerMessageId,
        sentAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(customerEmailOutbox.id, input.id),
          eq(customerEmailOutbox.status, "sending"),
          eq(customerEmailOutbox.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ id: customerEmailOutbox.id });
    if (!updated) return false;
    if (input.onCompleted) await input.onCompleted(tx);
    return true;
  });
}

export async function failCustomerEmail(input: {
  id: string;
  leaseOwner: string;
  error: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await getPrivateDb()
    .select({ attemptCount: customerEmailOutbox.attemptCount })
    .from(customerEmailOutbox)
    .where(
      and(
        eq(customerEmailOutbox.id, input.id),
        eq(customerEmailOutbox.status, "sending"),
        eq(customerEmailOutbox.leaseOwner, input.leaseOwner),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return false;
  const attemptCount = row.attemptCount + 1;
  const deadLetter = attemptCount >= CUSTOMER_EMAIL_MAX_DELIVERY_ATTEMPTS;
  const retryDelayMs = Math.min(
    2 ** Math.min(attemptCount, 10) * 30_000,
    86_400_000,
  );
  const [updated] = await getPrivateDb()
    .update(customerEmailOutbox)
    .set({
      status: deadLetter ? "dead_letter" : "failed",
      attemptCount,
      availableAt: deadLetter ? now : new Date(now.getTime() + retryDelayMs),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: sanitizeError(input.error),
      updatedAt: now,
    })
    .where(
      and(
        eq(customerEmailOutbox.id, input.id),
        eq(customerEmailOutbox.status, "sending"),
        eq(customerEmailOutbox.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: customerEmailOutbox.id });
  return updated !== undefined;
}

export async function requeueDeadLetterCustomerEmail(input: {
  id: string;
  expectedUpdatedAt: Date;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const [updated] = await getPrivateDb()
    .update(customerEmailOutbox)
    .set({
      status: "queued",
      availableAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(customerEmailOutbox.id, input.id),
        eq(customerEmailOutbox.status, "dead_letter"),
        eq(customerEmailOutbox.updatedAt, input.expectedUpdatedAt),
        isNull(customerEmailOutbox.redactedAt),
      ),
    )
    .returning({ id: customerEmailOutbox.id });
  return updated !== undefined;
}

function parseKind(value: string): CustomerEmailOutboxKind {
  if (
    value !== "product_order_confirmation" &&
    value !== "shipping_customer_link" &&
    value !== "shipping_customer_update" &&
    value !== "shipping_policy_alert" &&
    value !== "shipping_shipment_notification"
  ) {
    throw new Error("Unsupported customer email outbox kind");
  }
  return value;
}

function parseRecipient(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Malformed customer email outbox recipient");
  }
  return value;
}

function sanitizeError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "Unknown email delivery failure";
}

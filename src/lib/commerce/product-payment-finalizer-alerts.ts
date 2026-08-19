import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  fulfillmentRiskAlertOutbox,
  productPaymentRiskIncidents,
  type ShippingPolicyDuty,
} from "@/lib/private-db/schema";

const DEFAULT_LEASE_MS = 5 * 60_000;

export interface ProductPaymentRiskAlertDelivery {
  id: string;
  incidentId: string;
  incidentKey: string;
  recipientDuty: ShippingPolicyDuty;
  idempotencyKey: string;
  leaseOwner: string;
  attemptCount: number;
  payload: Record<string, unknown>;
}

export async function claimProductPaymentRiskAlertDeliveries(
  input: {
    limit?: number;
    now?: Date;
    leaseMs?: number;
  } = {},
): Promise<ProductPaymentRiskAlertDelivery[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const leaseMs = Math.max(30_000, input.leaseMs ?? DEFAULT_LEASE_MS);
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

  return getPrivateDb().transaction(async (tx) => {
    const candidates = await tx
      .select({ id: fulfillmentRiskAlertOutbox.id })
      .from(fulfillmentRiskAlertOutbox)
      .where(
        and(
          isNull(fulfillmentRiskAlertOutbox.redactedAt),
          or(
            and(
              eq(fulfillmentRiskAlertOutbox.status, "queued"),
              lte(fulfillmentRiskAlertOutbox.availableAt, now),
            ),
            and(
              eq(fulfillmentRiskAlertOutbox.status, "sending"),
              lte(fulfillmentRiskAlertOutbox.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(fulfillmentRiskAlertOutbox.availableAt)
      .for("update", { skipLocked: true })
      .limit(limit);
    if (!candidates.length) return [];

    return tx
      .update(fulfillmentRiskAlertOutbox)
      .set({
        status: "sending",
        leaseOwner,
        leaseExpiresAt,
        attemptCount: sql`${fulfillmentRiskAlertOutbox.attemptCount} + 1`,
        lastError: null,
        updatedAt: now,
      })
      .where(
        inArray(
          fulfillmentRiskAlertOutbox.id,
          candidates.map(({ id }) => id),
        ),
      )
      .returning({
        id: fulfillmentRiskAlertOutbox.id,
        incidentId: fulfillmentRiskAlertOutbox.incidentId,
        incidentKey: fulfillmentRiskAlertOutbox.incidentKey,
        recipientDuty: fulfillmentRiskAlertOutbox.recipientDuty,
        idempotencyKey: fulfillmentRiskAlertOutbox.idempotencyKey,
        leaseOwner: fulfillmentRiskAlertOutbox.leaseOwner,
        attemptCount: fulfillmentRiskAlertOutbox.attemptCount,
        payload: fulfillmentRiskAlertOutbox.payload,
      })
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          leaseOwner: row.leaseOwner!,
        })),
      );
  });
}

export async function completeProductPaymentRiskAlertDelivery(input: {
  id: string;
  incidentId: string;
  leaseOwner: string;
  sentAt?: Date;
}): Promise<boolean> {
  const sentAt = input.sentAt ?? new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [sent] = await tx
      .update(fulfillmentRiskAlertOutbox)
      .set({
        status: "sent",
        sentAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: sentAt,
      })
      .where(
        and(
          eq(fulfillmentRiskAlertOutbox.id, input.id),
          eq(fulfillmentRiskAlertOutbox.incidentId, input.incidentId),
          eq(fulfillmentRiskAlertOutbox.status, "sending"),
          eq(fulfillmentRiskAlertOutbox.leaseOwner, input.leaseOwner),
        ),
      )
      .returning({ incidentId: fulfillmentRiskAlertOutbox.incidentId });
    if (!sent) return false;
    await tx
      .update(productPaymentRiskIncidents)
      .set({ alertedAt: sentAt, updatedAt: sentAt })
      .where(eq(productPaymentRiskIncidents.id, sent.incidentId));
    return true;
  });
}

export async function retryProductPaymentRiskAlertDelivery(input: {
  id: string;
  leaseOwner: string;
  error: string;
  availableAt: Date;
  deadLetter?: boolean;
}): Promise<boolean> {
  const [released] = await getPrivateDb()
    .update(fulfillmentRiskAlertOutbox)
    .set({
      status: input.deadLetter ? "dead_letter" : "queued",
      availableAt: input.availableAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: input.error.trim().slice(0, 1_000),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(fulfillmentRiskAlertOutbox.id, input.id),
        eq(fulfillmentRiskAlertOutbox.status, "sending"),
        eq(fulfillmentRiskAlertOutbox.leaseOwner, input.leaseOwner),
      ),
    )
    .returning({ id: fulfillmentRiskAlertOutbox.id });
  return Boolean(released);
}

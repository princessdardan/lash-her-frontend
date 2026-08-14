import "server-only";

import { and, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productOrderCustomerDecisions,
} from "@/lib/private-db/schema";
import {
  hashShippingCustomerToken,
  issueShippingCustomerToken,
} from "./customer-token";

export interface IssuedCustomerDecision {
  id: string;
  email: string;
  token: string;
}

export async function issueCustomerDecision(input: {
  orderReference: string;
  caseId?: string;
  shipmentId?: string;
  kind: string;
  scopeKey: string;
  proposedConditions?: Record<string, unknown>;
  allowedOutcomes: string[];
  expiresAt: Date;
}): Promise<IssuedCustomerDecision> {
  const allowed = [...new Set(input.allowedOutcomes)].filter((value) =>
    [
      "refund",
      "replacement",
      "wait",
      "accept_substitute",
      "accept_signature",
    ].includes(value),
  );
  if (!allowed.length || input.expiresAt <= new Date())
    throw new Error("Customer decision policy is invalid");
  const token = issueShippingCustomerToken();
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({ id: checkoutOrders.id, email: checkoutOrders.customerEmail })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.orderId, input.orderReference))
      .limit(1);
    if (!order) throw new Error("Order was not found");
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, order.id),
          gte(
            productOrderCustomerDecisions.createdAt,
            new Date(now.getTime() - 24 * 60 * 60_000),
          ),
        ),
      );
    if (Number(recent?.count ?? 0) >= 3) {
      throw new Error("Customer-decision link issuance limit reached");
    }
    await tx
      .update(productOrderCustomerDecisions)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(productOrderCustomerDecisions.orderId, order.id),
          eq(productOrderCustomerDecisions.scopeKey, input.scopeKey),
          eq(productOrderCustomerDecisions.status, "pending"),
        ),
      );
    const [created] = await tx
      .insert(productOrderCustomerDecisions)
      .values({
        orderId: order.id,
        caseId: input.caseId,
        shipmentId: input.shipmentId,
        kind: input.kind,
        scopeKey: input.scopeKey,
        proposedConditions: input.proposedConditions,
        allowedOutcomes: allowed,
        tokenHash: hashShippingCustomerToken(token, "decision"),
        expiresAt: input.expiresAt,
      })
      .returning({ id: productOrderCustomerDecisions.id });
    return { id: created!.id, email: order.email, token };
  });
}

export async function validateCustomerDecisionBearer(
  bearerToken: string,
): Promise<boolean> {
  const [row] = await getPrivateDb()
    .select({ id: productOrderCustomerDecisions.id })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(
          productOrderCustomerDecisions.tokenHash,
          hashShippingCustomerToken(bearerToken, "decision"),
        ),
        eq(productOrderCustomerDecisions.status, "pending"),
        gt(productOrderCustomerDecisions.expiresAt, new Date()),
        isNull(productOrderCustomerDecisions.exchangedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function exchangeCustomerDecisionToken(
  bearerToken: string,
): Promise<string | null> {
  const sessionToken = issueShippingCustomerToken();
  const now = new Date();
  const [updated] = await getPrivateDb()
    .update(productOrderCustomerDecisions)
    .set({
      tokenHash: hashShippingCustomerToken(sessionToken, "decision"),
      exchangedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          productOrderCustomerDecisions.tokenHash,
          hashShippingCustomerToken(bearerToken, "decision"),
        ),
        eq(productOrderCustomerDecisions.status, "pending"),
        gt(productOrderCustomerDecisions.expiresAt, now),
        isNull(productOrderCustomerDecisions.exchangedAt),
      ),
    )
    .returning({ id: productOrderCustomerDecisions.id });
  return updated ? sessionToken : null;
}

export async function revokeCustomerDecisions(input: {
  orderReference: string;
  kind?: string;
}): Promise<number> {
  const conditions = [
    sql`${productOrderCustomerDecisions.orderId} = (select ${checkoutOrders.id} from ${checkoutOrders} where ${checkoutOrders.orderId} = ${input.orderReference})`,
    eq(productOrderCustomerDecisions.status, "pending"),
  ];
  if (input.kind)
    conditions.push(eq(productOrderCustomerDecisions.kind, input.kind));
  const revoked = await getPrivateDb()
    .update(productOrderCustomerDecisions)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: productOrderCustomerDecisions.id });
  return revoked.length;
}

export async function getCustomerDecision(sessionToken: string) {
  const now = new Date();
  const [row] = await getPrivateDb()
    .select({
      id: productOrderCustomerDecisions.id,
      kind: productOrderCustomerDecisions.kind,
      allowedOutcomes: productOrderCustomerDecisions.allowedOutcomes,
      expiresAt: productOrderCustomerDecisions.expiresAt,
    })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(
          productOrderCustomerDecisions.tokenHash,
          hashShippingCustomerToken(sessionToken, "decision"),
        ),
        eq(productOrderCustomerDecisions.status, "pending"),
        gt(productOrderCustomerDecisions.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function selectCustomerDecision(
  sessionToken: string,
  outcome: string,
): Promise<boolean> {
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(
            productOrderCustomerDecisions.tokenHash,
            hashShippingCustomerToken(sessionToken, "decision"),
          ),
          eq(productOrderCustomerDecisions.status, "pending"),
          gt(productOrderCustomerDecisions.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (!row || !row.allowedOutcomes.includes(outcome)) return false;
    const [updated] = await tx
      .update(productOrderCustomerDecisions)
      .set({
        status: "selected",
        selectedOutcome: outcome,
        selectedAt: now,
        tokenHash: hashShippingCustomerToken(
          issueShippingCustomerToken(),
          "decision",
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderCustomerDecisions.id, row.id),
          eq(productOrderCustomerDecisions.status, "pending"),
        ),
      )
      .returning({ id: productOrderCustomerDecisions.id });
    return Boolean(updated);
  });
}

export async function hasSignedCustomerDecision(input: {
  orderId: string;
  outcomes: string[];
}): Promise<boolean> {
  const [row] = await getPrivateDb()
    .select({ id: productOrderCustomerDecisions.id })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(productOrderCustomerDecisions.orderId, input.orderId),
        eq(productOrderCustomerDecisions.status, "selected"),
        inArray(productOrderCustomerDecisions.selectedOutcome, input.outcomes),
      ),
    )
    .limit(1);
  return Boolean(row);
}

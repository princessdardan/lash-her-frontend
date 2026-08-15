import "server-only";

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
  productShipmentJobs,
  productShipments,
  productShippingCases,
} from "@/lib/private-db/schema";
import {
  hashShippingCustomerToken,
  issueShippingCustomerToken,
} from "./customer-token";
import { sendShippingCustomerLinkEmail } from "./customer-link-email";
import {
  hashCustomerDecisionConditions,
  stableCustomerDecisionJson,
} from "./customer-decision-terms";
import { claimShippingCustomerLinkIssuance } from "./customer-link-issuance";
import { hashOperationPayload } from "./shipment-store";

export {
  addressServiceSubstitutionDecisionTerms,
  addressSignatureDecisionTerms,
  hashCustomerDecisionConditions,
  lossDamageRemedyDecisionTerms,
} from "./customer-decision-terms";

export interface IssuedCustomerDecision {
  id: string;
  email: string;
  token: string;
}

interface IssueCustomerDecisionInput {
  orderReference: string;
  caseId?: string;
  shipmentId?: string;
  kind: CustomerDecisionKind;
  scopeKey: string;
  proposedConditions?: Record<string, unknown>;
  allowedOutcomes: string[];
  expiresAt: Date;
  notificationOrigin?: string;
}

export type CustomerDecisionKind =
  | "missed_handoff"
  | "loss_damage_remedy"
  | "service_substitution"
  | "signature_requirement";

export type CustomerDecisionExecutor = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

const OUTCOMES_BY_KIND: Record<CustomerDecisionKind, readonly string[]> = {
  missed_handoff: ["refund", "wait"],
  loss_damage_remedy: ["refund", "replacement"],
  service_substitution: ["accept_substitute", "decline_substitute"],
  signature_requirement: ["accept_signature", "decline_signature"],
};

export async function issueCustomerDecision(
  input: IssueCustomerDecisionInput,
): Promise<IssuedCustomerDecision> {
  const token = issueShippingCustomerToken();
  return getPrivateDb().transaction((tx) =>
    issueCustomerDecisionWithExecutor(tx, input, token),
  );
}

export async function issueCustomerDecisionWithExecutor(
  tx: CustomerDecisionExecutor,
  input: IssueCustomerDecisionInput,
  token = issueShippingCustomerToken(),
): Promise<IssuedCustomerDecision> {
  const permitted = OUTCOMES_BY_KIND[input.kind];
  const allowed = [...new Set(input.allowedOutcomes)].filter((value) =>
    permitted.includes(value),
  );
  const now = new Date();
  if (
    allowed.length !== new Set(input.allowedOutcomes).size ||
    !allowed.length ||
    input.expiresAt <= now ||
    !input.scopeKey.trim() ||
    (input.kind === "loss_damage_remedy" ? !input.caseId : !input.shipmentId)
  )
    throw new Error("Customer decision policy is invalid");
  const waitUntil = allowed.includes("wait")
    ? parseFutureDate(input.proposedConditions?.waitUntil, input.expiresAt)
    : null;
  if (allowed.includes("wait") && !waitUntil)
    throw new Error("A future wait deadline is required");
  const [order] = await tx
    .select({ id: checkoutOrders.id, email: checkoutOrders.customerEmail })
    .from(checkoutOrders)
    .where(eq(checkoutOrders.orderId, input.orderReference))
    .for("update")
    .limit(1);
  if (!order) throw new Error("Order was not found");
  if (input.shipmentId) {
    const [shipment] = await tx
      .select({
        id: productShipments.id,
        autoRefundDeadlineAt: productShipments.autoRefundDeadlineAt,
      })
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, input.shipmentId),
          eq(productShipments.orderId, order.id),
        ),
      )
      .limit(1);
    if (!shipment)
      throw new Error("Decision shipment does not belong to order");
    if (
      input.kind === "missed_handoff" &&
      (!shipment.autoRefundDeadlineAt ||
        shipment.autoRefundDeadlineAt.getTime() !== input.expiresAt.getTime())
    )
      throw new Error(
        "A wait extension must be signed before the exact current deadline",
      );
  }
  if (input.caseId) {
    const [shippingCase] = await tx
      .select({ id: productShippingCases.id })
      .from(productShippingCases)
      .where(
        and(
          eq(productShippingCases.id, input.caseId),
          eq(productShippingCases.orderId, order.id),
        ),
      )
      .limit(1);
    if (!shippingCase)
      throw new Error("Decision case does not belong to order");
  }
  const targetConditions = [
    eq(productOrderCustomerDecisions.orderId, order.id),
    eq(productOrderCustomerDecisions.kind, input.kind),
    input.shipmentId
      ? eq(productOrderCustomerDecisions.shipmentId, input.shipmentId)
      : eq(productOrderCustomerDecisions.caseId, input.caseId!),
  ];
  const [previous] = await tx
    .select({
      id: productOrderCustomerDecisions.id,
    })
    .from(productOrderCustomerDecisions)
    .where(and(...targetConditions))
    .orderBy(desc(productOrderCustomerDecisions.createdAt))
    .limit(1);
  const [previousScope] = await tx
    .select({ scopeVersion: productOrderCustomerDecisions.scopeVersion })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(productOrderCustomerDecisions.orderId, order.id),
        eq(productOrderCustomerDecisions.scopeKey, input.scopeKey),
      ),
    )
    .orderBy(desc(productOrderCustomerDecisions.scopeVersion))
    .limit(1);
  await tx
    .update(productOrderCustomerDecisions)
    .set({
      status: "revoked",
      revokedAt: now,
      supersededAt: now,
      stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        ...targetConditions,
        eq(productOrderCustomerDecisions.status, "pending"),
      ),
    );
  await tx
    .update(productOrderCustomerDecisions)
    .set({
      supersededAt: now,
      stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        ...targetConditions,
        eq(productOrderCustomerDecisions.status, "selected"),
        isNull(productOrderCustomerDecisions.supersededAt),
      ),
    );
  const [created] = await tx
    .insert(productOrderCustomerDecisions)
    .values({
      orderId: order.id,
      caseId: input.caseId,
      shipmentId: input.shipmentId,
      kind: input.kind,
      scopeKey: input.scopeKey.trim(),
      scopeVersion: (previousScope?.scopeVersion ?? 0) + 1,
      supersedesDecisionId: previous?.id,
      proposedConditions: input.proposedConditions,
      proposedConditionsHash: hashCustomerDecisionConditions(
        input.scopeKey.trim(),
        input.proposedConditions ?? null,
      ),
      allowedOutcomes: allowed,
      tokenHash: hashShippingCustomerToken(token, "decision"),
      expiresAt: input.expiresAt,
      waitUntil,
    })
    .returning({ id: productOrderCustomerDecisions.id });
  await claimShippingCustomerLinkIssuance(tx, {
    orderId: order.id,
    kind: "customer_decision",
    targetId: created!.id,
    now,
  });
  if (input.notificationOrigin) {
    const link = new URL("/orders/shipping-decision", input.notificationOrigin);
    link.searchParams.set("token", token);
    await sendShippingCustomerLinkEmail({
      to: order.email,
      orderReference: input.orderReference,
      link: link.toString(),
      purpose: "decision",
      idempotencyKey: `shipping-decision/${created!.id}`,
      orderDatabaseId: order.id,
      now,
      executor: tx,
    });
  }
  return { id: created!.id, email: order.email, token };
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
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const revoked = await tx
      .update(productOrderCustomerDecisions)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(...conditions))
      .returning();
    for (const decision of revoked) {
      await cleanupAddressDecision(tx, decision, "revoked", now);
    }
    return revoked.length;
  });
}

export async function expirePendingCustomerDecisions(
  now: Date,
): Promise<Array<{ orderId: string; caseId: string | null }>> {
  return getPrivateDb().transaction(async (tx) => {
    const expired = await tx
      .update(productOrderCustomerDecisions)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(productOrderCustomerDecisions.status, "pending"),
          sql`${productOrderCustomerDecisions.expiresAt} <= ${now}`,
        ),
      )
      .returning();
    for (const decision of expired) {
      await cleanupAddressDecision(tx, decision, "expired", now);
    }
    return expired.map(({ orderId, caseId }) => ({ orderId, caseId }));
  });
}

export async function getCustomerDecision(sessionToken: string) {
  const now = new Date();
  const [row] = await getPrivateDb()
    .select({
      id: productOrderCustomerDecisions.id,
      kind: productOrderCustomerDecisions.kind,
      scopeKey: productOrderCustomerDecisions.scopeKey,
      proposedConditions: productOrderCustomerDecisions.proposedConditions,
      proposedConditionsHash:
        productOrderCustomerDecisions.proposedConditionsHash,
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
  return row
    ? {
        ...row,
        conditionsHash: row.proposedConditionsHash,
      }
    : null;
}

export async function selectCustomerDecision(
  sessionToken: string,
  outcome: string,
  expectedScopeKey: string,
  expectedConditionsHash: string,
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
    if (
      !row ||
      !row.allowedOutcomes.includes(outcome) ||
      row.scopeKey !== expectedScopeKey ||
      row.proposedConditionsHash !== expectedConditionsHash
    )
      return false;
    if (outcome === "wait") {
      if (!row.shipmentId || !row.waitUntil || row.waitUntil <= now)
        return false;
      const [shipment] = await tx
        .select({
          stateVersion: productShipments.stateVersion,
          autoRefundDeadlineAt: productShipments.autoRefundDeadlineAt,
        })
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, row.shipmentId),
            eq(productShipments.orderId, row.orderId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !shipment?.autoRefundDeadlineAt ||
        row.waitUntil <= shipment.autoRefundDeadlineAt
      )
        return false;
      const [extended] = await tx
        .update(productShipments)
        .set({
          autoRefundDeadlineAt: row.waitUntil,
          stateVersion: shipment.stateVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, row.shipmentId),
            eq(productShipments.stateVersion, shipment.stateVersion),
          ),
        )
        .returning({ id: productShipments.id });
      if (!extended) return false;
    }
    const terminalAtSelection =
      outcome === "wait" ||
      outcome === "decline_substitute" ||
      outcome === "decline_signature";
    const [updated] = await tx
      .update(productOrderCustomerDecisions)
      .set({
        status: "selected",
        selectedOutcome: outcome,
        selectedAt: now,
        consumedAt: terminalAtSelection ? now : null,
        processedAt: terminalAtSelection ? now : null,
        stateVersion: row.stateVersion + 1,
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
      .returning();
    if (!updated) return false;
    if (row.kind === "service_substitution") {
      if (outcome === "accept_substitute") {
        await queueAddressDecisionResume(tx, updated, now);
      } else if (outcome === "decline_substitute") {
        await cleanupAddressDecision(tx, updated, "declined", now);
      }
    } else if (row.kind === "signature_requirement") {
      if (outcome === "accept_signature") {
        await queueAddressDecisionResume(tx, updated, now);
      } else if (outcome === "decline_signature") {
        await cleanupAddressDecision(tx, updated, "declined", now);
      }
    }
    return true;
  });
}

export async function hasSignedCustomerDecision(input: {
  orderId: string;
  kind: CustomerDecisionKind;
  shipmentId?: string;
  caseId?: string;
  outcomes: string[];
  scopeKey: string;
  proposedConditions: Record<string, unknown>;
}): Promise<boolean> {
  if (!input.shipmentId && !input.caseId) return false;
  const now = new Date();
  const conditions = [
    eq(productOrderCustomerDecisions.orderId, input.orderId),
    eq(productOrderCustomerDecisions.kind, input.kind),
    eq(productOrderCustomerDecisions.scopeKey, input.scopeKey),
    eq(productOrderCustomerDecisions.status, "selected"),
    inArray(productOrderCustomerDecisions.selectedOutcome, input.outcomes),
    gt(productOrderCustomerDecisions.expiresAt, now),
    isNull(productOrderCustomerDecisions.consumedAt),
    isNull(productOrderCustomerDecisions.supersededAt),
  ];
  if (input.shipmentId)
    conditions.push(
      eq(productOrderCustomerDecisions.shipmentId, input.shipmentId),
    );
  if (input.caseId)
    conditions.push(eq(productOrderCustomerDecisions.caseId, input.caseId));
  const [row] = await getPrivateDb()
    .select({ id: productOrderCustomerDecisions.id })
    .from(productOrderCustomerDecisions)
    .where(and(...conditions))
    .limit(1);
  if (!row) return false;
  const [full] = await getPrivateDb()
    .select({
      proposedConditions: productOrderCustomerDecisions.proposedConditions,
    })
    .from(productOrderCustomerDecisions)
    .where(eq(productOrderCustomerDecisions.id, row.id))
    .limit(1);
  return (
    stableCustomerDecisionJson(full?.proposedConditions) ===
    stableCustomerDecisionJson(input.proposedConditions)
  );
}

export async function consumeSignedCustomerDecision(input: {
  orderId: string;
  kind: CustomerDecisionKind;
  outcome: string;
  shipmentId?: string;
  caseId?: string;
  scopeKey: string;
  proposedConditions: Record<string, unknown>;
  now?: Date;
}): Promise<string | null> {
  if (!input.shipmentId && !input.caseId) return null;
  const now = input.now ?? new Date();
  return getPrivateDb().transaction((tx) =>
    consumeSignedCustomerDecisionWithExecutor(tx, { ...input, now }),
  );
}

export async function consumeSignedCustomerDecisionWithExecutor(
  tx: CustomerDecisionExecutor,
  input: {
    orderId: string;
    kind: CustomerDecisionKind;
    outcome: string;
    shipmentId?: string;
    caseId?: string;
    scopeKey: string;
    proposedConditions: Record<string, unknown>;
    now: Date;
  },
): Promise<string | null> {
  if (!input.shipmentId && !input.caseId) return null;
  const now = input.now;
  const conditions = [
    eq(productOrderCustomerDecisions.orderId, input.orderId),
    eq(productOrderCustomerDecisions.kind, input.kind),
    eq(productOrderCustomerDecisions.scopeKey, input.scopeKey),
    eq(productOrderCustomerDecisions.status, "selected"),
    eq(productOrderCustomerDecisions.selectedOutcome, input.outcome),
    gt(productOrderCustomerDecisions.expiresAt, now),
    isNull(productOrderCustomerDecisions.consumedAt),
    isNull(productOrderCustomerDecisions.supersededAt),
  ];
  if (input.shipmentId)
    conditions.push(
      eq(productOrderCustomerDecisions.shipmentId, input.shipmentId),
    );
  if (input.caseId)
    conditions.push(eq(productOrderCustomerDecisions.caseId, input.caseId));
  const [row] = await tx
    .select()
    .from(productOrderCustomerDecisions)
    .where(and(...conditions))
    .orderBy(desc(productOrderCustomerDecisions.selectedAt))
    .for("update")
    .limit(1);
  if (!row) return null;
  if (
    stableCustomerDecisionJson(row.proposedConditions) !==
    stableCustomerDecisionJson(input.proposedConditions)
  )
    return null;
  const [consumed] = await tx
    .update(productOrderCustomerDecisions)
    .set({
      consumedAt: now,
      processedAt: now,
      stateVersion: row.stateVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(productOrderCustomerDecisions.id, row.id),
        eq(productOrderCustomerDecisions.stateVersion, row.stateVersion),
        isNull(productOrderCustomerDecisions.consumedAt),
      ),
    )
    .returning({ id: productOrderCustomerDecisions.id });
  return consumed?.id ?? null;
}

function parseFutureDate(value: unknown, after: Date): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed > after ? parsed : null;
}

async function queueAddressDecisionResume(
  tx: CustomerDecisionExecutor,
  decision: typeof productOrderCustomerDecisions.$inferSelect,
  now: Date,
): Promise<void> {
  const requestId = decision.proposedConditions?.requestId;
  const sourceShipmentId = decision.proposedConditions?.sourceShipmentId;
  if (typeof requestId !== "string" || typeof sourceShipmentId !== "string") {
    throw new Error("Address decision scope is incomplete");
  }
  const [request] = await tx
    .select()
    .from(productOrderAddressChangeRequests)
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .for("update")
    .limit(1);
  const expectedState =
    decision.kind === "signature_requirement"
      ? "awaiting_signature"
      : "awaiting_service_substitution";
  const recordedDecisionId =
    decision.kind === "signature_requirement"
      ? request?.providerReconciliation?.signatureDecisionId
      : request?.providerReconciliation?.substitutionDecisionId;
  if (
    !request ||
    request.orderId !== decision.orderId ||
    request.status !== "approved" ||
    request.expectedSourceShipmentId !== sourceShipmentId ||
    request.reconciliationState !== expectedState ||
    recordedDecisionId !== decision.id ||
    (decision.kind === "service_substitution" &&
      (!request.preparedShipmentId ||
        request.preparedShipmentStateVersion === null))
  ) {
    throw new Error("Address decision no longer matches the prepared workflow");
  }
  const nextVersion = request.stateVersion + 1;
  const payload = {
    ...(decision.kind === "service_substitution"
      ? {
          mode: "resume_service_substitution",
          decisionId: decision.id,
          preparedShipmentId: request.preparedShipmentId,
          expectedPreparedStateVersion: request.preparedShipmentStateVersion,
        }
      : {}),
    requestId,
    sourceShipmentId,
    expectedRequestStateVersion: nextVersion,
    expectedSourceStateVersion: request.expectedSourceShipmentStateVersion,
  };
  if (typeof payload.expectedSourceStateVersion !== "number") {
    throw new Error("Address decision source version is missing");
  }
  const idempotencyKey = `address-decision-resume/${decision.id}`;
  const [operation] = await tx
    .insert(productShipmentJobs)
    .values({
      shipmentId: sourceShipmentId,
      type: "address_replace",
      status: "queued",
      idempotencyKey,
      operationPayloadHash: hashOperationPayload(payload),
      payload,
    })
    .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey })
    .returning({ id: productShipmentJobs.id });
  if (!operation)
    throw new Error("Address decision resume operation conflicts");
  const [updated] = await tx
    .update(productOrderAddressChangeRequests)
    .set({
      reconciliationState: "decision_resume_queued",
      providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ decisionResumeOperationId: operation.id, decisionId: decision.id })}::jsonb`,
      stateVersion: nextVersion,
      updatedAt: now,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, request.id),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          request.stateVersion,
        ),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!updated) throw new Error("Address decision resume state changed");
}

async function cleanupAddressDecision(
  tx: CustomerDecisionExecutor,
  decision: typeof productOrderCustomerDecisions.$inferSelect,
  reason: "declined" | "expired" | "revoked",
  now: Date,
): Promise<void> {
  if (
    decision.kind !== "service_substitution" &&
    decision.kind !== "signature_requirement"
  )
    return;
  const requestId = decision.proposedConditions?.requestId;
  if (typeof requestId !== "string") return;
  const [request] = await tx
    .select()
    .from(productOrderAddressChangeRequests)
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .for("update")
    .limit(1);
  if (decision.kind === "signature_requirement") {
    if (
      !request ||
      request.orderId !== decision.orderId ||
      request.reconciliationState !== "awaiting_signature" ||
      request.providerReconciliation?.signatureDecisionId !== decision.id
    )
      return;
    const [updated] = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        reconciliationState: `signature_${reason}`,
        providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'signatureDecisionId' - 'signatureDecisionTerms') || ${JSON.stringify({ signatureDecisionOutcome: reason, signatureDecisionClosedAt: now.toISOString() })}::jsonb`,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: request.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, request.id),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            request.stateVersion,
          ),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!updated) throw new Error("Address signature decision state changed");
    return;
  }
  if (
    !request ||
    request.orderId !== decision.orderId ||
    !request.preparedShipmentId ||
    request.preparedShipmentStateVersion === null ||
    request.providerReconciliation?.substitutionDecisionId !== decision.id ||
    !["awaiting_service_substitution", "decision_resume_queued"].includes(
      request.reconciliationState,
    )
  )
    return;
  const [prepared] = await tx
    .select()
    .from(productShipments)
    .where(eq(productShipments.id, request.preparedShipmentId))
    .for("update")
    .limit(1);
  if (
    !prepared ||
    prepared.orderId !== decision.orderId ||
    prepared.purchasedAt ||
    prepared.stateVersion !== request.preparedShipmentStateVersion ||
    !["quoted", "ready_for_staff"].includes(prepared.status)
  ) {
    throw new Error("Substitute service draft is not safely cleanable");
  }
  const fencedVersion = prepared.stateVersion + 1;
  const [fenced] = await tx
    .update(productShipments)
    .set({ status: "abandoned", stateVersion: fencedVersion, updatedAt: now })
    .where(
      and(
        eq(productShipments.id, prepared.id),
        eq(productShipments.stateVersion, prepared.stateVersion),
      ),
    )
    .returning({ id: productShipments.id });
  if (!fenced)
    throw new Error("Substitute service draft changed before cleanup");
  const cleanupPayload = {
    requestId,
    reason: `address_service_substitution_${reason}`,
    expectedShipmentStateVersion: fencedVersion,
  };
  await tx
    .insert(productShipmentJobs)
    .values({
      shipmentId: prepared.id,
      type: "cleanup",
      status: "queued",
      idempotencyKey: `address-service-substitution-cleanup/${decision.id}`,
      operationPayloadHash: hashOperationPayload(cleanupPayload),
      payload: cleanupPayload,
    })
    .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
  const [requestUpdated] = await tx
    .update(productOrderAddressChangeRequests)
    .set({
      preparedShipmentId: null,
      preparedShipmentStateVersion: null,
      reconciliationState: `service_substitution_${reason}`,
      cleanupOutcome: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'preparedShipment' - 'substitutionDecisionId' - 'substitutionDecisionTerms') || ${JSON.stringify({ substitutionDecisionOutcome: reason, substitutionDecisionClosedAt: now.toISOString() })}::jsonb`,
      stateVersion: request.stateVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, request.id),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          request.stateVersion,
        ),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!requestUpdated) {
    throw new Error("Address substitution cleanup state changed");
  }
}

import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getHelcimCardTransaction } from "@/lib/commerce/helcim-client";
import {
  assessCertifiedOwnerReviewEvidence,
  classifyHelcimTransaction,
} from "@/lib/commerce/helcim-contract";
import { normalizeHelcimCardTransactionDetails } from "@/lib/commerce/helcim-webhook";
import type { HelcimCardTransactionResponse } from "@/lib/commerce/helcim-types";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  fulfillmentOwnerActions,
  orderPaymentTransactions,
  productOrderRiskReviews,
  productPaymentRiskIncidents,
} from "@/lib/private-db/schema";
import { parseProviderMoneyCents } from "./provider-money";
import { activateShipmentForPaidOrderInTransaction } from "./shipment-store";
import {
  assertConfiguredFulfillmentOwner,
  assertConfiguredFulfillmentOwnerInTransaction,
} from "./configured-owner";

const COOLING_OFF_MS = 15 * 60_000;

export interface ProductRiskReviewDependencies {
  getCardTransaction?: (
    transactionId: string,
  ) => Promise<HelcimCardTransactionResponse>;
}

export async function recordProductOrderRiskReview(
  input: {
    orderReference: string;
    incidentId: string;
    expectedIncidentStateVersion: number;
    reviewerAdminUserId: string;
    decision: "clear_false_positive" | "escalate";
    rationale: string;
    stepUpAuthenticatedAt?: Date;
  },
  dependencies: ProductRiskReviewDependencies = {},
): Promise<{ cleared: boolean; coolingOffUntil?: string }> {
  const rationale = input.rationale.trim().slice(0, 1_000);
  if (rationale.length < 10) {
    throw new Error(
      "A documented rationale of at least 10 characters is required",
    );
  }
  await assertConfiguredFulfillmentOwner(input.reviewerAdminUserId);
  if (
    input.decision === "clear_false_positive" &&
    !input.stepUpAuthenticatedAt
  ) {
    throw new Error("Step-up authentication is required");
  }

  const context = await loadReviewContext(
    input.orderReference,
    input.incidentId,
    input.expectedIncidentStateVersion,
  );
  if (!context) throw new Error("No active payment-risk incident was found");
  const providerEvidence =
    input.decision === "clear_false_positive"
      ? await loadAuthoritativeProviderEvidence(
          context,
          dependencies.getCardTransaction ?? getHelcimCardTransaction,
        )
      : {};

  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.reviewerAdminUserId,
    );

    const [lockedOrder] = await tx
      .select({
        id: checkoutOrders.id,
        fulfillmentMode: checkoutOrders.fulfillmentMode,
      })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, context.orderId))
      .for("update")
      .limit(1);
    if (!lockedOrder) throw new Error("Payment-risk order no longer exists");

    const [incident] = await tx
      .select()
      .from(productPaymentRiskIncidents)
      .where(
        and(
          eq(productPaymentRiskIncidents.id, context.incidentId),
          eq(productPaymentRiskIncidents.orderId, context.orderId),
          eq(productPaymentRiskIncidents.status, "review_required"),
          eq(
            productPaymentRiskIncidents.stateVersion,
            input.expectedIncidentStateVersion,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!incident) {
      throw new Error("Payment-risk incident changed during provider review");
    }

    if (input.decision === "escalate") {
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "payment_risk_incident",
        targetId: incident.id,
        action: "fraud_escalated",
        adminUserId: input.reviewerAdminUserId,
        policyVersion: incident.policyVersion,
        rationale,
        evidence: {},
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt ?? now,
        coolingOffUntil: now,
        executedAt: now,
      });
      await tx
        .update(productPaymentRiskIncidents)
        .set({
          outcome: "escalated",
          rationale,
          stateVersion: incident.stateVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(productPaymentRiskIncidents.id, incident.id),
            eq(productPaymentRiskIncidents.stateVersion, incident.stateVersion),
          ),
        );
      return { cleared: false };
    }

    if (!input.stepUpAuthenticatedAt) {
      throw new Error("Step-up authentication is required");
    }

    const [proposal] = await tx
      .select()
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "payment_risk_incident"),
          eq(fulfillmentOwnerActions.targetId, incident.id),
          eq(fulfillmentOwnerActions.action, "fraud_clearance_proposed"),
        ),
      )
      .orderBy(desc(fulfillmentOwnerActions.createdAt))
      .limit(1);
    const proposalEvidence = proposal?.evidence ?? {};
    const proposedIncidentStateVersion = readEvidenceInteger(
      proposalEvidence.proposedIncidentStateVersion,
    );
    const matchingDecisionHash =
      proposedIncidentStateVersion !== null &&
      incident.stateVersion === proposedIncidentStateVersion + 1
        ? riskDecisionHash({
            incidentId: incident.id,
            incidentStateVersion: proposedIncidentStateVersion,
            policyVersion: incident.policyVersion,
            providerEvidence,
            rationale,
          })
        : null;
    const proposalMatches = Boolean(
      proposal &&
      matchingDecisionHash &&
      proposalEvidence.decisionHash === matchingDecisionHash,
    );
    if (!proposalMatches) {
      const coolingOffUntil = new Date(now.getTime() + COOLING_OFF_MS);
      const decisionHash = riskDecisionHash({
        incidentId: incident.id,
        incidentStateVersion: incident.stateVersion,
        policyVersion: incident.policyVersion,
        providerEvidence,
        rationale,
      });
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "payment_risk_incident",
        targetId: incident.id,
        action: "fraud_clearance_proposed",
        adminUserId: input.reviewerAdminUserId,
        policyVersion: incident.policyVersion,
        rationale,
        evidence: {
          ...providerEvidence,
          decisionHash,
          proposedIncidentStateVersion: incident.stateVersion,
        },
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        coolingOffUntil,
      });
      await tx
        .update(productPaymentRiskIncidents)
        .set({
          ownerAdminUserId: input.reviewerAdminUserId,
          stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          coolingOffUntil,
          rationale,
          providerEvidence,
          stateVersion: incident.stateVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(productPaymentRiskIncidents.id, incident.id),
            eq(productPaymentRiskIncidents.stateVersion, incident.stateVersion),
          ),
        );
      return { cleared: false, coolingOffUntil: coolingOffUntil.toISOString() };
    }
    if (proposal!.coolingOffUntil > now) {
      return {
        cleared: false,
        coolingOffUntil: proposal!.coolingOffUntil.toISOString(),
      };
    }

    const [execution] = await tx
      .select({ id: fulfillmentOwnerActions.id })
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "payment_risk_incident"),
          eq(fulfillmentOwnerActions.targetId, incident.id),
          eq(fulfillmentOwnerActions.action, "fraud_clearance_executed"),
        ),
      )
      .limit(1);
    if (execution) {
      const active = await hasOtherActiveIncident(
        tx,
        context.orderId,
        incident.id,
      );
      return { cleared: !active };
    }

    await tx.insert(fulfillmentOwnerActions).values({
      targetType: "payment_risk_incident",
      targetId: incident.id,
      action: "fraud_clearance_executed",
      adminUserId: input.reviewerAdminUserId,
      policyVersion: incident.policyVersion,
      rationale,
      evidence: providerEvidence,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      coolingOffUntil: proposal!.coolingOffUntil,
      executedAt: now,
    });
    await tx.insert(productOrderRiskReviews).values({
      orderId: context.orderId,
      reviewerAdminUserId: input.reviewerAdminUserId,
      reviewerWasBusinessOwner: true,
      incidentId: incident.id,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      coolingOffUntil: proposal!.coolingOffUntil,
      providerEvidenceAvailable: true,
      evidence: providerEvidence,
      decision: "clear_false_positive",
      rationale,
    });
    await tx
      .update(productPaymentRiskIncidents)
      .set({
        status: "cleared",
        ownerAdminUserId: input.reviewerAdminUserId,
        reviewedAt: now,
        rationale,
        outcome: "cleared",
        providerEvidence,
        stateVersion: incident.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productPaymentRiskIncidents.id, incident.id),
          eq(productPaymentRiskIncidents.stateVersion, incident.stateVersion),
        ),
      );

    const active = await hasOtherActiveIncident(
      tx,
      context.orderId,
      incident.id,
    );
    if (active) return { cleared: false };
    await tx
      .update(checkoutOrders)
      .set({
        paymentRiskStatus: "cleared",
        paymentRiskAssessedAt: now,
        paymentRiskSource: "manual",
        fraudClassification: "low",
        fraudRiskReasons: [],
        fraudClearedAt: now,
        updatedAt: now,
      })
      .where(eq(checkoutOrders.id, context.orderId));
    const activated = await activateShipmentForPaidOrderInTransaction(
      tx,
      input.orderReference,
      now,
    );
    if (lockedOrder.fulfillmentMode === "automated_shipping" && !activated) {
      throw new Error("Paid cleared shipment activation did not converge");
    }
    return { cleared: true };
  });
}

interface ReviewContext {
  incidentId: string;
  orderId: string;
  providerTransactionId: string;
  expectedAmountCents: number;
  expectedCurrency: string;
}

async function loadReviewContext(
  orderReference: string,
  incidentId: string,
  expectedIncidentStateVersion: number,
): Promise<ReviewContext | null> {
  const [row] = await getPrivateDb()
    .select({
      orderId: checkoutOrders.id,
      orderAmountCents: checkoutOrders.amountCents,
      orderCurrency: checkoutOrders.currency,
      incident: productPaymentRiskIncidents,
      transactionProviderId: orderPaymentTransactions.providerTransactionId,
      transactionAmountCents: orderPaymentTransactions.amountCents,
      transactionCurrency: orderPaymentTransactions.currency,
    })
    .from(checkoutOrders)
    .innerJoin(
      productPaymentRiskIncidents,
      eq(productPaymentRiskIncidents.orderId, checkoutOrders.id),
    )
    .leftJoin(
      orderPaymentTransactions,
      eq(
        orderPaymentTransactions.id,
        productPaymentRiskIncidents.paymentTransactionId,
      ),
    )
    .where(
      and(
        eq(checkoutOrders.orderId, orderReference),
        eq(productPaymentRiskIncidents.id, incidentId),
        eq(
          productPaymentRiskIncidents.stateVersion,
          expectedIncidentStateVersion,
        ),
        eq(productPaymentRiskIncidents.status, "review_required"),
      ),
    )
    .orderBy(desc(productPaymentRiskIncidents.createdAt))
    .limit(1);
  if (!row) return null;
  const evidence = row.incident.providerEvidence ?? {};
  const providerTransactionId =
    row.transactionProviderId ??
    readEvidenceText(evidence.providerTransactionId);
  if (!providerTransactionId) {
    throw new Error("Risk incident has no immutable provider transaction ID");
  }
  return {
    incidentId: row.incident.id,
    orderId: row.orderId,
    providerTransactionId,
    expectedAmountCents: row.transactionAmountCents ?? row.orderAmountCents,
    expectedCurrency: (
      row.transactionCurrency ?? row.orderCurrency
    ).toUpperCase(),
  };
}

async function loadAuthoritativeProviderEvidence(
  context: ReviewContext,
  getCardTransaction: (
    transactionId: string,
  ) => Promise<HelcimCardTransactionResponse>,
): Promise<Record<string, unknown>> {
  const details = normalizeHelcimCardTransactionDetails(
    await getCardTransaction(context.providerTransactionId),
  );
  const classification = classifyHelcimTransaction({
    originalTransactionId: details.originalTransactionId,
    status: details.status,
    transactionType: details.transactionType,
  });
  let amountCents: number | null = null;
  try {
    amountCents = parseProviderMoneyCents(details.amount);
  } catch {
    amountCents = null;
  }
  if (
    details.transactionId !== context.providerTransactionId ||
    classification.kind !== "purchase" ||
    !classification.successful ||
    amountCents !== context.expectedAmountCents ||
    details.currency?.toUpperCase() !== context.expectedCurrency
  ) {
    throw new Error(
      "Authoritative Helcim evidence does not match the incident",
    );
  }
  const cardAssessment = assessCertifiedOwnerReviewEvidence({
    avsCode: details.avsCode,
    cvvCode: details.cvvCode,
  });
  if (!cardAssessment.available) {
    throw new Error(
      "Authoritative AVS/CVV evidence is missing, unknown, or unsupported",
    );
  }
  return {
    providerTransactionId: context.providerTransactionId,
    providerStatus: classification.normalizedStatus,
    providerType: classification.normalizedType,
    amountCents,
    currency: context.expectedCurrency,
    avsCode: details.avsCode ?? null,
    cvvCode: details.cvvCode ?? null,
    reasonCodes: cardAssessment.reasonCodes,
  };
}

async function hasOtherActiveIncident(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  orderId: string,
  incidentId: string,
): Promise<boolean> {
  const [active] = await tx
    .select({ id: productPaymentRiskIncidents.id })
    .from(productPaymentRiskIncidents)
    .where(
      and(
        eq(productPaymentRiskIncidents.orderId, orderId),
        ne(productPaymentRiskIncidents.id, incidentId),
        inArray(productPaymentRiskIncidents.status, [
          "pending",
          "review_required",
        ]),
      ),
    )
    .limit(1);
  return Boolean(active);
}

function readEvidenceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEvidenceInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function riskDecisionHash(input: {
  incidentId: string;
  incidentStateVersion: number;
  policyVersion: string;
  providerEvidence: Record<string, unknown>;
  rationale: string;
}): string {
  return createHash("sha256")
    .update(stableRiskJson(input), "utf8")
    .digest("hex");
}

function stableRiskJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRiskJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, nested]) => `${JSON.stringify(key)}:${stableRiskJson(nested)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

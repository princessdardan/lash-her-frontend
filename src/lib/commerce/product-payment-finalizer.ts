import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  fulfillmentRiskAlertOutbox,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAdjustments,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productPaymentRiskIncidents,
  shippingPolicySettings,
  type PaymentRiskStatus,
} from "@/lib/private-db/schema";

import {
  assessCertifiedCardEvidence,
  classifyHelcimTransaction,
} from "./helcim-contract";
import type { HelcimPayloadValue } from "./helcim-types";
import {
  paymentObligationMatchesConfiguredHelcimContract,
  readCertifiedHelcimEvidenceField,
} from "./helcim-certified-contract";
import { activateShipmentForPaidOrderInTransaction } from "@/lib/shipping/shipment-store";

export interface FinalizeProductPaymentInput {
  orderReference: string;
  /** Required for non-primary obligations. Primary checkout remains backwards compatible. */
  obligationId?: string;
  transactionId: string;
  source: "client_callback" | "helcim_api";
  data: Record<string, HelcimPayloadValue>;
  certifiedEvidence?: { avsCode?: string; cvvCode?: string };
  authoritativeLookupFailure?:
    | "not_found"
    | "malformed_response"
    | "request_failed"
    | "unavailable";
  /**
   * Set only after the browser callback hash and order binding have been
   * authenticated. It permits an identity-only replay of a provider-backed
   * transaction that is already immutable in the local ledger.
   */
  authenticatedCallbackIdentity?: {
    orderReference: string;
    obligationId?: string;
    transactionId: string;
  };
}

export interface FinalizeProductPaymentResult {
  transition:
    | "applied"
    | "already_applied"
    | "outcome_unknown"
    | "state_conflict"
    | "transaction_conflict"
    | "not_found";
  riskStatus: PaymentRiskStatus;
  obligationId?: string;
}

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

interface RiskIncidentResult {
  id: string;
  status: PaymentRiskStatus;
  alertedAt: Date | null;
}

type InternalFinalizationResult = FinalizeProductPaymentResult;

export async function finalizeProductPayment(
  input: FinalizeProductPaymentInput,
): Promise<FinalizeProductPaymentResult> {
  if (input.authoritativeLookupFailure) {
    if (input.source !== "helcim_api") {
      throw new Error(
        "Authoritative lookup failures must be recorded as Helcim API evidence",
      );
    }
    return finalizeAuthoritativeLookupFailure({
      ...input,
      authoritativeLookupFailure: input.authoritativeLookupFailure,
    });
  }
  const parsed = parseProviderPurchase(input);
  if (!parsed) {
    const conflict = await recordProductPaymentConflict(input, [
      "UNRECOGNIZED_PURCHASE_CONTRACT",
    ]);
    return conflict;
  }

  const assessment = assessCertifiedCardEvidence({
    avsCode:
      input.source === "helcim_api"
        ? (input.certifiedEvidence?.avsCode ??
          readCertifiedHelcimEvidenceField(input.data, "avs"))
        : readCertifiedHelcimEvidenceField(input.data, "avs"),
    cvvCode:
      input.source === "helcim_api"
        ? (input.certifiedEvidence?.cvvCode ??
          readCertifiedHelcimEvidenceField(input.data, "cvv"))
        : readCertifiedHelcimEvidenceField(input.data, "cvv"),
  });
  const now = new Date();
  const finalized = await getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "helcim"),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return internalResult({
        transition: "not_found",
        riskStatus: "review_required",
      });
    }
    const obligations = await tx
      .select()
      .from(orderPaymentObligations)
      .where(
        input.obligationId
          ? and(
              eq(orderPaymentObligations.id, input.obligationId),
              eq(orderPaymentObligations.orderId, order.id),
              isNull(orderPaymentObligations.quarantinedAt),
            )
          : and(
              eq(orderPaymentObligations.orderId, order.id),
              eq(orderPaymentObligations.purpose, "primary"),
              isNull(orderPaymentObligations.quarantinedAt),
            ),
      )
      .for("update")
      .limit(2);
    if (obligations.length !== 1) {
      return recordConflictInTransaction(tx, order.id, input, [
        obligations.length === 0
          ? "PAYMENT_OBLIGATION_NOT_FOUND"
          : "MULTIPLE_PRIMARY_PAYMENT_OBLIGATIONS",
      ]);
    }
    const obligation = obligations[0]!;
    const isPrimary = obligation.purpose === "primary";
    const isLateCapture = isLatePaymentCapture({
      obligation,
      order,
      now,
    });
    const lateCaptureClassification = classifyLateCaptureReason({
      fulfillmentMode: order.fulfillmentMode,
      obligationPurpose: obligation.purpose,
    });
    const lateCaptureReasonCode = lateCaptureClassification.reasonCode;
    const lateCaptureReason = lateCaptureClassification.reason;

    if (
      !paymentObligationMatchesConfiguredHelcimContract(
        obligation.disclosureSnapshot,
      )
    ) {
      return recordConflictInTransaction(
        tx,
        order.id,
        input,
        ["PAYMENT_CONTRACT_SNAPSHOT_MISMATCH"],
        obligation.id,
      );
    }

    if (
      obligation.initializationStatus !== "ready" ||
      obligation.quarantinedAt !== null
    ) {
      return recordConflictInTransaction(
        tx,
        order.id,
        input,
        [
          obligation.quarantinedAt
            ? "PAYMENT_OBLIGATION_QUARANTINED"
            : "PAYMENT_OBLIGATION_NOT_READY",
        ],
        obligation.id,
      );
    }

    if (
      parsed.amountCents !== obligation.totalAmountCents ||
      parsed.currency !== obligation.currency.toUpperCase() ||
      (isPrimary &&
        (order.amountCents !== obligation.totalAmountCents ||
          order.currency.toUpperCase() !== obligation.currency.toUpperCase()))
    ) {
      return recordConflictInTransaction(
        tx,
        order.id,
        input,
        ["PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH"],
        obligation.id,
      );
    }

    const [existingTransaction] = await tx
      .select()
      .from(orderPaymentTransactions)
      .where(
        and(
          eq(orderPaymentTransactions.provider, "helcim"),
          eq(
            orderPaymentTransactions.providerTransactionId,
            input.transactionId,
          ),
        ),
      )
      .limit(1);
    if (existingTransaction) {
      if (
        existingTransaction.obligationId !== obligation.id ||
        existingTransaction.amountCents !== obligation.totalAmountCents ||
        existingTransaction.currency.toUpperCase() !==
          obligation.currency.toUpperCase()
      ) {
        return recordConflictInTransaction(
          tx,
          order.id,
          input,
          ["PROVIDER_TRANSACTION_IDENTITY_CONFLICT"],
          obligation.id,
        );
      }
      if (isLateCapture) {
        await reserveLateCaptureRefund(tx, {
          orderId: order.id,
          obligation,
          paymentTransactionId: existingTransaction.id,
          providerTransactionId: existingTransaction.providerTransactionId,
          amountCents: existingTransaction.amountCents,
          reason: lateCaptureReason,
        });
        const incident = await ensureRiskIncident(tx, {
          orderId: order.id,
          paymentTransactionId: existingTransaction.id,
          incidentKey: `late-capture/${existingTransaction.id}`,
          reasonCodes: [lateCaptureReasonCode],
          evidence: { providerTransactionId: input.transactionId },
          now,
        });
        if (incident.status === "review_required") {
          await setOrderReviewRequired(
            tx,
            order.id,
            [lateCaptureReasonCode],
            input.source,
            now,
          );
        }
        return internalResult({
          transition: "state_conflict",
          riskStatus: "review_required",
          obligationId: obligation.id,
        });
      }
      const stateMatches =
        obligation.status === "paid" &&
        (!isPrimary ||
          (order.status === "paid" &&
            order.helcimTransactionId === input.transactionId));
      if (!stateMatches) {
        return recordConflictInTransaction(
          tx,
          order.id,
          input,
          ["PAYMENT_LEDGER_STATE_CONFLICT"],
          obligation.id,
        );
      }
      if (
        order.paymentRiskStatus === "cleared" &&
        order.fulfillmentMode === "automated_shipping"
      ) {
        const activated = await activateShipmentForPaidOrderInTransaction(
          tx,
          input.orderReference,
          now,
        );
        if (!activated) {
          throw new Error("Paid cleared shipment activation did not converge");
        }
      }
      return internalResult({
        transition: "already_applied",
        riskStatus: order.paymentRiskStatus,
        obligationId: obligation.id,
      });
    }

    const validPendingState = isPrimary
      ? inPrimaryPendingState(order.status, order.helcimTransactionId)
      : inSupplementalPendingState(order.status, obligation.status);
    if (
      (!validPendingState && !isLateCapture) ||
      (!isLateCapture && obligation.status !== "pending") ||
      (!isLateCapture &&
        obligation.expiresAt !== null &&
        obligation.expiresAt <= now)
    ) {
      return recordConflictInTransaction(
        tx,
        order.id,
        input,
        [
          order.status === "paid" || obligation.status === "paid"
            ? "TRANSACTION_CONFLICT"
            : "STATE_CONFLICT",
        ],
        obligation.id,
      );
    }

    const [createdTransaction] = await tx
      .insert(orderPaymentTransactions)
      .values({
        obligationId: obligation.id,
        provider: "helcim",
        providerTransactionId: input.transactionId,
        amountCents: obligation.totalAmountCents,
        currency: obligation.currency.toUpperCase(),
        originatingIpCiphertext: order.refundOriginIpCiphertext,
        providerType: parsed.normalizedType,
        providerStatus: parsed.normalizedStatus,
        avsCode: assessment.avsCode,
        cvvCode: assessment.cvvCode,
        riskStatus: isLateCapture ? "review_required" : assessment.status,
        riskReasonCodes: isLateCapture
          ? [lateCaptureReasonCode, ...assessment.reasonCodes]
          : assessment.reasonCodes,
        capturedAt: now,
      })
      .returning({ id: orderPaymentTransactions.id });
    if (!createdTransaction) {
      return recordConflictInTransaction(
        tx,
        order.id,
        input,
        ["PAYMENT_TRANSACTION_INSERT_FAILED"],
        obligation.id,
      );
    }

    if (!isLateCapture) {
      const [paidObligation] = await tx
        .update(orderPaymentObligations)
        .set({ status: "paid", paidAt: now, updatedAt: now })
        .where(
          and(
            eq(orderPaymentObligations.id, obligation.id),
            eq(orderPaymentObligations.status, "pending"),
          ),
        )
        .returning({ id: orderPaymentObligations.id });
      if (!paidObligation)
        throw new Error("Payment obligation changed while finalizing");
    } else if (obligation.status === "pending") {
      await tx
        .update(orderPaymentObligations)
        .set({
          status:
            obligation.expiresAt !== null && obligation.expiresAt <= now
              ? "superseded"
              : "cancelled",
          updatedAt: now,
        })
        .where(
          and(
            eq(orderPaymentObligations.id, obligation.id),
            eq(orderPaymentObligations.status, "pending"),
          ),
        );
    }

    if (isPrimary && !isLateCapture) {
      await tx
        .update(checkoutOrders)
        .set({
          status: "paid",
          helcimTransactionId: input.transactionId,
          providerPaymentId: input.transactionId,
          manualFulfillmentStatus:
            order.manualFulfillmentStatus === "payment_pending"
              ? "paid_pending_dispatch"
              : order.manualFulfillmentStatus,
          paidAt: order.paidAt ?? now,
          updatedAt: now,
        })
        .where(eq(checkoutOrders.id, order.id));
    }

    if (
      !isPrimary &&
      !isLateCapture &&
      obligation.purpose === "manual_shipping"
    ) {
      const [switched] = await tx
        .update(checkoutOrders)
        .set({
          fulfillmentMode: "manual_shipping",
          manualFulfillmentStatus: "paid_pending_dispatch",
          updatedAt: now,
        })
        .where(
          and(
            eq(checkoutOrders.id, order.id),
            eq(checkoutOrders.status, "paid"),
            eq(checkoutOrders.fulfillmentMode, "manual_pickup"),
            eq(checkoutOrders.manualFulfillmentStatus, "paid_pending_dispatch"),
          ),
        )
        .returning({ id: checkoutOrders.id });
      if (!switched) {
        throw new Error("Manual shipping payment lost the pickup race");
      }
    }

    if (!isPrimary && !isLateCapture) {
      await tx
        .update(productOrderCustomerDecisions)
        .set({
          status: "selected",
          selectedOutcome: "pay",
          selectedAt: now,
          consumedAt: now,
          processedAt: now,
          stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(productOrderCustomerDecisions.orderId, order.id),
            eq(productOrderCustomerDecisions.kind, "supplemental_payment"),
            eq(
              productOrderCustomerDecisions.scopeKey,
              `supplemental-payment/${obligation.id}`,
            ),
            eq(productOrderCustomerDecisions.status, "pending"),
          ),
        );
    }

    if (isLateCapture) {
      await reserveLateCaptureRefund(tx, {
        orderId: order.id,
        obligation,
        paymentTransactionId: createdTransaction.id,
        providerTransactionId: input.transactionId,
        amountCents: obligation.totalAmountCents,
        reason: lateCaptureReason,
      });
      await ensureRiskIncident(tx, {
        orderId: order.id,
        paymentTransactionId: createdTransaction.id,
        incidentKey: `late-capture/${createdTransaction.id}`,
        reasonCodes: [lateCaptureReasonCode],
        evidence: {
          providerTransactionId: input.transactionId,
          providerStatus: parsed.normalizedStatus,
        },
        now,
      });
      await setOrderReviewRequired(
        tx,
        order.id,
        [lateCaptureReasonCode],
        input.source,
        now,
      );
      return {
        transition: "state_conflict" as const,
        riskStatus: "review_required" as const,
        obligationId: obligation.id,
      };
    }

    if (assessment.status === "review_required") {
      await ensureRiskIncident(tx, {
        orderId: order.id,
        paymentTransactionId: createdTransaction.id,
        incidentKey: `payment/${createdTransaction.id}`,
        reasonCodes: assessment.reasonCodes,
        evidence: {
          providerTransactionId: input.transactionId,
          providerStatus: parsed.normalizedStatus,
          avsCode: assessment.avsCode,
          cvvCode: assessment.cvvCode,
        },
        now,
      });
      await setOrderReviewRequired(
        tx,
        order.id,
        assessment.reasonCodes,
        input.source,
        now,
      );
    } else if (isPrimary) {
      await clearOrderRiskIfNoActiveIncidents(tx, order.id, input.source, now);
    }

    const [aggregateRisk] = await tx
      .select({
        status: checkoutOrders.paymentRiskStatus,
        fulfillmentMode: checkoutOrders.fulfillmentMode,
      })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, order.id))
      .limit(1);
    if (
      aggregateRisk?.status === "cleared" &&
      aggregateRisk.fulfillmentMode === "automated_shipping"
    ) {
      const activated = await activateShipmentForPaidOrderInTransaction(
        tx,
        input.orderReference,
        now,
      );
      if (!activated) {
        throw new Error("Paid cleared shipment activation did not converge");
      }
    }
    return {
      transition: "applied" as const,
      riskStatus: aggregateRisk?.status ?? "review_required",
      obligationId: obligation.id,
    };
  });

  return finalized;
}

async function finalizeAuthoritativeLookupFailure(
  input: FinalizeProductPaymentInput & {
    authoritativeLookupFailure: NonNullable<
      FinalizeProductPaymentInput["authoritativeLookupFailure"]
    >;
  },
): Promise<InternalFinalizationResult> {
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "helcim"),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return internalResult({
        transition: "not_found",
        riskStatus: "review_required",
      });
    }

    const obligations = await tx
      .select()
      .from(orderPaymentObligations)
      .where(
        input.obligationId
          ? and(
              eq(orderPaymentObligations.id, input.obligationId),
              eq(orderPaymentObligations.orderId, order.id),
              isNull(orderPaymentObligations.quarantinedAt),
            )
          : and(
              eq(orderPaymentObligations.orderId, order.id),
              eq(orderPaymentObligations.purpose, "primary"),
              isNull(orderPaymentObligations.quarantinedAt),
            ),
      )
      .for("update")
      .limit(2);
    const obligation = obligations.length === 1 ? obligations[0]! : null;
    const callbackIdentity = input.authenticatedCallbackIdentity;
    const callbackIdentityMatches = Boolean(
      callbackIdentity &&
      callbackIdentity.orderReference === input.orderReference &&
      callbackIdentity.transactionId === input.transactionId &&
      callbackIdentity.obligationId === input.obligationId,
    );

    if (obligation && callbackIdentityMatches) {
      const [existingTransaction] = await tx
        .select()
        .from(orderPaymentTransactions)
        .where(
          and(
            eq(orderPaymentTransactions.provider, "helcim"),
            eq(
              orderPaymentTransactions.providerTransactionId,
              input.transactionId,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const classification = existingTransaction
        ? classifyHelcimTransaction({
            status: existingTransaction.providerStatus,
            transactionType: existingTransaction.providerType,
          })
        : null;
      const isPrimary = obligation.purpose === "primary";
      const immutableIdentityMatches = Boolean(
        existingTransaction &&
        existingTransaction.obligationId === obligation.id &&
        existingTransaction.amountCents === obligation.totalAmountCents &&
        existingTransaction.currency.toUpperCase() ===
          obligation.currency.toUpperCase() &&
        classification?.kind === "purchase" &&
        classification.successful &&
        obligation.status === "paid" &&
        order.status === "paid" &&
        (!isPrimary ||
          (order.helcimTransactionId === input.transactionId &&
            order.providerPaymentId === input.transactionId)),
      );
      if (immutableIdentityMatches) {
        return internalResult({
          transition: "already_applied",
          riskStatus: order.paymentRiskStatus,
          obligationId: obligation.id,
        });
      }
    }

    const reasonCodes = [
      "AUTHORITATIVE_PROVIDER_OUTCOME_UNKNOWN",
      `AUTHORITATIVE_PROVIDER_${input.authoritativeLookupFailure.toUpperCase()}`,
    ];
    const incidentKey = await activeOrNextOutcomeUnknownIncidentKey(
      tx,
      order.id,
      input.transactionId,
    );
    return recordConflictInTransaction(
      tx,
      order.id,
      input,
      reasonCodes,
      obligation?.id ?? input.obligationId,
      "outcome_unknown",
      incidentKey,
    );
  });
}

async function recordProductPaymentConflict(
  input: FinalizeProductPaymentInput,
  reasonCodes: string[],
  transition?: FinalizeProductPaymentResult["transition"],
): Promise<InternalFinalizationResult> {
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({ id: checkoutOrders.id })
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "helcim"),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!order) {
      return internalResult({
        transition: "not_found",
        riskStatus: "review_required",
      });
    }
    const incidentKey =
      transition === "outcome_unknown"
        ? await activeOrNextOutcomeUnknownIncidentKey(
            tx,
            order.id,
            input.transactionId,
          )
        : undefined;
    return recordConflictInTransaction(
      tx,
      order.id,
      input,
      reasonCodes,
      input.obligationId,
      transition,
      incidentKey,
    );
  });
}

async function recordConflictInTransaction(
  tx: DbTransaction,
  orderId: string,
  input: FinalizeProductPaymentInput,
  reasonCodes: string[],
  obligationId?: string,
  transition?: FinalizeProductPaymentResult["transition"],
  incidentKey?: string,
): Promise<InternalFinalizationResult> {
  const now = new Date();
  const incident = await ensureRiskIncident(tx, {
    orderId,
    incidentKey:
      incidentKey ??
      `conflict/${orderId}/${input.transactionId}/${[...reasonCodes]
        .sort()
        .join(",")}`,
    reasonCodes,
    evidence: {
      providerTransactionId: input.transactionId,
      ...(obligationId ? { obligationId } : {}),
    },
    now,
  });
  if (incident.status === "review_required") {
    await setOrderReviewRequired(tx, orderId, reasonCodes, input.source, now);
  }
  return {
    transition:
      transition ??
      (reasonCodes.some((reason) => reason.includes("TRANSACTION"))
        ? "transaction_conflict"
        : "state_conflict"),
    riskStatus: incident.status === "cleared" ? "cleared" : "review_required",
    ...(obligationId ? { obligationId } : {}),
  };
}

async function activeOrNextOutcomeUnknownIncidentKey(
  tx: DbTransaction,
  orderId: string,
  transactionId: string,
): Promise<string> {
  const base = `provider-outcome-unknown/${orderId}/${transactionId}`;
  const prefix = `${base}/`;
  const [latest] = await tx
    .select({
      incidentKey: productPaymentRiskIncidents.incidentKey,
      status: productPaymentRiskIncidents.status,
    })
    .from(productPaymentRiskIncidents)
    .where(
      and(
        eq(productPaymentRiskIncidents.orderId, orderId),
        sql`left(${productPaymentRiskIncidents.incidentKey}, char_length(${prefix})) = ${prefix}`,
      ),
    )
    .orderBy(desc(productPaymentRiskIncidents.createdAt))
    .limit(1);
  return latest && ["pending", "review_required"].includes(latest.status)
    ? latest.incidentKey
    : `${base}/${randomUUID()}`;
}

async function ensureRiskIncident(
  tx: DbTransaction,
  input: {
    orderId: string;
    paymentTransactionId?: string;
    incidentKey: string;
    reasonCodes: string[];
    evidence: Record<string, unknown>;
    now: Date;
  },
): Promise<RiskIncidentResult> {
  const [settings] = await tx
    .select({ version: shippingPolicySettings.policyVersion })
    .from(shippingPolicySettings)
    .where(eq(shippingPolicySettings.singletonKey, "default"))
    .limit(1);
  const [created] = await tx
    .insert(productPaymentRiskIncidents)
    .values({
      orderId: input.orderId,
      paymentTransactionId: input.paymentTransactionId,
      incidentKey: input.incidentKey,
      status: "review_required",
      reasonCodes: input.reasonCodes,
      providerEvidence: input.evidence,
      policyVersion: settings?.version ?? "unconfigured",
      alertedAt: null,
    })
    .onConflictDoNothing({ target: productPaymentRiskIncidents.incidentKey })
    .returning({
      id: productPaymentRiskIncidents.id,
      status: productPaymentRiskIncidents.status,
      alertedAt: productPaymentRiskIncidents.alertedAt,
    });
  const incident =
    created ??
    (
      await tx
        .select({
          id: productPaymentRiskIncidents.id,
          status: productPaymentRiskIncidents.status,
          alertedAt: productPaymentRiskIncidents.alertedAt,
        })
        .from(productPaymentRiskIncidents)
        .where(eq(productPaymentRiskIncidents.incidentKey, input.incidentKey))
        .limit(1)
    )[0];
  if (!incident)
    throw new Error("Payment-risk incident could not be persisted");
  if (incident.status === "review_required" && !incident.alertedAt) {
    await tx
      .insert(fulfillmentRiskAlertOutbox)
      .values({
        incidentId: incident.id,
        incidentKey: input.incidentKey,
        recipientDuty: "payment_fraud_owner",
        payload: {
          subject: "Product payment requires review",
          message: `Payment-risk incident ${incident.id} requires authoritative provider review before fulfillment.`,
          critical: true,
        },
        idempotencyKey: `risk-alert/${input.incidentKey}`,
      })
      .onConflictDoNothing({
        target: fulfillmentRiskAlertOutbox.idempotencyKey,
      });
  }
  return incident;
}

async function setOrderReviewRequired(
  tx: DbTransaction,
  orderId: string,
  reasonCodes: string[],
  source: FinalizeProductPaymentInput["source"],
  now: Date,
): Promise<void> {
  await tx
    .update(checkoutOrders)
    .set({
      paymentRiskStatus: "review_required",
      paymentRiskAssessedAt: now,
      paymentRiskSource: source,
      fraudClassification: "high",
      fraudRiskReasons: reasonCodes,
      fraudClearedAt: null,
      fulfillmentClearedAt: null,
      updatedAt: now,
    })
    .where(eq(checkoutOrders.id, orderId));
}

async function clearOrderRiskIfNoActiveIncidents(
  tx: DbTransaction,
  orderId: string,
  source: FinalizeProductPaymentInput["source"],
  now: Date,
): Promise<void> {
  const [activeIncident] = await tx
    .select({ id: productPaymentRiskIncidents.id })
    .from(productPaymentRiskIncidents)
    .where(
      and(
        eq(productPaymentRiskIncidents.orderId, orderId),
        inArray(productPaymentRiskIncidents.status, [
          "pending",
          "review_required",
        ]),
      ),
    )
    .limit(1);
  if (activeIncident) return;
  await tx
    .update(checkoutOrders)
    .set({
      paymentRiskStatus: "cleared",
      paymentRiskAssessedAt: now,
      paymentRiskSource: source,
      fraudClassification: "low",
      fraudRiskReasons: [],
      fraudClearedAt: now,
      updatedAt: now,
    })
    .where(eq(checkoutOrders.id, orderId));
}

async function reserveLateCaptureRefund(
  tx: DbTransaction,
  input: {
    orderId: string;
    obligation: typeof orderPaymentObligations.$inferSelect;
    paymentTransactionId: string;
    providerTransactionId: string;
    amountCents: number;
    reason:
      | "late_capture_after_manual_cancellation"
      | "late_capture_after_obsolete_address_change"
      | "late_capture_after_terminal_primary";
  },
): Promise<void> {
  const existing = await tx
    .select({ amountCents: productOrderRefunds.amountCents })
    .from(productOrderRefunds)
    .where(
      and(
        eq(
          productOrderRefunds.paymentTransactionId,
          input.paymentTransactionId,
        ),
        eq(productOrderRefunds.reason, input.reason),
        isNull(productOrderRefunds.fulfillmentQuarantinedAt),
      ),
    );
  const existingTotal = existing.reduce(
    (total, refund) => total + refund.amountCents,
    0,
  );
  if (existingTotal === input.amountCents) return;
  if (existingTotal !== 0) {
    throw new Error("Late-capture refund ledger is only partially reserved");
  }
  const components = [
    ["merchandise", input.obligation.merchandiseAmountCents],
    ["tax", input.obligation.taxAmountCents],
    ["outbound_shipping", input.obligation.shippingAmountCents],
  ] as const;
  const componentTotal = components.reduce(
    (total, [, amountCents]) => total + amountCents,
    0,
  );
  if (componentTotal !== input.amountCents) {
    throw new Error("Late-capture components do not equal the captured amount");
  }
  for (const [component, amountCents] of components) {
    if (amountCents <= 0) continue;
    const adjustmentKey = `late-capture-refund/${input.paymentTransactionId}/${component}`;
    const [adjustment] = await tx
      .insert(productOrderAdjustments)
      .values({
        orderId: input.orderId,
        direction: "refund",
        component,
        reason: "late_capture_after_terminal_obligation",
        sourceAddressRequestId:
          input.obligation.purpose === "address_increase"
            ? input.obligation.sourceReferenceId
            : null,
        amountCents,
        status: "reserved",
        idempotencyKey: adjustmentKey,
      })
      .onConflictDoNothing({ target: productOrderAdjustments.idempotencyKey })
      .returning({ id: productOrderAdjustments.id });
    const adjustmentId =
      adjustment?.id ??
      (
        await tx
          .select({ id: productOrderAdjustments.id })
          .from(productOrderAdjustments)
          .where(eq(productOrderAdjustments.idempotencyKey, adjustmentKey))
          .limit(1)
      )[0]?.id;
    if (!adjustmentId)
      throw new Error("Late-capture adjustment was not reserved");
    await tx
      .insert(productOrderRefunds)
      .values({
        orderId: input.orderId,
        paymentTransactionId: input.paymentTransactionId,
        originalTransactionId: input.providerTransactionId,
        idempotencyKey: semanticRefundUuid(adjustmentKey),
        kind: amountCents === input.amountCents ? "full" : "partial",
        reason: input.reason,
        amountCents,
        adjustmentId,
        automated: true,
        status: "queued",
      })
      .onConflictDoNothing({ target: productOrderRefunds.idempotencyKey });
  }
}

function classifyLateCaptureReason(input: {
  fulfillmentMode: string | null;
  obligationPurpose: string;
}): {
  reasonCode:
    | "LATE_CAPTURE_AFTER_MANUAL_CANCELLATION"
    | "LATE_CAPTURE_AFTER_OBSOLETE_ADDRESS_CHANGE"
    | "LATE_CAPTURE_AFTER_TERMINAL_PRIMARY";
  reason:
    | "late_capture_after_manual_cancellation"
    | "late_capture_after_obsolete_address_change"
    | "late_capture_after_terminal_primary";
} {
  if (input.obligationPurpose === "address_increase") {
    return {
      reasonCode: "LATE_CAPTURE_AFTER_OBSOLETE_ADDRESS_CHANGE",
      reason: "late_capture_after_obsolete_address_change",
    };
  }
  if (
    input.obligationPurpose === "manual_shipping" ||
    input.fulfillmentMode === "manual_pickup" ||
    input.fulfillmentMode === "manual_shipping"
  ) {
    return {
      reasonCode: "LATE_CAPTURE_AFTER_MANUAL_CANCELLATION",
      reason: "late_capture_after_manual_cancellation",
    };
  }
  return {
    reasonCode: "LATE_CAPTURE_AFTER_TERMINAL_PRIMARY",
    reason: "late_capture_after_terminal_primary",
  };
}

function isLatePaymentCapture(input: {
  obligation: typeof orderPaymentObligations.$inferSelect;
  order: typeof checkoutOrders.$inferSelect;
  now: Date;
}): boolean {
  return (
    ["cancelled", "superseded", "refunded"].includes(input.obligation.status) ||
    (input.obligation.expiresAt !== null &&
      input.obligation.expiresAt <= input.now) ||
    ["cancelled", "refunded"].includes(input.order.status) ||
    (input.obligation.purpose === "manual_shipping" &&
      ["dispatched", "cancelled"].includes(
        input.order.manualFulfillmentStatus ?? "",
      ))
  );
}

function parseProviderPurchase(input: FinalizeProductPaymentInput): {
  amountCents: number;
  currency: string;
  normalizedStatus: string;
  normalizedType: string;
} | null {
  const transactionType = text(input.data.transactionType ?? input.data.type);
  const status = text(
    input.data.status ??
      input.data.paymentStatus ??
      input.data.transactionStatus,
  );
  const originalTransactionId = text(input.data.originalTransactionId);
  const providerTransactionId = text(
    input.data.transactionId ?? input.data.cardTransactionId ?? input.data.id,
  );
  const amountCents = parseHelcimAmountCents(input.data.amount);
  const currency = text(input.data.currency)?.trim().toUpperCase();
  const classification = classifyHelcimTransaction({
    originalTransactionId,
    status,
    transactionType,
  });
  if (
    classification.kind !== "purchase" ||
    !classification.successful ||
    !classification.normalizedStatus ||
    !classification.normalizedType ||
    amountCents === null ||
    currency !== "CAD" ||
    providerTransactionId !== input.transactionId
  ) {
    return null;
  }
  return {
    amountCents,
    currency,
    normalizedStatus: classification.normalizedStatus,
    normalizedType: classification.normalizedType,
  };
}

function internalResult(
  result: FinalizeProductPaymentResult,
): InternalFinalizationResult {
  return result;
}

function inPrimaryPendingState(
  status: string,
  transactionId: string | null,
): boolean {
  return ["pending", "verification_failed"].includes(status) && !transactionId;
}

function inSupplementalPendingState(
  orderStatus: string,
  obligationStatus: string,
): boolean {
  return orderStatus === "paid" && obligationStatus === "pending";
}

function text(value: HelcimPayloadValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function parseHelcimAmountCents(
  value: HelcimPayloadValue | undefined,
): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function semanticRefundUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

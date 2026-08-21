import "server-only";

import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { assertConfiguredFulfillmentOwnerInTransaction } from "@/lib/shipping/configured-owner";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  checkoutOrders,
  fulfillmentOwnerActions,
  orderPaymentObligations,
} from "@/lib/private-db/schema";

/**
 * Owner reconciliation for a stuck Square supplemental payment-obligation
 * initialization.
 *
 * A supplemental obligation whose initialization lands in `failed` with a
 * non-deterministic `outcome_unknown` (or a prior `manual_review`) needs an
 * owner decision. Unlike the retired Helcim flow — which had to look up and
 * adopt a specific provider invoice — the Square payment-link mint is
 * idempotent via its DETERMINISTIC idempotency key (a pure function of
 * `obligation.id`): re-minting with the same key returns the same link rather
 * than creating a second one. (Square does NOT enforce uniqueness on
 * `reference_id`, which is only a merchant back-reference; the idempotency key
 * is the sole dedupe mechanism, so it must never be derived from anything
 * volatile.) So "adopt an existing link" and "reissue" collapse into a single
 * safe action: re-queue the obligation for the worker, which re-mints the exact
 * same link. The alternative is to take the obligation out of the automated
 * flow entirely (manual handoff).
 *
 * All the fund-safety controls of the retired flow are preserved: configured
 * fulfillment-owner identity (checked again inside the transaction), an exact
 * `initialization_state_version` fence, a row lock, and dual audit rows
 * (`fulfillment_owner_actions` + `admin_audit_logs`). The caller is responsible
 * for the outer authZ envelope (permission, origin, policy-enforcement gate,
 * and recent step-up authentication).
 */
export type SquarePaymentObligationReconciliationAction =
  | "reconcile_and_retry"
  | "record_manual_handoff";

export interface SquarePaymentObligationReconciliationInput {
  action: SquarePaymentObligationReconciliationAction;
  actorAdminUserId: string;
  evidenceReference: string;
  expectedStateVersion: number;
  obligationId: string;
  orderReference: string;
  rationale: string;
  stepUpAuthenticatedAt: Date;
  now?: Date;
}

/**
 * Deterministic step-up scope for a reconciliation request. Every field that
 * changes the effect of the action is bound, so a re-proof is required if any
 * of them changes.
 */
export function squarePaymentObligationReconciliationScope(input: {
  action: string;
  evidenceReference: string;
  expectedStateVersion: number;
  obligationId: string;
  orderId: string;
  rationale: string;
}): Record<string, unknown> {
  return {
    action: input.action,
    evidenceReference: input.evidenceReference,
    expectedStateVersion: input.expectedStateVersion,
    obligationId: input.obligationId,
    orderId: input.orderId,
    rationale: input.rationale,
  };
}

export async function reconcileSquarePaymentObligationInitialization(
  input: SquarePaymentObligationReconciliationInput,
): Promise<{
  id: string;
  initializationOutcome: string | null;
  initializationStatus: string;
  stateVersion: number;
}> {
  const now = input.now ?? new Date();
  const evidenceReference = input.evidenceReference.trim();
  const rationale = input.rationale.trim();
  assertInput(input, evidenceReference, rationale, now);

  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.actorAdminUserId,
    );
    const [current] = await tx
      .select({ obligation: orderPaymentObligations })
      .from(orderPaymentObligations)
      .innerJoin(
        checkoutOrders,
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
      )
      .where(reconciliationWhere(input))
      .for("update")
      .limit(1);
    if (!current) {
      throw new Error(
        "Payment obligation changed or no longer requires reconciliation",
      );
    }

    const retry = input.action !== "record_manual_handoff";
    const [updated] = await tx
      .update(orderPaymentObligations)
      .set({
        initializationLastError: retry
          ? null
          : `manual_handoff:${manualHandoffDigest(evidenceReference)}`,
        initializationLeaseExpiresAt: null,
        initializationLeaseOwner: null,
        initializationNextAttemptAt: now,
        initializationOutcome: retry ? null : "manual_review",
        initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
        initializationStatus: retry ? "initializing" : "failed",
        updatedAt: now,
      })
      .where(
        and(
          eq(orderPaymentObligations.id, input.obligationId),
          eq(
            orderPaymentObligations.initializationStateVersion,
            input.expectedStateVersion,
          ),
        ),
      )
      .returning({
        id: orderPaymentObligations.id,
        initializationOutcome: orderPaymentObligations.initializationOutcome,
        initializationStatus: orderPaymentObligations.initializationStatus,
        stateVersion: orderPaymentObligations.initializationStateVersion,
      });
    if (!updated) {
      throw new Error("Payment obligation reconciliation conflicted");
    }

    await tx.insert(fulfillmentOwnerActions).values({
      action: `payment_obligation_initialization_${input.action}`,
      adminUserId: input.actorAdminUserId,
      coolingOffUntil: now,
      evidence: { evidenceReference },
      executedAt: now,
      piiRedactionDueAt: current.obligation.piiRedactionDueAt,
      policyVersion: current.obligation.policyVersion,
      rationale,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
      targetId: input.obligationId,
      targetType: "payment_obligation",
    });
    await tx.insert(adminAuditLogs).values({
      action: `payment_obligation.initialization.${input.action}`,
      actorAdminUserId: input.actorAdminUserId,
      actorRole: "owner",
      domain: "fulfillment",
      metadata: {
        expectedStateVersion: input.expectedStateVersion,
        nextStateVersion: updated.stateVersion,
      },
      outcome: "success",
      targetId: input.obligationId,
      targetType: "payment_obligation",
    });
    return updated;
  });
}

function reconciliationWhere(
  input: SquarePaymentObligationReconciliationInput,
) {
  return and(
    eq(orderPaymentObligations.id, input.obligationId),
    eq(checkoutOrders.orderId, input.orderReference),
    eq(checkoutOrders.purpose, "product"),
    // The worker only re-claims supplemental obligations on a paid order, so
    // resetting one whose order is not paid would produce a benign stuck row.
    eq(checkoutOrders.status, "paid"),
    // Only supplemental obligations are minted through the payment-link worker
    // and can land in this stuck `initializing`→`failed` state. Fencing the
    // purpose here means this owner action can never re-queue (or touch the
    // state version of) the order's PRIMARY card obligation.
    inArray(orderPaymentObligations.purpose, [
      "manual_shipping",
      "address_increase",
    ]),
    eq(orderPaymentObligations.paymentProvider, "square"),
    eq(orderPaymentObligations.status, "pending"),
    eq(orderPaymentObligations.initializationStatus, "failed"),
    inArray(orderPaymentObligations.initializationOutcome, [
      "outcome_unknown",
      "manual_review",
    ]),
    eq(
      orderPaymentObligations.initializationStateVersion,
      input.expectedStateVersion,
    ),
    isNull(orderPaymentObligations.quarantinedAt),
    isNull(checkoutOrders.fulfillmentQuarantinedAt),
  );
}

function assertInput(
  input: SquarePaymentObligationReconciliationInput,
  evidenceReference: string,
  rationale: string,
  now: Date,
): void {
  if (
    !Number.isInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 1
  ) {
    throw new Error("Payment obligation state version is invalid");
  }
  if (!input.obligationId || !input.orderReference) {
    throw new Error("Payment obligation reconciliation identity is missing");
  }
  if (
    input.action !== "reconcile_and_retry" &&
    input.action !== "record_manual_handoff"
  ) {
    throw new Error("Payment obligation reconciliation action is invalid");
  }
  if (evidenceReference.length < 6 || evidenceReference.length > 500) {
    throw new Error("Provider reconciliation evidence reference is invalid");
  }
  if (rationale.length < 10 || rationale.length > 1_000) {
    throw new Error("Provider reconciliation rationale is invalid");
  }
  if (
    input.stepUpAuthenticatedAt.getTime() > now.getTime() + 1_000 ||
    now.getTime() - input.stepUpAuthenticatedAt.getTime() > 5 * 60_000
  ) {
    throw new Error("Recent step-up authentication is required");
  }
}

function manualHandoffDigest(evidenceReference: string): string {
  return createHash("sha256").update(evidenceReference, "utf8").digest("hex");
}

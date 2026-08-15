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
import { createLiveHelcimGateway, type HelcimGateway } from "./helcim-gateway";
import {
  buildPaymentObligationInvoicePlan,
  manualPaymentInitializationHandoffEvidence,
  paymentInitializationProviderEvidenceIsValid,
  paymentObligationInvoiceNumber,
  type PaymentInitializationProviderEvidence,
  verifyHelcimInvoiceAbsence,
  verifyHelcimInvoiceForObligation,
} from "./product-payment-invoice-plan";

export type PaymentObligationInitializationReconciliationAction =
  | "adopt_invoice"
  | "confirm_no_payable_state_and_reissue"
  | "record_manual_handoff";

interface ReconciliationIdentityInput {
  action: PaymentObligationInitializationReconciliationAction;
  expectedStateVersion: number;
  obligationId: string;
  orderReference: string;
  providerInvoiceId?: number;
  providerInvoiceNumber?: string;
}

export interface PreparedPaymentObligationInitializationReconciliation {
  action: PaymentObligationInitializationReconciliationAction;
  expectedStateVersion: number;
  obligationId: string;
  orderReference: string;
  providerEvidence: PaymentInitializationProviderEvidence;
}

export interface PaymentObligationInitializationReconciliationInput extends ReconciliationIdentityInput {
  actorAdminUserId: string;
  evidenceReference: string;
  providerEvidence: PaymentInitializationProviderEvidence;
  rationale: string;
  stepUpAuthenticatedAt: Date;
  now?: Date;
}

export async function preparePaymentObligationInitializationReconciliation(
  input: ReconciliationIdentityInput & {
    gateway?: HelcimGateway;
    now?: Date;
  },
): Promise<PreparedPaymentObligationInitializationReconciliation> {
  assertIdentityInput(input);
  const now = input.now ?? new Date();
  const current = await loadReconciliationState(input);
  const plan = buildPaymentObligationInvoicePlan(
    current.obligation,
    current.order,
  );

  let providerEvidence: PaymentInitializationProviderEvidence;
  if (input.action === "record_manual_handoff") {
    providerEvidence = manualPaymentInitializationHandoffEvidence(now);
  } else {
    const gateway = input.gateway ?? createLiveHelcimGateway();
    if (input.action === "adopt_invoice") {
      const providerInvoiceId = positiveInvoiceId(input.providerInvoiceId);
      if (!gateway.getInvoice) {
        throw new Error("Certified Helcim invoice lookup is unavailable");
      }
      const invoice = await gateway.getInvoice(providerInvoiceId);
      providerEvidence = verifyHelcimInvoiceForObligation({
        expectedInvoiceId: providerInvoiceId,
        expectedInvoiceNumber: input.providerInvoiceNumber,
        invoice,
        observedAt: now,
        plan,
      });
      assertAdoptionCompatible(current.obligation, providerEvidence);
    } else {
      assertAbsenceReissueEligible(current.obligation, now);
      if (!gateway.getInvoicesByNumber) {
        throw new Error("Certified Helcim exact invoice search is unavailable");
      }
      const invoiceNumber = paymentObligationInvoiceNumber(input.obligationId);
      const collection = await gateway.getInvoicesByNumber(invoiceNumber);
      providerEvidence = verifyHelcimInvoiceAbsence({
        collection,
        invoiceNumber,
        observedAt: now,
      });
    }
  }

  return {
    action: input.action,
    expectedStateVersion: input.expectedStateVersion,
    obligationId: input.obligationId,
    orderReference: input.orderReference,
    providerEvidence,
  };
}

export async function reconcilePaymentObligationInitialization(
  input: PaymentObligationInitializationReconciliationInput,
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
      .select({
        obligation: orderPaymentObligations,
        order: {
          lineItems: checkoutOrders.lineItems,
          orderReference: checkoutOrders.orderId,
          promotionCode: checkoutOrders.promotionCode,
          promotionDiscountCents: checkoutOrders.promotionDiscountCents,
          shippingAmountCents: checkoutOrders.shippingAmountCents,
        },
      })
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
    const plan = buildPaymentObligationInvoicePlan(
      current.obligation,
      current.order,
    );
    validatePreparedEvidence(input, current.obligation, plan, now);

    const retry = input.action !== "record_manual_handoff";
    const adoptedInvoice =
      input.providerEvidence.kind === "invoice_verified"
        ? {
            providerInvoiceId: input.providerEvidence.invoiceId,
            providerInvoiceNumber: input.providerEvidence.invoiceNumber,
          }
        : null;
    const [updated] = await tx
      .update(orderPaymentObligations)
      .set({
        ...(adoptedInvoice ?? {}),
        initializationLastError: retry
          ? null
          : `manual_handoff:${input.providerEvidence.evidenceHash}`,
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
    if (!updated)
      throw new Error("Payment obligation reconciliation conflicted");

    await tx.insert(fulfillmentOwnerActions).values({
      action: `payment_obligation_initialization_${input.action}`,
      adminUserId: input.actorAdminUserId,
      coolingOffUntil: now,
      evidence: {
        evidenceReference,
        providerEvidence: input.providerEvidence,
      },
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
        providerEvidenceHash: input.providerEvidence.evidenceHash,
        providerEvidenceKind: input.providerEvidence.kind,
      },
      outcome: "success",
      targetId: input.obligationId,
      targetType: "payment_obligation",
    });
    return updated;
  });
}

async function loadReconciliationState(input: ReconciliationIdentityInput) {
  const [current] = await getPrivateDb()
    .select({
      obligation: orderPaymentObligations,
      order: {
        lineItems: checkoutOrders.lineItems,
        orderReference: checkoutOrders.orderId,
        promotionCode: checkoutOrders.promotionCode,
        promotionDiscountCents: checkoutOrders.promotionDiscountCents,
        shippingAmountCents: checkoutOrders.shippingAmountCents,
      },
    })
    .from(orderPaymentObligations)
    .innerJoin(
      checkoutOrders,
      eq(orderPaymentObligations.orderId, checkoutOrders.id),
    )
    .where(reconciliationWhere(input))
    .limit(1);
  if (!current) {
    throw new Error(
      "Payment obligation changed or no longer requires reconciliation",
    );
  }
  return current;
}

function reconciliationWhere(input: ReconciliationIdentityInput) {
  return and(
    eq(orderPaymentObligations.id, input.obligationId),
    eq(checkoutOrders.orderId, input.orderReference),
    eq(checkoutOrders.purpose, "product"),
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
  );
}

function validatePreparedEvidence(
  input: PaymentObligationInitializationReconciliationInput,
  obligation: typeof orderPaymentObligations.$inferSelect,
  plan: ReturnType<typeof buildPaymentObligationInvoicePlan>,
  now: Date,
) {
  if (
    !paymentInitializationProviderEvidenceIsValid(input.providerEvidence, now)
  ) {
    throw new Error("Provider reconciliation evidence is stale or invalid");
  }
  if (input.action === "adopt_invoice") {
    if (input.providerEvidence.kind !== "invoice_verified") {
      throw new Error(
        "Verified Helcim invoice evidence is required for adoption",
      );
    }
    if (
      input.providerEvidence.amountCents !== obligation.totalAmountCents ||
      input.providerEvidence.currency !== "CAD" ||
      input.providerEvidence.notesHash !== hashText(plan.notes)
    ) {
      throw new Error(
        "Verified Helcim invoice evidence no longer matches the obligation",
      );
    }
    assertAdoptionCompatible(obligation, input.providerEvidence);
    return;
  }
  if (input.action === "confirm_no_payable_state_and_reissue") {
    if (input.providerEvidence.kind !== "invoice_absent") {
      throw new Error(
        "Verified Helcim invoice absence is required for reissue",
      );
    }
    assertAbsenceReissueEligible(obligation, now);
    if (input.providerEvidence.invoiceNumber !== plan.invoiceNumber) {
      throw new Error(
        "Helcim absence evidence targets a different invoice number",
      );
    }
    return;
  }
  if (input.providerEvidence.kind !== "manual_handoff") {
    throw new Error("Manual-handoff evidence is invalid");
  }
}

function assertAdoptionCompatible(
  current: Pick<
    typeof orderPaymentObligations.$inferSelect,
    "providerInvoiceId" | "providerInvoiceNumber"
  >,
  evidence: Extract<
    PaymentInitializationProviderEvidence,
    { kind: "invoice_verified" }
  >,
) {
  if (
    current.providerInvoiceId !== null &&
    current.providerInvoiceNumber !== null
  ) {
    throw new Error(
      "A recorded invoice cannot be adopted again; ambiguous HelcimPay initialization requires manual handoff",
    );
  }
  if (
    (current.providerInvoiceId !== null &&
      current.providerInvoiceId !== evidence.invoiceId) ||
    (current.providerInvoiceNumber !== null &&
      current.providerInvoiceNumber !== evidence.invoiceNumber)
  ) {
    throw new Error(
      "Helcim invoice identity conflicts with immutable local evidence",
    );
  }
}

function assertAbsenceReissueEligible(
  current: Pick<
    typeof orderPaymentObligations.$inferSelect,
    | "initializationPayloadHash"
    | "providerInvoiceId"
    | "providerInvoiceNumber"
    | "updatedAt"
  >,
  now: Date,
) {
  if (
    current.providerInvoiceId !== null ||
    current.providerInvoiceNumber !== null
  ) {
    throw new Error(
      "A recorded invoice may already have an active HelcimPay session; use manual handoff instead of reinitializing it",
    );
  }
  if (!current.initializationPayloadHash?.startsWith("v2:")) {
    throw new Error(
      "Legacy ambiguous invoice creation lacks a deterministic provider identity; adopt a verified invoice or use manual handoff",
    );
  }
  if (now.getTime() - current.updatedAt.getTime() < 5 * 60_000) {
    throw new Error(
      "Wait five minutes before using authoritative invoice-absence reissue",
    );
  }
}

function assertIdentityInput(input: ReconciliationIdentityInput): void {
  if (
    !Number.isInteger(input.expectedStateVersion) ||
    input.expectedStateVersion < 1
  ) {
    throw new Error("Payment obligation state version is invalid");
  }
  if (!input.obligationId || !input.orderReference) {
    throw new Error("Payment obligation reconciliation identity is missing");
  }
}

function assertInput(
  input: PaymentObligationInitializationReconciliationInput,
  evidenceReference: string,
  rationale: string,
  now: Date,
): void {
  assertIdentityInput(input);
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

function positiveInvoiceId(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error("Exact Helcim invoice ID is required for adoption");
  }
  return value!;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

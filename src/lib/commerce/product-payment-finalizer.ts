import "server-only";

import { and, eq } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  orderPaymentTransactions,
  productPaymentRiskIncidents,
  shippingPolicySettings,
  type PaymentRiskStatus,
} from "@/lib/private-db/schema";

import {
  assessCertifiedCardEvidence,
  classifyHelcimTransaction,
} from "./helcim-contract";
import type { HelcimPayloadValue } from "./helcim-types";

export interface FinalizeProductPaymentInput {
  orderReference: string;
  transactionId: string;
  source: "client_callback" | "helcim_api";
  data: Record<string, HelcimPayloadValue>;
}

export interface FinalizeProductPaymentResult {
  transition:
    | "applied"
    | "already_applied"
    | "state_conflict"
    | "transaction_conflict"
    | "not_found";
  riskStatus: PaymentRiskStatus;
}

export async function finalizeProductPayment(
  input: FinalizeProductPaymentInput,
): Promise<FinalizeProductPaymentResult> {
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
    amountCents === null ||
    currency !== "CAD" ||
    providerTransactionId !== input.transactionId
  ) {
    return recordProductPaymentConflict(input.orderReference, [
      "UNRECOGNIZED_PURCHASE_CONTRACT",
    ]);
  }
  const assessment = assessCertifiedCardEvidence({
    avsCode: text(
      input.data.avsResponse ?? input.data.avsResult ?? input.data.avs,
    ),
    cvvCode: text(
      input.data.cvvResponse ?? input.data.cvvResult ?? input.data.cvv,
    ),
  });
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ order: checkoutOrders, obligation: orderPaymentObligations })
      .from(checkoutOrders)
      .innerJoin(
        orderPaymentObligations,
        and(
          eq(orderPaymentObligations.orderId, checkoutOrders.id),
          eq(orderPaymentObligations.purpose, "primary"),
        ),
      )
      .where(
        and(
          eq(checkoutOrders.orderId, input.orderReference),
          eq(checkoutOrders.purpose, "product"),
          eq(checkoutOrders.paymentProvider, "helcim"),
        ),
      )
      .for("update")
      .limit(1);
    if (!row) return { transition: "not_found", riskStatus: "review_required" };
    if (
      amountCents !== row.obligation.totalAmountCents ||
      currency !== row.obligation.currency.toUpperCase()
    ) {
      await insertRiskIncident(tx, {
        orderId: row.order.id,
        reasonCodes: ["PAYMENT_AMOUNT_OR_CURRENCY_MISMATCH"],
        evidence: {},
        now,
      });
      await tx
        .update(checkoutOrders)
        .set({ paymentRiskStatus: "review_required", updatedAt: now })
        .where(eq(checkoutOrders.id, row.order.id));
      return {
        transition: "state_conflict",
        riskStatus: "review_required",
      };
    }
    let transition: FinalizeProductPaymentResult["transition"];
    if (
      ["pending", "verification_failed"].includes(row.order.status) &&
      !row.order.helcimTransactionId
    ) {
      transition = "applied";
    } else if (
      row.order.status === "paid" &&
      row.order.helcimTransactionId === input.transactionId
    ) {
      transition = "already_applied";
    } else if (row.order.status === "paid") {
      transition = "transaction_conflict";
    } else {
      transition = "state_conflict";
    }
    if (
      transition === "transaction_conflict" ||
      transition === "state_conflict"
    ) {
      await insertRiskIncident(tx, {
        orderId: row.order.id,
        reasonCodes: [transition.toUpperCase()],
        evidence: {},
        now,
      });
      return { transition, riskStatus: "review_required" };
    }

    const [existingTransaction] = await tx
      .select({
        id: orderPaymentTransactions.id,
        obligationId: orderPaymentTransactions.obligationId,
        amountCents: orderPaymentTransactions.amountCents,
        currency: orderPaymentTransactions.currency,
      })
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
    if (
      existingTransaction &&
      (existingTransaction.obligationId !== row.obligation.id ||
        existingTransaction.amountCents !== row.obligation.totalAmountCents ||
        existingTransaction.currency !== row.obligation.currency)
    ) {
      await insertRiskIncident(tx, {
        orderId: row.order.id,
        reasonCodes: ["PROVIDER_TRANSACTION_IDENTITY_CONFLICT"],
        evidence: {},
        now,
      });
      return {
        transition: "transaction_conflict",
        riskStatus: "review_required",
      };
    }
    let paymentTransactionId = existingTransaction?.id;
    if (!existingTransaction) {
      const [createdTransaction] = await tx
        .insert(orderPaymentTransactions)
        .values({
          obligationId: row.obligation.id,
          provider: "helcim",
          providerTransactionId: input.transactionId,
          amountCents: row.obligation.totalAmountCents,
          currency: row.obligation.currency,
          originatingIpCiphertext: row.order.refundOriginIpCiphertext,
          providerType: classification.normalizedType!,
          providerStatus: classification.normalizedStatus!,
          avsCode: assessment.avsCode,
          cvvCode: assessment.cvvCode,
          riskStatus: assessment.status,
          riskReasonCodes: assessment.reasonCodes,
          capturedAt: now,
        })
        .returning({ id: orderPaymentTransactions.id });
      paymentTransactionId = createdTransaction?.id;
    }
    await tx
      .update(orderPaymentObligations)
      .set({ status: "paid", paidAt: now, updatedAt: now })
      .where(eq(orderPaymentObligations.id, row.obligation.id));
    await tx
      .update(checkoutOrders)
      .set({
        status: "paid",
        helcimTransactionId: input.transactionId,
        providerPaymentId: input.transactionId,
        paidAt: row.order.paidAt ?? now,
        paymentRiskStatus: assessment.status,
        paymentRiskAssessedAt: now,
        paymentRiskSource: input.source,
        fraudClassification: assessment.status === "cleared" ? "low" : "high",
        fraudRiskReasons: assessment.reasonCodes,
        fraudClearedAt: assessment.status === "cleared" ? now : null,
        updatedAt: now,
      })
      .where(eq(checkoutOrders.id, row.order.id));
    if (assessment.status === "review_required") {
      await insertRiskIncident(tx, {
        orderId: row.order.id,
        paymentTransactionId,
        reasonCodes: assessment.reasonCodes,
        evidence: { avsCode: assessment.avsCode, cvvCode: assessment.cvvCode },
        now,
      });
    }
    return { transition, riskStatus: assessment.status };
  });
}

async function recordProductPaymentConflict(
  orderReference: string,
  reasonCodes: string[],
): Promise<FinalizeProductPaymentResult> {
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select({ id: checkoutOrders.id })
      .from(checkoutOrders)
      .where(
        and(
          eq(checkoutOrders.orderId, orderReference),
          eq(checkoutOrders.purpose, "product"),
        ),
      )
      .limit(1);
    if (!order)
      return { transition: "not_found", riskStatus: "review_required" };
    await tx
      .update(checkoutOrders)
      .set({ paymentRiskStatus: "review_required", updatedAt: now })
      .where(eq(checkoutOrders.id, order.id));
    await insertRiskIncident(tx, {
      orderId: order.id,
      reasonCodes,
      evidence: {},
      now,
    });
    return { transition: "state_conflict", riskStatus: "review_required" };
  });
}

async function insertRiskIncident(
  tx: Parameters<
    Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
  >[0],
  input: {
    orderId: string;
    paymentTransactionId?: string;
    reasonCodes: string[];
    evidence: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  const [settings] = await tx
    .select({ version: shippingPolicySettings.policyVersion })
    .from(shippingPolicySettings)
    .where(eq(shippingPolicySettings.singletonKey, "default"))
    .limit(1);
  await tx
    .insert(productPaymentRiskIncidents)
    .values({
      orderId: input.orderId,
      paymentTransactionId: input.paymentTransactionId,
      incidentKey: input.paymentTransactionId
        ? `payment/${input.paymentTransactionId}`
        : `conflict/${input.orderId}/${[...input.reasonCodes].sort().join(",")}`,
      status: "review_required",
      reasonCodes: input.reasonCodes,
      providerEvidence: input.evidence,
      policyVersion: settings?.version ?? "unconfigured",
      alertedAt: input.now,
    })
    .onConflictDoNothing({ target: productPaymentRiskIncidents.incidentKey });
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

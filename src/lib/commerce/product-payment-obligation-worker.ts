import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { HelcimApiError } from "./helcim-client";
import { createLiveHelcimGateway, type HelcimGateway } from "./helcim-gateway";
import {
  finalizeInitializingPaymentObligation,
  markPaymentObligationInitializationFailed,
  recordPaymentObligationInitializationInvoice,
} from "./order-store";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
} from "@/lib/private-db/schema";
import { paymentObligationMatchesConfiguredHelcimContract } from "./helcim-certified-contract";
import { assertHelcimProductPaymentsCertificationInTransaction } from "@/lib/shipping/readiness";
import { paymentObligationInitializationProviderPhase } from "./product-payment-obligation-initialization-plan";
import {
  buildPaymentObligationInvoicePlan,
  paymentObligationInitializationPayloadHash,
} from "./product-payment-invoice-plan";

const LEASE_MS = 5 * 60_000;

type Obligation = typeof orderPaymentObligations.$inferSelect;

export interface PaymentObligationInitializationResult {
  claimed: number;
  succeeded: number;
  failed: number;
  outcomeUnknown: number;
}

export async function runPaymentObligationInitializationWorker(
  input: {
    now?: Date;
    limit?: number;
    gateway?: HelcimGateway;
  } = {},
): Promise<PaymentObligationInitializationResult> {
  const now = input.now ?? new Date();
  const claims = await claimPaymentObligationInitializations(
    Math.max(1, Math.min(input.limit ?? 10, 50)),
    now,
  );
  const result: PaymentObligationInitializationResult = {
    claimed: claims.length,
    succeeded: 0,
    failed: 0,
    outcomeUnknown: 0,
  };
  const gateway = input.gateway ?? createLiveHelcimGateway();
  for (const claim of claims) {
    const outcome = await processClaim(claim, gateway);
    result[outcome] += 1;
  }
  return result;
}

async function claimPaymentObligationInitializations(
  limit: number,
  now: Date,
): Promise<ClaimedInitialization[]> {
  return getPrivateDb().transaction(async (tx) => {
    const abandonedClaims = await tx
      .select({ id: orderPaymentObligations.id })
      .from(orderPaymentObligations)
      .where(
        and(
          eq(orderPaymentObligations.status, "pending"),
          eq(orderPaymentObligations.initializationStatus, "initializing"),
          eq(orderPaymentObligations.initializationOutcome, "claimed"),
          lte(orderPaymentObligations.initializationLeaseExpiresAt, now),
          isNull(orderPaymentObligations.quarantinedAt),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(limit);
    if (abandonedClaims.length) {
      await tx
        .update(orderPaymentObligations)
        .set({
          initializationStatus: "failed",
          initializationOutcome: "outcome_unknown",
          initializationLastError:
            "Initialization lease expired after provider execution may have started",
          initializationLeaseOwner: null,
          initializationLeaseExpiresAt: null,
          initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          inArray(
            orderPaymentObligations.id,
            abandonedClaims.map(({ id }) => id),
          ),
        );
    }

    const candidates = await tx
      .select({ obligation: orderPaymentObligations })
      .from(orderPaymentObligations)
      .innerJoin(
        checkoutOrders,
        eq(orderPaymentObligations.orderId, checkoutOrders.id),
      )
      .where(
        and(
          eq(orderPaymentObligations.status, "pending"),
          eq(orderPaymentObligations.initializationStatus, "initializing"),
          isNull(orderPaymentObligations.initializationOutcome),
          lte(orderPaymentObligations.initializationNextAttemptAt, now),
          isNull(orderPaymentObligations.quarantinedAt),
          isNull(checkoutOrders.fulfillmentQuarantinedAt),
          or(
            and(
              eq(orderPaymentObligations.purpose, "primary"),
              eq(checkoutOrders.status, "pending"),
            ),
            and(
              sql`${orderPaymentObligations.purpose} <> 'primary'`,
              eq(checkoutOrders.status, "paid"),
              or(
                sql`${orderPaymentObligations.purpose} <> 'manual_shipping'`,
                sql`coalesce(${checkoutOrders.manualFulfillmentStatus}, '') not in ('dispatched', 'cancelled')`,
              ),
            ),
          ),
          or(
            isNull(orderPaymentObligations.expiresAt),
            sql`${orderPaymentObligations.expiresAt} > ${now}`,
          ),
        ),
      )
      .orderBy(orderPaymentObligations.createdAt)
      .for("update", { skipLocked: true })
      .limit(Math.max(0, limit - abandonedClaims.length));
    const claims: ClaimedInitialization[] = [];
    for (const { obligation: candidate } of candidates) {
      const leaseOwner = randomUUID();
      const [claimed] = await tx
        .update(orderPaymentObligations)
        .set({
          initializationOutcome: "claimed",
          initializationLeaseOwner: leaseOwner,
          initializationLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          initializationAttemptCount: sql`${orderPaymentObligations.initializationAttemptCount} + 1`,
          initializationPayloadHash:
            candidate.initializationPayloadHash ??
            paymentObligationInitializationPayloadHash(candidate),
          initializationStateVersion: sql`${orderPaymentObligations.initializationStateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(orderPaymentObligations.id, candidate.id),
            isNull(orderPaymentObligations.initializationOutcome),
          ),
        )
        .returning();
      if (claimed) claims.push({ obligation: claimed, leaseOwner });
    }
    return claims;
  });
}

interface ClaimedInitialization {
  obligation: Obligation;
  leaseOwner: string;
}

async function processClaim(
  claim: ClaimedInitialization,
  gateway: HelcimGateway,
): Promise<"succeeded" | "failed" | "outcomeUnknown"> {
  let expectedStateVersion = claim.obligation.initializationStateVersion;
  let phase = "load_order";
  try {
    phase = "certification_readiness";
    try {
      await getPrivateDb().transaction((tx) =>
        assertHelcimProductPaymentsCertificationInTransaction(tx),
      );
    } catch {
      throw new DeterministicInitializationError(
        "Certified Helcim owner evidence is unavailable or stale",
      );
    }
    phase = "load_order";
    const [order] = await getPrivateDb()
      .select({
        orderId: checkoutOrders.orderId,
        lineItems: checkoutOrders.lineItems,
        promotionCode: checkoutOrders.promotionCode,
        promotionDiscountCents: checkoutOrders.promotionDiscountCents,
        shippingAmountCents: checkoutOrders.shippingAmountCents,
      })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.id, claim.obligation.orderId))
      .limit(1);
    if (!order)
      throw new DeterministicInitializationError("Order was not found");
    if (claim.obligation.currency.toUpperCase() !== "CAD") {
      throw new DeterministicInitializationError(
        "Only certified CAD Helcim obligations may be initialized",
      );
    }
    if (
      !paymentObligationMatchesConfiguredHelcimContract(
        claim.obligation.disclosureSnapshot,
      )
    ) {
      throw new DeterministicInitializationError(
        "Payment obligation Helcim certification snapshot is missing or stale",
      );
    }
    phase = "build_invoice";
    const invoicePlan = buildPaymentObligationInvoicePlan(
      claim.obligation,
      order,
    );
    const providerPhase = paymentObligationInitializationProviderPhase(
      claim.obligation,
    );
    if (providerPhase === "manual_review") {
      throw new AmbiguousInitializationError(
        "Local Helcim invoice identity is incomplete",
      );
    }
    let invoice =
      providerPhase === "initialize_pay"
        ? {
            invoiceId: claim.obligation.providerInvoiceId!,
            invoiceNumber: claim.obligation.providerInvoiceNumber!,
          }
        : null;
    if (!invoice) {
      phase = "create_invoice";
      invoice = await gateway.createInvoice(invoicePlan.request);
      if (
        !Number.isSafeInteger(invoice.invoiceId) ||
        typeof invoice.invoiceNumber !== "string" ||
        !invoice.invoiceNumber.trim()
      ) {
        throw new AmbiguousInitializationError(
          "Helcim invoice response was incomplete",
        );
      }
      expectedStateVersion = await recordPaymentObligationInitializationInvoice(
        {
          obligationId: claim.obligation.id,
          helcimInvoiceId: invoice.invoiceId,
          helcimInvoiceNumber: invoice.invoiceNumber,
          expectedLeaseOwner: claim.leaseOwner,
          expectedStateVersion,
        },
      );
    }
    phase = "initialize_pay";
    const session = await gateway.initializePay({
      paymentType: "purchase",
      amount: claim.obligation.totalAmountCents / 100,
      currency: "CAD",
      invoiceNumber: invoice.invoiceNumber,
    });
    if (!session.checkoutToken?.trim() || !session.secretToken?.trim()) {
      throw new AmbiguousInitializationError(
        "Helcim payment session response was incomplete",
      );
    }
    await finalizeInitializingPaymentObligation({
      obligationId: claim.obligation.id,
      checkoutToken: session.checkoutToken,
      secretToken: session.secretToken,
      helcimInvoiceId: invoice.invoiceId,
      helcimInvoiceNumber: invoice.invoiceNumber,
      expectedLeaseOwner: claim.leaseOwner,
      expectedStateVersion,
    });
    return "succeeded";
  } catch (error) {
    const deterministic =
      error instanceof DeterministicInitializationError ||
      (error instanceof HelcimApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 409);
    await markPaymentObligationInitializationFailed({
      obligationId: claim.obligation.id,
      expectedLeaseOwner: claim.leaseOwner,
      expectedStateVersion,
      outcome: deterministic ? "failed" : "outcome_unknown",
      error: `${phase}: ${error instanceof Error ? error.message : "Provider outcome unknown"}`,
    });
    return deterministic ? "failed" : "outcomeUnknown";
  }
}

class DeterministicInitializationError extends Error {}
class AmbiguousInitializationError extends Error {}

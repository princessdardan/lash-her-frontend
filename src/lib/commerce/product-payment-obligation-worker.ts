import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  finalizeInitializingSquareObligation,
  markPaymentObligationInitializationFailed,
} from "./order-store";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
} from "@/lib/private-db/schema";
import { getSquareCommerceEnv } from "@/lib/env/private-checkout";
import { createSquareClient } from "@/lib/booking/square-client";

const LEASE_MS = 5 * 60_000;

type Obligation = typeof orderPaymentObligations.$inferSelect;

export interface PaymentObligationInitializationResult {
  claimed: number;
  succeeded: number;
  failed: number;
  outcomeUnknown: number;
}

/**
 * Initializes pending supplemental payment obligations by creating a Square
 * hosted payment link for each, then marking the obligation ready with the
 * link URL. Runs from the shipping cron.
 */
export async function runPaymentObligationInitializationWorker(
  input: {
    now?: Date;
    limit?: number;
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
  for (const claim of claims) {
    const outcome = await processClaim(claim);
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
          // Supplemental Square obligations only: primary product orders reserve
          // ready and charge synchronously through the Square card flow.
          eq(orderPaymentObligations.paymentProvider, "square"),
          sql`${orderPaymentObligations.purpose} <> 'primary'`,
          eq(checkoutOrders.status, "paid"),
          or(
            sql`${orderPaymentObligations.purpose} <> 'manual_shipping'`,
            sql`coalesce(${checkoutOrders.manualFulfillmentStatus}, '') not in ('dispatched', 'cancelled')`,
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
            obligationInitializationPayloadHash(candidate),
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
): Promise<"succeeded" | "failed" | "outcomeUnknown"> {
  const expectedStateVersion = claim.obligation.initializationStateVersion;
  let phase = "load_env";
  try {
    const env = getSquareCommerceEnv();
    if (env === null) {
      throw new DeterministicInitializationError(
        "Square commerce checkout is not enabled",
      );
    }
    if (claim.obligation.currency.toUpperCase() !== "CAD") {
      throw new DeterministicInitializationError(
        "Only CAD obligations may be initialized",
      );
    }

    phase = "create_payment_link";
    const client = createSquareClient({
      accessToken: env.accessToken,
      environment: env.environment,
    });
    const returnUrl = resolvePaymentReturnUrl();
    const { payment_link: paymentLink } = await client.createPaymentLink({
      idempotency_key: `obligation-link/${claim.obligation.id}`,
      order: {
        location_id: env.locationId,
        reference_id: claim.obligation.id,
        line_items: [
          {
            name: supplementalLineItemName(claim.obligation.purpose),
            quantity: "1",
            base_price_money: {
              amount: claim.obligation.totalAmountCents,
              currency: "CAD",
            },
          },
        ],
        metadata: {
          obligationId: claim.obligation.id,
          purpose: claim.obligation.purpose,
        },
      },
      checkout_options: {
        ...(returnUrl ? { redirect_url: returnUrl } : {}),
      },
    });

    if (!paymentLink.id?.trim() || !paymentLink.url?.trim()) {
      throw new AmbiguousInitializationError(
        "Square payment link response was incomplete",
      );
    }

    phase = "finalize";
    await finalizeInitializingSquareObligation({
      obligationId: claim.obligation.id,
      paymentLinkId: paymentLink.id,
      paymentLinkUrl: paymentLink.url,
      expectedLeaseOwner: claim.leaseOwner,
      expectedStateVersion,
    });
    return "succeeded";
  } catch (error) {
    const deterministic = error instanceof DeterministicInitializationError;
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

function obligationInitializationPayloadHash(obligation: Obligation): string {
  return `sq1:${createHash("sha256")
    .update(
      JSON.stringify({
        currency: obligation.currency.toUpperCase(),
        id: obligation.id,
        policyVersion: obligation.policyVersion,
        purpose: obligation.purpose,
        taxPolicyVersion: obligation.taxPolicyVersion,
        totalAmountCents: obligation.totalAmountCents,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

function supplementalLineItemName(purpose: string): string {
  return purpose === "manual_shipping"
    ? "Shipping"
    : purpose === "address_increase"
      ? "Shipping adjustment"
      : "Order payment";
}

function resolvePaymentReturnUrl(): string | null {
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (origin === undefined || origin.length === 0) {
    return null;
  }
  return new URL("/orders/payment-offer/paid", origin).toString();
}

class DeterministicInitializationError extends Error {}
class AmbiguousInitializationError extends Error {}

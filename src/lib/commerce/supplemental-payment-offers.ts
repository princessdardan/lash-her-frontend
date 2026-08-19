import "server-only";

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  orderPaymentObligations,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
} from "@/lib/private-db/schema";
import {
  hashShippingCustomerToken,
  issueShippingCustomerToken,
} from "@/lib/shipping/customer-token";
import { sendShippingCustomerLinkEmail } from "@/lib/shipping/customer-link-email";
import { hashCustomerDecisionConditions } from "@/lib/shipping/customer-decision-terms";
import { claimShippingCustomerLinkIssuance } from "@/lib/shipping/customer-link-issuance";

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export const SUPPLEMENTAL_PAYMENT_OFFER_COOKIE =
  "lh_supplemental_payment_offer";

export interface SupplementalPaymentOffer {
  amountCents: number;
  conditionsHash: string;
  currency: string;
  disclosureHash: string;
  disclosureSnapshot: Record<string, unknown> | null;
  expiresAt: Date;
  operationId: string;
  orderReference: string;
  purpose: "manual_shipping" | "address_increase";
  scopeKey: string;
}

export async function issueSupplementalPaymentOfferInTransaction(
  tx: DbTransaction,
  input: { obligationId: string; notificationOrigin: string; now?: Date },
): Promise<{ decisionId: string }> {
  const now = input.now ?? new Date();
  const origin = canonicalOrigin(input.notificationOrigin);
  const row = await loadOfferByObligation(tx, input.obligationId, now, true);
  if (!row) throw new Error("Supplemental payment offer is not payable");
  const scopeKey = `supplemental-payment/${row.obligation.id}`;
  const [previous] = await tx
    .select({
      id: productOrderCustomerDecisions.id,
      scopeVersion: productOrderCustomerDecisions.scopeVersion,
    })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(productOrderCustomerDecisions.orderId, row.order.id),
        eq(productOrderCustomerDecisions.scopeKey, scopeKey),
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
        eq(productOrderCustomerDecisions.orderId, row.order.id),
        eq(productOrderCustomerDecisions.scopeKey, scopeKey),
        eq(productOrderCustomerDecisions.status, "pending"),
      ),
    );
  const proposedConditions = offerConditions(row);
  const bearerToken = issueShippingCustomerToken();
  const [created] = await tx
    .insert(productOrderCustomerDecisions)
    .values({
      orderId: row.order.id,
      kind: "supplemental_payment",
      scopeKey,
      scopeVersion: (previous?.scopeVersion ?? 0) + 1,
      supersedesDecisionId: previous?.id,
      proposedConditions,
      proposedConditionsHash: hashCustomerDecisionConditions(
        scopeKey,
        proposedConditions,
      ),
      allowedOutcomes: ["pay"],
      tokenHash: hashShippingCustomerToken(bearerToken, "decision"),
      expiresAt: row.obligation.expiresAt!,
    })
    .returning({ id: productOrderCustomerDecisions.id });
  if (!created) throw new Error("Supplemental payment offer was not created");
  await claimShippingCustomerLinkIssuance(tx, {
    orderId: row.order.id,
    kind: "supplemental_payment",
    targetId: created.id,
    now,
  });
  const link = buildSupplementalPaymentOfferLink(origin, bearerToken);
  await sendShippingCustomerLinkEmail({
    to: row.order.customerEmail,
    orderReference: row.order.orderId,
    link,
    purpose: "payment-offer",
    idempotencyKey: `supplemental-payment-offer/${created.id}`,
    orderDatabaseId: row.order.id,
    now,
    executor: tx,
  });
  return { decisionId: created.id };
}

export function buildSupplementalPaymentOfferLink(
  notificationOrigin: string,
  bearerToken: string,
): string {
  const link = new URL(
    "/orders/payment-offer/exchange",
    canonicalOrigin(notificationOrigin),
  );
  link.searchParams.set("token", bearerToken);
  return link.toString();
}

export async function validateSupplementalPaymentOfferBearer(
  token: string,
): Promise<boolean> {
  const now = new Date();
  const [decision] = await getPrivateDb()
    .select({ id: productOrderCustomerDecisions.id })
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(
          productOrderCustomerDecisions.tokenHash,
          hashShippingCustomerToken(token, "decision"),
        ),
        eq(productOrderCustomerDecisions.kind, "supplemental_payment"),
        eq(productOrderCustomerDecisions.status, "pending"),
        gt(productOrderCustomerDecisions.expiresAt, now),
        isNull(productOrderCustomerDecisions.exchangedAt),
      ),
    )
    .limit(1);
  return Boolean(decision);
}

export async function exchangeSupplementalPaymentOffer(
  bearerToken: string,
): Promise<string | null> {
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [decision] = await tx
      .select()
      .from(productOrderCustomerDecisions)
      .where(
        and(
          eq(
            productOrderCustomerDecisions.tokenHash,
            hashShippingCustomerToken(bearerToken, "decision"),
          ),
          eq(productOrderCustomerDecisions.kind, "supplemental_payment"),
          eq(productOrderCustomerDecisions.status, "pending"),
          gt(productOrderCustomerDecisions.expiresAt, now),
          isNull(productOrderCustomerDecisions.exchangedAt),
        ),
      )
      .for("update")
      .limit(1);
    const obligationId = readObligationId(decision?.proposedConditions);
    const offer = obligationId
      ? await loadOfferByObligation(tx, obligationId, now, true)
      : null;
    if (
      !decision ||
      !obligationId ||
      !offer ||
      !decisionTermsMatchOffer(decision, offer)
    ) {
      return null;
    }
    const sessionToken = issueShippingCustomerToken();
    const [updated] = await tx
      .update(productOrderCustomerDecisions)
      .set({
        tokenHash: hashShippingCustomerToken(sessionToken, "decision"),
        exchangedAt: now,
        stateVersion: decision.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderCustomerDecisions.id, decision.id),
          eq(productOrderCustomerDecisions.stateVersion, decision.stateVersion),
          isNull(productOrderCustomerDecisions.exchangedAt),
        ),
      )
      .returning({ id: productOrderCustomerDecisions.id });
    return updated ? sessionToken : null;
  });
}

export async function getSupplementalPaymentOffer(
  sessionToken: string,
): Promise<SupplementalPaymentOffer | null> {
  const now = new Date();
  const [decision] = await getPrivateDb()
    .select()
    .from(productOrderCustomerDecisions)
    .where(
      and(
        eq(
          productOrderCustomerDecisions.tokenHash,
          hashShippingCustomerToken(sessionToken, "decision"),
        ),
        eq(productOrderCustomerDecisions.kind, "supplemental_payment"),
        eq(productOrderCustomerDecisions.status, "pending"),
        gt(productOrderCustomerDecisions.expiresAt, now),
        sql`${productOrderCustomerDecisions.exchangedAt} is not null`,
      ),
    )
    .limit(1);
  const obligationId = readObligationId(decision?.proposedConditions);
  if (!decision || !obligationId) return null;
  const row = await loadOfferByObligation(
    getPrivateDb(),
    obligationId,
    now,
    false,
  );
  if (!row || !decisionTermsMatchOffer(decision, row)) {
    return null;
  }
  const conditions = offerConditions(row);
  return {
    amountCents: row.obligation.totalAmountCents,
    conditionsHash: decision.proposedConditionsHash,
    currency: row.obligation.currency,
    disclosureHash: conditions.disclosureHash,
    disclosureSnapshot: row.obligation.disclosureSnapshot,
    expiresAt: row.obligation.expiresAt!,
    operationId: row.obligation.id,
    orderReference: row.order.orderId,
    purpose: row.obligation.purpose as "manual_shipping" | "address_increase",
    scopeKey: decision.scopeKey,
  };
}

export async function isSupplementalPaymentOfferSessionAuthorized(
  sessionToken: string,
  obligationId: string,
): Promise<boolean> {
  const offer = await getSupplementalPaymentOffer(sessionToken);
  return offer?.operationId === obligationId;
}

async function loadOfferByObligation(
  executor: Pick<ReturnType<typeof getPrivateDb>, "select">,
  obligationId: string,
  now: Date,
  lock: boolean,
) {
  const query = executor
    .select({ obligation: orderPaymentObligations, order: checkoutOrders })
    .from(orderPaymentObligations)
    .innerJoin(
      checkoutOrders,
      eq(orderPaymentObligations.orderId, checkoutOrders.id),
    )
    .where(
      and(
        eq(orderPaymentObligations.id, obligationId),
        sql`${orderPaymentObligations.purpose} in ('manual_shipping', 'address_increase')`,
        eq(orderPaymentObligations.status, "pending"),
        gt(orderPaymentObligations.expiresAt, now),
        isNull(orderPaymentObligations.quarantinedAt),
        eq(checkoutOrders.status, "paid"),
        isNull(checkoutOrders.fulfillmentQuarantinedAt),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) return null;
  if (row.obligation.purpose === "manual_shipping") {
    return row.order.fulfillmentMode === "manual_pickup" &&
      row.order.manualFulfillmentStatus === "paid_pending_dispatch"
      ? row
      : null;
  }
  if (!row.obligation.sourceReferenceId) return null;
  const [request] = await executor
    .select({ id: productOrderAddressChangeRequests.id })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(
          productOrderAddressChangeRequests.id,
          row.obligation.sourceReferenceId,
        ),
        eq(productOrderAddressChangeRequests.orderId, row.order.id),
        eq(
          productOrderAddressChangeRequests.supplementalObligationId,
          row.obligation.id,
        ),
        eq(productOrderAddressChangeRequests.status, "approved"),
        eq(
          productOrderAddressChangeRequests.reconciliationState,
          "awaiting_supplemental_payment",
        ),
      ),
    )
    .limit(1);
  return request ? row : null;
}

function offerConditions(
  row: NonNullable<Awaited<ReturnType<typeof loadOfferByObligation>>>,
) {
  return {
    obligationId: row.obligation.id,
    purpose: row.obligation.purpose,
    amountCents: row.obligation.totalAmountCents,
    currency: row.obligation.currency,
    expiresAt: row.obligation.expiresAt!.toISOString(),
    policyVersion: row.obligation.policyVersion,
    taxPolicyVersion: row.obligation.taxPolicyVersion,
    disclosureSnapshot: row.obligation.disclosureSnapshot,
    disclosureHash: hashCustomerDecisionConditions(
      "supplemental-payment-disclosure/v1",
      row.obligation.disclosureSnapshot ?? {},
    ),
  };
}

function decisionTermsMatchOffer(
  decision: typeof productOrderCustomerDecisions.$inferSelect,
  row: NonNullable<Awaited<ReturnType<typeof loadOfferByObligation>>>,
): boolean {
  const scopeKey = `supplemental-payment/${row.obligation.id}`;
  if (decision.scopeKey !== scopeKey) return false;
  const conditions = offerConditions(row);
  return (
    decision.proposedConditionsHash ===
      hashCustomerDecisionConditions(scopeKey, conditions) &&
    decision.proposedConditionsHash ===
      hashCustomerDecisionConditions(scopeKey, decision.proposedConditions)
  );
}

function readObligationId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).obligationId;
  return typeof id === "string" ? id : null;
}

function canonicalOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (!origin.startsWith("https://")) {
    throw new Error("Supplemental payment links require an HTTPS origin");
  }
  return origin;
}

export function supplementalPaymentPublicOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return canonicalOrigin(configured);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return canonicalOrigin(`https://${vercel}`);
  throw new Error("NEXT_PUBLIC_SITE_URL is required for payment offer links");
}

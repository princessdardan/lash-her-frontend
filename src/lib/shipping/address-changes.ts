import "server-only";

import { nanoid } from "nanoid";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminUsers,
  checkoutOrders,
  fulfillmentOwnerActions,
  orderPaymentObligations,
  productOrderAddressChangeRequests,
  productShipments,
  type CheckoutOrderShippingAddressSnapshot,
} from "@/lib/private-db/schema";
import {
  hashShippingCustomerToken,
  issueShippingCustomerToken,
} from "./customer-token";
import { loadShippingPolicyContext } from "./policy";
import { createChitChatsClient } from "./chitchats-client";
import { getChitChatsConfig } from "./config";
import { selectCustomerRates } from "./rates";
import { hasSignedCustomerDecision } from "./customer-decisions";
import { hashShippingQuoteToken, issueShippingQuoteToken } from "./quote-token";
import { normalizeChitChatsStatus, stripSignedLabelUrls } from "./status";
import type { ChitChatsShipment, ShippingRecipient } from "./types";
import { openProductShippingCase } from "./cases";

interface PreparedAddressChangeShipment {
  providerShipmentId: string;
  providerStatus: string;
  publicReference: string;
  selectedPostageType: string;
  selectedRateId: string;
  selectedRateAmountCents: number;
  deliveryMaxBusinessDays?: number;
  estimatedDeliveryAt?: string;
  signatureRequired: boolean;
  quoteExpiresAt: string;
  rawShipment: Record<string, unknown>;
}

export async function reconcileAddressChangePostage(
  requestId: string,
): Promise<void> {
  const db = getPrivateDb();
  const [row] = await db
    .select({
      request: productOrderAddressChangeRequests,
      order: checkoutOrders,
      shipment: productShipments,
    })
    .from(productOrderAddressChangeRequests)
    .innerJoin(
      checkoutOrders,
      eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
    )
    .leftJoin(
      productShipments,
      eq(productOrderAddressChangeRequests.shipmentId, productShipments.id),
    )
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .limit(1);
  if (!row || row.request.status !== "approved" || !row.request.proposedAddress)
    throw new Error("Address change is not approved");
  if (hasCarrierHandoff(row.shipment))
    throw new Error("Address changes are unavailable after carrier handoff");
  if (!row.shipment)
    throw new Error("The shipment generation to change was not found");

  const priorEvidence = row.request.providerReconciliation ?? {};
  if (readPreparedShipment(priorEvidence)) return;

  const config = getChitChatsConfig();
  const client = createChitChatsClient(config);
  if (row.shipment.providerShipmentId) {
    if (row.shipment.purchasedAt) {
      const result =
        priorEvidence.postageRefundRequested === true
          ? await client.getShipment(row.shipment.providerShipmentId)
          : await client.refundShipment(row.shipment.providerShipmentId);
      const normalized = normalizeChitChatsStatus(result);
      await getPrivateDb()
        .update(productShipments)
        .set({
          status: normalized === "voided" ? "voided" : "refund_pending",
          providerStatus: result.status,
          rawShipment: stripSignedLabelUrls(result),
          updatedAt: new Date(),
        })
        .where(eq(productShipments.id, row.shipment.id));
      await markProviderReconciled(requestId, {
        postageRefundRequested: true,
        priorProviderStatus: result.status,
      });
      if (normalized !== "voided")
        throw new Error(
          "Postage refund is not yet confirmed; address application is blocked",
        );
    } else {
      await client.deleteShipment(row.shipment.providerShipmentId);
      await getPrivateDb()
        .update(productShipments)
        .set({ status: "voided", updatedAt: new Date() })
        .where(eq(productShipments.id, row.shipment.id));
      await markProviderReconciled(requestId, {
        priorProviderShipmentDeleted: true,
      });
    }
  }

  const policy = await loadShippingPolicyContext();
  const reference =
    typeof priorEvidence.replacementPublicReference === "string"
      ? priorEvidence.replacementPublicReference
      : `lha-${nanoid(14)}`;
  await markProviderReconciled(requestId, {
    replacementPublicReference: reference,
  });
  const recipient = addressChangeRecipient({
    proposedAddress: row.request.proposedAddress,
    originalDestination: row.shipment.destination,
    customerName: row.order.customerName,
    customerEmail: row.order.customerEmail,
  });
  const signatureRequired =
    (row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0) >=
      policy.settings.signatureThresholdCents ||
    row.order.fraudClassification === "high";
  if (signatureRequired && !row.shipment.signatureRequired) {
    const signatureConsented = await hasSignedCustomerDecision({
      orderId: row.order.id,
      outcomes: ["accept_signature"],
    });
    if (!signatureConsented)
      throw new Error(
        "The changed address adds signature delivery and requires signed customer consent",
      );
  }
  let provider: ChitChatsShipment;
  if (priorEvidence.replacementCreateOutcomeUnknown === true) {
    const recovered = await client.findShipments(reference).catch(() => []);
    if (recovered.length !== 1)
      throw new Error(
        "Replacement shipment creation remains ambiguous and requires manual reconciliation",
      );
    provider = recovered[0]!;
  } else {
    try {
      provider = await client.createShipment({
        recipient,
        packageSnapshot: row.shipment.packageSnapshot,
        customsLines: row.shipment.customsLines,
        merchandiseValueCents:
          row.order.atRiskValueCents ??
          row.order.merchandiseAmountCents ??
          row.shipment.customsLines.reduce(
            (sum, line) => sum + line.quantity * line.unitValueCents,
            0,
          ),
        orderReference: reference,
        signatureRequested: signatureRequired,
      });
    } catch (error) {
      const recovered = await client.findShipments(reference).catch(() => []);
      if (recovered.length !== 1) {
        await markProviderReconciled(requestId, {
          replacementCreateOutcomeUnknown: true,
        });
        await openProductShippingCase({
          orderId: row.order.id,
          shipmentId: row.shipment.id,
          type: "postage_failure",
          cause: "address_change_replacement_create_outcome_unknown",
        });
        throw error;
      }
      provider = recovered[0]!;
    }
  }
  const rates = selectCustomerRates(
    provider.rates ?? [],
    config.trackedPostageTypes,
    {
      atRiskValueCents:
        row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
      destinationCountryCode: recipient.countryCode,
      estimatedDeliveryAt: provider.estimated_delivery_at,
      servicePolicies: policy.servicePolicies,
      signatureThresholdCents: signatureRequired ? 0 : Number.MAX_SAFE_INTEGER,
    },
  );
  let selected = rates.find(
    (rate) => rate.postageType === row.shipment!.selectedPostageType,
  );
  if (!selected && rates.length > 0) {
    const consented = await hasSignedCustomerDecision({
      orderId: row.order.id,
      outcomes: ["accept_substitute"],
    });
    if (consented) selected = rates[0];
  }
  if (!selected) {
    await client.deleteShipment(provider.id).catch(() => undefined);
    throw new Error(
      rates.length
        ? "The changed address requires signed consent for a different shipping service"
        : "No eligible insured tracked service is available for the changed address",
    );
  }
  const prepared: PreparedAddressChangeShipment = {
    providerShipmentId: provider.id,
    providerStatus: provider.status,
    publicReference: reference,
    selectedPostageType: selected.postageType,
    selectedRateId: selected.id,
    selectedRateAmountCents: selected.paymentAmountCents,
    ...(selected.deliveryMaxBusinessDays
      ? { deliveryMaxBusinessDays: selected.deliveryMaxBusinessDays }
      : {}),
    ...(selected.estimatedDeliveryAt
      ? { estimatedDeliveryAt: selected.estimatedDeliveryAt }
      : {}),
    signatureRequired,
    quoteExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    rawShipment: stripSignedLabelUrls(provider),
  };
  await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      postageDifferenceCents:
        selected.paymentAmountCents - row.order.shippingAmountCents,
      providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ preparedShipment: prepared })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(productOrderAddressChangeRequests.id, requestId));
}

export async function discardPreparedAddressChangeShipment(
  requestId: string,
): Promise<boolean> {
  const [request] = await getPrivateDb()
    .select({
      reconciliation: productOrderAddressChangeRequests.providerReconciliation,
    })
    .from(productOrderAddressChangeRequests)
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .limit(1);
  const prepared = readPreparedShipment(request?.reconciliation ?? {});
  if (!prepared) return true;
  try {
    await createChitChatsClient(getChitChatsConfig()).deleteShipment(
      prepared.providerShipmentId,
    );
    await getPrivateDb()
      .update(productOrderAddressChangeRequests)
      .set({
        providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'preparedShipment') || '{"replacementProviderShipmentDeleted":true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(productOrderAddressChangeRequests.id, requestId));
    return true;
  } catch {
    await markProviderReconciled(requestId, {
      replacementProviderShipmentCleanupRequired: true,
    });
    return false;
  }
}

async function markProviderReconciled(
  requestId: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify(evidence)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(productOrderAddressChangeRequests.id, requestId));
}

export async function issueAddressChange(input: {
  orderReference: string;
}): Promise<{ id: string; email: string; token: string }> {
  const token = issueShippingCustomerToken();
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ order: checkoutOrders, shipment: productShipments })
      .from(checkoutOrders)
      .leftJoin(
        productShipments,
        eq(productShipments.orderId, checkoutOrders.id),
      )
      .where(eq(checkoutOrders.orderId, input.orderReference))
      .orderBy(desc(productShipments.sequence))
      .limit(1);
    if (
      !row?.order.shippingAddress ||
      row.order.status !== "paid" ||
      row.order.redactedAt
    )
      throw new Error("Order does not have a shipping address");
    if (hasCarrierHandoff(row.shipment))
      throw new Error("Address changes are unavailable after carrier handoff");
    const [recent] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(productOrderAddressChangeRequests)
      .where(
        and(
          eq(productOrderAddressChangeRequests.orderId, row.order.id),
          gte(
            productOrderAddressChangeRequests.createdAt,
            new Date(now.getTime() - 24 * 60 * 60_000),
          ),
        ),
      );
    if (Number(recent?.count ?? 0) >= 3)
      throw new Error("Address-change link issuance limit reached");
    await tx
      .update(productOrderAddressChangeRequests)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(productOrderAddressChangeRequests.orderId, row.order.id),
          inArray(productOrderAddressChangeRequests.status, [
            "pending_customer",
            "submitted",
            "risk_review",
            "approved",
          ]),
        ),
      );
    const [created] = await tx
      .insert(productOrderAddressChangeRequests)
      .values({
        orderId: row.order.id,
        shipmentId: row.shipment?.id,
        originalAddress: row.order.shippingAddress,
        tokenHash: hashShippingCustomerToken(token, "address-change"),
        expiresAt: new Date(now.getTime() + 30 * 60_000),
      })
      .returning({ id: productOrderAddressChangeRequests.id });
    return { id: created!.id, email: row.order.customerEmail, token };
  });
}

export async function revokeAddressChanges(
  orderReference: string,
): Promise<number> {
  const revoked = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        sql`${productOrderAddressChangeRequests.orderId} = (select ${checkoutOrders.id} from ${checkoutOrders} where ${checkoutOrders.orderId} = ${orderReference})`,
        inArray(productOrderAddressChangeRequests.status, [
          "pending_customer",
          "submitted",
          "risk_review",
          "approved",
        ]),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  return revoked.length;
}

export async function exchangeAddressChangeToken(
  bearerToken: string,
): Promise<string | null> {
  const sessionToken = issueShippingCustomerToken();
  const now = new Date();
  const [updated] = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      tokenHash: hashShippingCustomerToken(sessionToken, "address-change"),
      exchangedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          productOrderAddressChangeRequests.tokenHash,
          hashShippingCustomerToken(bearerToken, "address-change"),
        ),
        eq(productOrderAddressChangeRequests.status, "pending_customer"),
        isNull(productOrderAddressChangeRequests.exchangedAt),
        gt(productOrderAddressChangeRequests.expiresAt, now),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  return updated ? sessionToken : null;
}

export async function validateAddressChangeBearer(
  bearerToken: string,
): Promise<boolean> {
  const [row] = await getPrivateDb()
    .select({ id: productOrderAddressChangeRequests.id })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(
          productOrderAddressChangeRequests.tokenHash,
          hashShippingCustomerToken(bearerToken, "address-change"),
        ),
        eq(productOrderAddressChangeRequests.status, "pending_customer"),
        isNull(productOrderAddressChangeRequests.exchangedAt),
        gt(productOrderAddressChangeRequests.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function getAddressChange(sessionToken: string) {
  const [row] = await getPrivateDb()
    .select({
      id: productOrderAddressChangeRequests.id,
      originalAddress: productOrderAddressChangeRequests.originalAddress,
      expiresAt: productOrderAddressChangeRequests.expiresAt,
    })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(
          productOrderAddressChangeRequests.tokenHash,
          hashShippingCustomerToken(sessionToken, "address-change"),
        ),
        eq(productOrderAddressChangeRequests.status, "pending_customer"),
        gt(productOrderAddressChangeRequests.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function submitAddressChange(input: {
  sessionToken: string;
  proposedAddress: CheckoutOrderShippingAddressSnapshot;
}): Promise<boolean> {
  const now = new Date();
  const policy = await loadShippingPolicyContext(now);
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
        shipment: productShipments,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
      )
      .leftJoin(
        productShipments,
        eq(productOrderAddressChangeRequests.shipmentId, productShipments.id),
      )
      .where(
        and(
          eq(
            productOrderAddressChangeRequests.tokenHash,
            hashShippingCustomerToken(input.sessionToken, "address-change"),
          ),
          eq(productOrderAddressChangeRequests.status, "pending_customer"),
          gt(productOrderAddressChangeRequests.expiresAt, now),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !row ||
      row.order.status !== "paid" ||
      row.order.redactedAt ||
      hasCarrierHandoff(row.shipment)
    )
      return false;
    const [previous] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.orderId, row.order.id));
    const flags = addressRiskFlags({
      original: row.request.originalAddress,
      proposed: input.proposedAddress,
      previousRequestCount: Number(previous?.count ?? 0),
      postagePurchased: Boolean(row.shipment?.purchasedAt),
      atRiskValueCents:
        row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
      reviewThresholdCents: policy.settings.addressReviewThresholdCents,
      forwarderPatterns: policy.settings.forwarderPatterns,
    });
    const highRisk = flags.some((flag) => flag !== "value_threshold");
    const [updated] = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        status: flags.length ? "risk_review" : "submitted",
        proposedAddress: input.proposedAddress,
        riskFlags: flags,
        submittedAt: now,
        tokenHash: hashShippingCustomerToken(
          issueShippingCustomerToken(),
          "address-change",
        ),
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, row.request.id),
          eq(productOrderAddressChangeRequests.status, "pending_customer"),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (updated && highRisk)
      await tx
        .update(checkoutOrders)
        .set({
          fraudClassification: "high",
          fraudRiskReasons: sql`${checkoutOrders.fraudRiskReasons} || ${JSON.stringify(flags)}::jsonb`,
          fraudClearedAt: null,
          updatedAt: now,
        })
        .where(eq(checkoutOrders.id, row.order.id));
    return Boolean(updated);
  });
}

export async function approveAddressChange(input: {
  requestId: string;
  adminUserId: string;
  responsibility?: "customer" | "lash_her";
  rationale?: string;
  stepUpAuthenticatedAt?: Date;
  phoneCallbackCompleted?: boolean;
  providerEvidenceAvailable?: boolean;
  evidence?: Record<string, unknown>;
}): Promise<{ complete: boolean; coolingOffUntil?: string }> {
  const now = new Date();
  const rationale = input.rationale?.trim().slice(0, 1_000) ?? "";
  return getPrivateDb().transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: adminUsers.role })
      .from(adminUsers)
      .where(
        and(
          eq(adminUsers.id, input.adminUserId),
          eq(adminUsers.status, "active"),
        ),
      )
      .limit(1);
    if (actor?.role !== "owner")
      throw new Error("The Business Owner must approve address changes");
    const [row] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        policyVersion: checkoutOrders.shippingPolicyVersion,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
      )
      .where(eq(productOrderAddressChangeRequests.id, input.requestId))
      .for("update")
      .limit(1);
    if (!row || !["submitted", "risk_review"].includes(row.request.status))
      throw new Error("Address change is not awaiting approval");
    if (!input.responsibility)
      throw new Error("Address-change cost responsibility is required");
    if (rationale.length < 10)
      throw new Error(
        "A documented rationale of at least 10 characters is required",
      );
    const highRisk = row.request.riskFlags.length > 0;
    const evidence = sanitizeAddressApprovalEvidence(input.evidence);
    const policyVersion = row.policyVersion ?? "unconfigured";
    if (highRisk) {
      if (!input.stepUpAuthenticatedAt)
        throw new Error("Step-up authentication is required");
      if (!input.phoneCallbackCompleted)
        throw new Error("Original-order-phone callback is required");
      if (
        !input.providerEvidenceAvailable ||
        Object.keys(evidence).length === 0
      )
        throw new Error("Authoritative provider evidence is required");
      if (!row.request.coolingOffUntil) {
        const coolingOffUntil = new Date(now.getTime() + 15 * 60_000);
        await tx.insert(fulfillmentOwnerActions).values({
          targetType: "address_change",
          targetId: row.request.id,
          action: "address_approval_proposed",
          adminUserId: input.adminUserId,
          policyVersion,
          rationale,
          evidence,
          stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          coolingOffUntil,
        });
        await tx
          .update(productOrderAddressChangeRequests)
          .set({
            customerCaused: input.responsibility === "customer",
            phoneCallbackCompletedAt: now,
            stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
            coolingOffUntil,
            ownerRationale: rationale,
            providerReconciliation: {
              ...(row.request.providerReconciliation ?? {}),
              responsibility: input.responsibility,
              approvalEvidence: evidence,
            },
            updatedAt: now,
          })
          .where(eq(productOrderAddressChangeRequests.id, row.request.id));
        return {
          complete: false,
          coolingOffUntil: coolingOffUntil.toISOString(),
        };
      }
      if (row.request.coolingOffUntil > now) {
        return {
          complete: false,
          coolingOffUntil: row.request.coolingOffUntil.toISOString(),
        };
      }
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "address_change",
        targetId: row.request.id,
        action: "address_approval_executed",
        adminUserId: input.adminUserId,
        policyVersion,
        rationale,
        evidence,
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        coolingOffUntil: row.request.coolingOffUntil,
        executedAt: now,
      });
    }
    await tx
      .update(productOrderAddressChangeRequests)
      .set({
        firstApprovedByAdminUserId: input.adminUserId,
        firstApprovedAt: now,
        status: "approved",
        customerCaused: input.responsibility === "customer",
        ownerRationale: rationale,
        updatedAt: now,
        providerReconciliation: {
          ...(row.request.providerReconciliation ?? {}),
          responsibility: input.responsibility,
          approvalEvidence: evidence,
        },
      })
      .where(eq(productOrderAddressChangeRequests.id, row.request.id));
    if (!highRisk) {
      await tx.insert(fulfillmentOwnerActions).values({
        targetType: "address_change",
        targetId: row.request.id,
        action: "address_approval_executed",
        adminUserId: input.adminUserId,
        policyVersion,
        rationale,
        evidence,
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt ?? now,
        coolingOffUntil: now,
        executedAt: now,
      });
    }
    return { complete: true };
  });
}

export async function applyApprovedAddressChange(requestId: string): Promise<{
  orderReference: string;
  refundDecreaseCents: number;
  requiresSupplementalPayment: boolean;
  supplementalObligationId?: string;
}> {
  return getPrivateDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
        shipment: productShipments,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
      )
      .leftJoin(
        productShipments,
        eq(productOrderAddressChangeRequests.shipmentId, productShipments.id),
      )
      .where(eq(productOrderAddressChangeRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!row?.request.proposedAddress || row.request.status !== "approved")
      throw new Error("Address change is not approved");
    if (
      row.order.status !== "paid" ||
      row.order.paymentRiskStatus !== "cleared" ||
      row.order.redactedAt ||
      hasCarrierHandoff(row.shipment)
    )
      throw new Error("Address changes are unavailable after carrier handoff");
    if (!row.shipment)
      throw new Error("The shipment generation to change was not found");
    const prepared = readPreparedShipment(
      row.request.providerReconciliation ?? {},
    );
    if (!prepared)
      throw new Error("Replacement shipment must be prepared first");
    const difference = row.request.postageDifferenceCents ?? 0;
    const responsibility = row.request.providerReconciliation?.responsibility;
    if (responsibility !== "customer" && responsibility !== "lash_her")
      throw new Error("Address-change cost responsibility is missing");
    if (difference > 0 && responsibility === "customer") {
      const existing = row.request.supplementalObligationId
        ? await tx.query.orderPaymentObligations.findFirst({
            where: eq(
              orderPaymentObligations.id,
              row.request.supplementalObligationId,
            ),
          })
        : null;
      if (existing?.status !== "paid") {
        if (
          existing?.status === "pending" &&
          existing.expiresAt &&
          existing.expiresAt > new Date()
        ) {
          return {
            orderReference: row.order.orderId,
            refundDecreaseCents: 0,
            requiresSupplementalPayment: true,
            supplementalObligationId: existing.id,
          };
        }
        if (existing) {
          if (existing.status === "pending") {
            await tx
              .update(orderPaymentObligations)
              .set({ status: "superseded", updatedAt: new Date() })
              .where(eq(orderPaymentObligations.id, existing.id));
          }
          throw new Error(
            "Supplemental offer expired; prepare a fresh replacement quote",
          );
        }
        if (!row.order.shippingPolicyVersion || !row.order.taxPolicyVersion) {
          throw new Error(
            "Policy and tax snapshots are required for supplemental payment",
          );
        }
        const offerExpiresAt = new Date(Date.now() + 24 * 60 * 60_000);
        const [obligation] = await tx
          .insert(orderPaymentObligations)
          .values({
            orderId: row.order.id,
            purpose: "address_increase",
            status: "pending",
            merchandiseAmountCents: 0,
            shippingAmountCents: difference,
            taxAmountCents: 0,
            totalAmountCents: difference,
            currency: row.order.currency,
            sourceWorkflow: `address_change/${row.request.id}`,
            sourceReferenceId: row.request.id,
            disclosureSnapshot: {
              responsibility: "customer",
              proposedAddressCountry:
                row.request.proposedAddress.countryCode ??
                row.request.proposedAddress.country,
            },
            taxPolicyVersion: row.order.taxPolicyVersion,
            policyVersion: row.order.shippingPolicyVersion,
            quoteVersion: 1,
            expiresAt: offerExpiresAt,
            idempotencyKey: `address-increase/${row.request.id}/${prepared.publicReference}/${difference}`,
          })
          .onConflictDoNothing({
            target: orderPaymentObligations.idempotencyKey,
          })
          .returning({ id: orderPaymentObligations.id });
        if (!obligation) {
          throw new Error(
            "A supplemental obligation already exists for this quote",
          );
        }
        await tx
          .update(productOrderAddressChangeRequests)
          .set({
            supplementalObligationId: obligation!.id,
            offerExpiresAt,
            reconciliationState: "awaiting_supplemental_payment",
            customerCaused: true,
            updatedAt: new Date(),
          })
          .where(eq(productOrderAddressChangeRequests.id, row.request.id));
        return {
          orderReference: row.order.orderId,
          refundDecreaseCents: 0,
          requiresSupplementalPayment: true,
          supplementalObligationId: obligation!.id,
        };
      }
    }
    const [sequence] = await tx
      .select({
        next: sql<number>`coalesce(max(${productShipments.sequence}), -1) + 1`,
      })
      .from(productShipments)
      .where(eq(productShipments.orderId, row.order.id));
    const quoteToken = issueShippingQuoteToken();
    await tx
      .update(checkoutOrders)
      .set({
        shippingAddress: row.request.proposedAddress,
        updatedAt: new Date(),
      })
      .where(eq(checkoutOrders.id, row.order.id));
    await tx
      .update(productShipments)
      .set({ status: "voided", updatedAt: new Date() })
      .where(eq(productShipments.id, row.shipment.id));
    await tx.insert(productShipments).values({
      orderId: row.order.id,
      sequence: Number(sequence?.next ?? row.shipment.sequence + 1),
      purpose: "reshipment",
      supersedesShipmentId: row.shipment.id,
      publicReference: prepared.publicReference,
      quoteTokenHash: hashShippingQuoteToken(quoteToken),
      quoteFingerprint: `address-change:${row.request.id}:${nanoid(8)}`,
      providerShipmentId: prepared.providerShipmentId,
      providerStatus: prepared.providerStatus,
      destination: {
        ...row.shipment.destination,
        ...row.request.proposedAddress,
        name: row.order.customerName,
        email: row.order.customerEmail,
      },
      packageSnapshot: row.shipment.packageSnapshot,
      customsLines: row.shipment.customsLines,
      rates: [],
      selectedRateId: prepared.selectedRateId,
      selectedPostageType: prepared.selectedPostageType,
      quotedShippingCents: prepared.selectedRateAmountCents,
      rawShipment: prepared.rawShipment,
      quoteExpiresAt: new Date(prepared.quoteExpiresAt),
      status: "ready_for_staff",
      originalHandoffDeadlineAt: row.shipment.originalHandoffDeadlineAt,
      autoRefundDeadlineAt: row.shipment.autoRefundDeadlineAt,
      latestEstimatedDeliveryAt: prepared.estimatedDeliveryAt
        ? new Date(prepared.estimatedDeliveryAt)
        : null,
      deliveryMaxBusinessDays: prepared.deliveryMaxBusinessDays,
      signatureRequired: prepared.signatureRequired,
      signatureRequested: prepared.signatureRequired,
    });
    await tx
      .update(productOrderAddressChangeRequests)
      .set({ status: "applied", appliedAt: new Date(), updatedAt: new Date() })
      .where(eq(productOrderAddressChangeRequests.id, row.request.id));
    return {
      orderReference: row.order.orderId,
      refundDecreaseCents: difference <= -100 ? Math.abs(difference) : 0,
      requiresSupplementalPayment: false,
    };
  });
}

function sanitizeAddressApprovalEvidence(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const allowedKeys = new Set([
    "providerShipmentId",
    "providerStatus",
    "addressValidationReference",
    "phoneCallbackReference",
    "evidenceReference",
  ]);
  return Object.fromEntries(
    Object.entries(value ?? {}).flatMap(([key, entry]) =>
      allowedKeys.has(key) &&
      (typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean")
        ? [[key, entry]]
        : [],
    ),
  );
}

function addressChangeRecipient(input: {
  proposedAddress: CheckoutOrderShippingAddressSnapshot;
  originalDestination: typeof productShipments.$inferSelect.destination;
  customerName: string;
  customerEmail: string;
}): ShippingRecipient {
  const countryCode =
    input.proposedAddress.countryCode ??
    (input.proposedAddress.country.trim().toUpperCase() === "CANADA"
      ? "CA"
      : input.proposedAddress.country.trim().toUpperCase() === "UNITED STATES"
        ? "US"
        : null);
  if (!countryCode)
    throw new Error("Address country must be Canada or United States");
  const phone =
    input.proposedAddress.phone?.trim() ||
    input.originalDestination.phone?.trim();
  if (!phone) throw new Error("A recipient phone number is required");
  return {
    ...input.proposedAddress,
    countryCode,
    name: input.customerName,
    email: input.customerEmail,
    phone,
  };
}

function readPreparedShipment(
  evidence: Record<string, unknown>,
): PreparedAddressChangeShipment | null {
  const value = evidence.preparedShipment;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.providerShipmentId !== "string" ||
    typeof candidate.providerStatus !== "string" ||
    typeof candidate.publicReference !== "string" ||
    typeof candidate.selectedPostageType !== "string" ||
    typeof candidate.selectedRateId !== "string" ||
    typeof candidate.selectedRateAmountCents !== "number" ||
    typeof candidate.signatureRequired !== "boolean" ||
    typeof candidate.quoteExpiresAt !== "string" ||
    !candidate.rawShipment ||
    typeof candidate.rawShipment !== "object"
  )
    return null;
  const expiresAt = new Date(candidate.quoteExpiresAt);
  if (!Number.isFinite(expiresAt.getTime())) return null;
  return candidate as unknown as PreparedAddressChangeShipment;
}

function hasCarrierHandoff(
  shipment: typeof productShipments.$inferSelect | null,
): boolean {
  return Boolean(
    shipment?.acceptedAt ||
    (shipment &&
      ["accepted", "in_transit", "delivered"].includes(shipment.status)),
  );
}

function addressRiskFlags(input: {
  original: CheckoutOrderShippingAddressSnapshot;
  proposed: CheckoutOrderShippingAddressSnapshot;
  previousRequestCount: number;
  postagePurchased: boolean;
  atRiskValueCents: number;
  reviewThresholdCents: number;
  forwarderPatterns: string[];
}): string[] {
  const flags: string[] = [];
  if (
    input.original.country.toUpperCase() !==
    input.proposed.country.toUpperCase()
  )
    flags.push("country_change");
  if (
    input.original.province.toUpperCase() !==
    input.proposed.province.toUpperCase()
  )
    flags.push("province_change");
  if (input.previousRequestCount > 1) flags.push("repeated_change");
  if (input.postagePurchased) flags.push("post_postage_change");
  if (input.atRiskValueCents >= input.reviewThresholdCents)
    flags.push("value_threshold");
  const searchable = Object.values(input.proposed).join(" ").toLowerCase();
  if (
    input.forwarderPatterns.some(
      (pattern) =>
        pattern.trim() && searchable.includes(pattern.trim().toLowerCase()),
    )
  )
    flags.push("forwarder_pattern");
  return flags;
}

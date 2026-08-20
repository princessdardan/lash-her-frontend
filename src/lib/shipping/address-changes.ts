import "server-only";

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { and, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { getPrivateDb } from "@/lib/private-db/client";
import {
  checkoutOrders,
  fulfillmentOwnerActions,
  fulfillmentProviderCertifications,
  orderPaymentObligations,
  orderPaymentTransactions,
  productOrderAdjustments,
  productOrderAddressChangeRequests,
  productOrderCustomerDecisions,
  productOrderRefunds,
  productPaymentRiskIncidents,
  productShipmentJobs,
  productShipments,
  type CheckoutOrderShippingAddressSnapshot,
} from "@/lib/private-db/schema";
import {
  hashShippingCustomerToken,
  issueShippingCustomerToken,
} from "./customer-token";
import { loadShippingPolicyContext } from "./policy";
import type { ChitChatsClient } from "./chitchats-client";
import { getChitChatsConfig } from "./config";
import { selectCustomerRates } from "./rates";
import {
  addressServiceSubstitutionDecisionTerms,
  addressSignatureDecisionTerms,
  consumeSignedCustomerDecision,
  consumeSignedCustomerDecisionWithExecutor,
  hasSignedCustomerDecision,
  issueCustomerDecisionWithExecutor,
  type CustomerDecisionExecutor,
} from "./customer-decisions";
import {
  hashShippingQuoteToken,
  issueShippingQuoteToken,
  parseShippingQuoteContextSnapshot,
} from "./quote-token";
import {
  assertProductTaxPolicyApprovalInTransaction,
  assertShippingQuoteContextCurrent,
  lockShippingCheckoutReadinessConfiguration,
} from "./readiness";
import { stripSignedLabelUrls } from "./status";
import type { ChitChatsShipment, ShippingRecipient } from "./types";
import { openProductShippingCase } from "./cases";
import { sendShippingCustomerLinkEmail } from "./customer-link-email";
import {
  enqueueShipmentOperation,
  enqueuePreparedAddressPurchaseInTransaction,
  enqueueUnpaidProviderDraftCleanup,
  fencePreparedGenerationAndEnqueueCleanup,
  hashOperationPayload,
} from "./shipment-store";
import {
  issueSupplementalPaymentOfferInTransaction,
  supplementalPaymentPublicOrigin,
} from "@/lib/commerce/supplemental-payment-offers";
import { queueProductOrderRefundAllocationsInTransaction } from "./customer-refunds";
import { claimShippingCustomerLinkIssuance } from "./customer-link-issuance";
import { assertConfiguredFulfillmentOwnerInTransaction } from "./configured-owner";

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
  expectedStateVersion: number,
): Promise<{
  operationId: string | null;
  prepared: boolean;
  awaitingDecision?: boolean;
}> {
  const db = getPrivateDb();
  const attemptIdentity = `address-replace/${requestId}/${nanoid(12)}`;
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
      )
      .where(eq(productOrderAddressChangeRequests.id, requestId))
      .for("update")
      .limit(1);
    if (
      !row ||
      row.request.status !== "approved" ||
      !row.request.proposedAddress
    )
      throw new Error("Address change is not approved");
    if (row.request.stateVersion !== expectedStateVersion)
      throw new Error("Address change state changed; refresh before retrying");
    if (
      ["awaiting_signature", "awaiting_service_substitution"].includes(
        row.request.reconciliationState,
      )
    ) {
      return {
        prepared: false as const,
        awaitingDecision: true as const,
        sourceId: row.request.expectedSourceShipmentId!,
        sourceVersion: row.request.expectedSourceShipmentStateVersion!,
        requestVersion: row.request.stateVersion,
        attemptIdentity: row.request.attemptIdentity!,
        operationId: null,
      };
    }
    if (
      ["queued", "processing", "decision_resume_queued"].includes(
        row.request.reconciliationState,
      )
    ) {
      const operationId =
        row.request.reconciliationState === "decision_resume_queued"
          ? row.request.providerReconciliation?.decisionResumeOperationId
          : null;
      const [existing] = await tx
        .select()
        .from(productShipmentJobs)
        .where(
          typeof operationId === "string"
            ? eq(productShipmentJobs.id, operationId)
            : eq(
                productShipmentJobs.idempotencyKey,
                row.request.attemptIdentity ?? "missing",
              ),
        )
        .limit(1);
      const payload = existing?.payload;
      if (
        !existing ||
        existing.type !== "address_replace" ||
        existing.shipmentId !== row.request.expectedSourceShipmentId ||
        payload?.requestId !== row.request.id ||
        payload?.sourceShipmentId !== row.request.expectedSourceShipmentId ||
        payload?.expectedRequestStateVersion !== row.request.stateVersion ||
        payload?.expectedSourceStateVersion !==
          row.request.expectedSourceShipmentStateVersion
      ) {
        throw new Error(
          "Address reconciliation operation does not match its durable intent",
        );
      }
      return {
        prepared: false as const,
        awaitingDecision: false as const,
        sourceId: row.request.expectedSourceShipmentId!,
        sourceVersion: row.request.expectedSourceShipmentStateVersion!,
        requestVersion: row.request.stateVersion,
        attemptIdentity: existing.idempotencyKey,
        operationId: existing.id,
      };
    }
    if (row.request.preparedShipmentId)
      return {
        prepared: true as const,
        sourceId: row.request.expectedSourceShipmentId!,
        sourceVersion: row.request.expectedSourceShipmentStateVersion!,
        requestVersion: row.request.stateVersion,
        attemptIdentity: row.request.attemptIdentity!,
      };
    const sourceId =
      row.request.expectedSourceShipmentId ?? row.request.shipmentId;
    if (!sourceId || row.order.activeFulfillmentShipmentId !== sourceId)
      throw new Error("The active shipment generation changed");
    const [source] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, sourceId))
      .for("update")
      .limit(1);
    if (!source || hasCarrierHandoff(source))
      throw new Error("Address changes are unavailable after carrier handoff");
    const expectedVersion =
      row.request.expectedSourceShipmentStateVersion ?? source.stateVersion;
    if (source.stateVersion !== expectedVersion)
      throw new Error("The source shipment generation changed");
    const nextVersion = row.request.stateVersion + 1;
    const [updated] = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        expectedSourceShipmentId: source.id,
        expectedSourceShipmentStateVersion: expectedVersion,
        attemptIdentity,
        reconciliationState: "queued",
        stateVersion: nextVersion,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, requestId),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            row.request.stateVersion,
          ),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!updated) throw new Error("Address reconciliation state changed");
    return {
      prepared: false as const,
      sourceId: source.id,
      sourceVersion: expectedVersion,
      requestVersion: nextVersion,
      attemptIdentity,
    };
  });
  if (claimed.prepared) return { operationId: null, prepared: true };
  if ("operationId" in claimed) {
    return {
      operationId: claimed.operationId ?? null,
      prepared: false,
      awaitingDecision: claimed.awaitingDecision,
    };
  }
  const operation = await enqueueShipmentOperation({
    shipmentId: claimed.sourceId,
    type: "address_replace",
    idempotencyKey: claimed.attemptIdentity,
    payload: {
      requestId,
      expectedRequestStateVersion: claimed.requestVersion,
      sourceShipmentId: claimed.sourceId,
      expectedSourceStateVersion: claimed.sourceVersion,
    },
  });
  return { operationId: operation.id, prepared: false };
}

export async function discardPreparedAddressChangeShipment(
  requestId: string,
): Promise<boolean> {
  const [request] = await getPrivateDb()
    .select({
      preparedShipmentId: productOrderAddressChangeRequests.preparedShipmentId,
      preparedShipmentStateVersion:
        productOrderAddressChangeRequests.preparedShipmentStateVersion,
      adoptionOutcome: productOrderAddressChangeRequests.adoptionOutcome,
      reconciliationState:
        productOrderAddressChangeRequests.reconciliationState,
      providerReconciliation:
        productOrderAddressChangeRequests.providerReconciliation,
    })
    .from(productOrderAddressChangeRequests)
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .limit(1);
  if (
    !request?.preparedShipmentId ||
    request.preparedShipmentStateVersion === null ||
    request.adoptionOutcome === "adopted"
  )
    return true;
  await enqueueShipmentOperation({
    shipmentId: request.preparedShipmentId,
    type: "cleanup",
    idempotencyKey: `address-prepared-cleanup/${requestId}/${request.preparedShipmentId}`,
    payload: {
      requestId,
      reason: "address_change_not_adopted",
      expectedShipmentStateVersion: request.preparedShipmentStateVersion,
    },
  });
  await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({ cleanupOutcome: "queued", updatedAt: new Date() })
    .where(eq(productOrderAddressChangeRequests.id, requestId));
  return false;
}

export class AmbiguousShipmentOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousShipmentOperationError";
  }
}

class AddressRevocationPendingError extends Error {
  constructor() {
    super("Address revocation committed before provider draft persistence");
    this.name = "AddressRevocationPendingError";
  }
}

export async function processAddressReplaceOperation(input: {
  jobId: string;
  shipmentId: string;
  payload: Record<string, unknown>;
  client: ChitChatsClient;
  observedAt: Date;
  outcomeUnknown: boolean;
}): Promise<{ outcomeCode: string }> {
  const requestId = requirePayloadString(input.payload, "requestId");
  const sourceShipmentId = requirePayloadString(
    input.payload,
    "sourceShipmentId",
  );
  const expectedRequestStateVersion = requirePayloadInteger(
    input.payload,
    "expectedRequestStateVersion",
  );
  const expectedSourceStateVersion = requirePayloadInteger(
    input.payload,
    "expectedSourceStateVersion",
  );
  if (sourceShipmentId !== input.shipmentId)
    throw new Error("Address operation source shipment does not match its job");
  const leaseUntil = new Date(input.observedAt.getTime() + 5 * 60_000);
  const [leased] = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      leaseOwner: input.jobId,
      leaseExpiresAt: leaseUntil,
      leaseVersion: sql`${productOrderAddressChangeRequests.leaseVersion} + 1`,
      reconciliationState: "processing",
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, requestId),
        eq(productOrderAddressChangeRequests.status, "approved"),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          expectedRequestStateVersion,
        ),
        eq(
          productOrderAddressChangeRequests.expectedSourceShipmentId,
          sourceShipmentId,
        ),
        eq(
          productOrderAddressChangeRequests.expectedSourceShipmentStateVersion,
          expectedSourceStateVersion,
        ),
        sql`(${productOrderAddressChangeRequests.leaseExpiresAt} is null or ${productOrderAddressChangeRequests.leaseExpiresAt} <= ${input.observedAt} or ${productOrderAddressChangeRequests.leaseOwner} = ${input.jobId})`,
      ),
    )
    .returning();
  if (!leased)
    throw new Error("Address operation lease or generation is stale");
  if (input.payload.mode === "refresh_prepared") {
    return refreshPreparedAddressChangeShipment({
      ...input,
      requestId,
      sourceShipmentId,
      expectedRequestStateVersion,
      expectedSourceStateVersion,
      preparedShipmentId: requirePayloadString(
        input.payload,
        "preparedShipmentId",
      ),
      expectedPreparedStateVersion: requirePayloadInteger(
        input.payload,
        "expectedPreparedStateVersion",
      ),
      refreshIntentAt: requirePayloadInstant(input.payload, "refreshIntentAt"),
      shipDate: requirePayloadDate(input.payload, "shipDate"),
    });
  }
  if (input.payload.mode === "resume_service_substitution") {
    return resumeAddressServiceSubstitution({
      jobId: input.jobId,
      requestId,
      sourceShipmentId,
      expectedRequestStateVersion,
      expectedSourceStateVersion,
      decisionId: requirePayloadString(input.payload, "decisionId"),
      preparedShipmentId: requirePayloadString(
        input.payload,
        "preparedShipmentId",
      ),
      expectedPreparedStateVersion: requirePayloadInteger(
        input.payload,
        "expectedPreparedStateVersion",
      ),
      observedAt: input.observedAt,
    });
  }
  if (leased.preparedShipmentId) return { outcomeCode: "already_prepared" };
  const [row] = await getPrivateDb()
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
    .innerJoin(productShipments, eq(productShipments.id, sourceShipmentId))
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .limit(1);
  if (
    row &&
    input.outcomeUnknown &&
    (row.shipment.stateVersion !== expectedSourceStateVersion ||
      row.request.providerReconciliation?.revocationPending === true ||
      row.order.status !== "paid" ||
      row.order.paymentRiskStatus !== "cleared" ||
      row.order.fulfillmentQuarantinedAt !== null ||
      row.order.activeFulfillmentShipmentId !== sourceShipmentId ||
      hasCarrierHandoff(row.shipment))
  ) {
    return reconcileAmbiguousAddressCreateForCleanup({
      client: input.client,
      jobId: input.jobId,
      observedAt: input.observedAt,
      request: row.request,
      order: row.order,
      source: row.shipment,
      expectedRequestStateVersion,
      revoked: row.request.providerReconciliation?.revocationPending === true,
    });
  }
  if (row && row.shipment.stateVersion !== expectedSourceStateVersion) {
    const [reset] = await getPrivateDb()
      .update(productOrderAddressChangeRequests)
      .set({
        expectedSourceShipmentStateVersion: row.shipment.stateVersion,
        reconciliationState: "source_generation_changed",
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: expectedRequestStateVersion + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, requestId),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            expectedRequestStateVersion,
          ),
          eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!reset) throw new Error("Address source recovery state changed");
    return { outcomeCode: "source_generation_changed" };
  }
  if (
    !row?.request.proposedAddress ||
    row.order.status !== "paid" ||
    row.order.paymentRiskStatus !== "cleared" ||
    row.order.fulfillmentQuarantinedAt !== null ||
    row.order.activeFulfillmentShipmentId !== sourceShipmentId ||
    hasCarrierHandoff(row.shipment)
  )
    throw new Error(
      "Address operation source generation is no longer eligible",
    );
  const sourceQuoteContext = parseShippingQuoteContextSnapshot(
    row.shipment.deadlinePolicySnapshot,
  );
  if (!sourceQuoteContext) {
    throw new Error("The source shipment has no certified quote context");
  }
  const proposedCountryCode =
    row.request.proposedAddress.countryCode ??
    (row.request.proposedAddress.country.toUpperCase() === "CANADA"
      ? "CA"
      : "US");
  if (!input.outcomeUnknown) {
    await assertShippingQuoteContextCurrent({
      destinationCountryCode: proposedCountryCode,
      expectedContext: sourceQuoteContext,
      now: input.observedAt,
    });
    await assertAddressProviderMutationFence({
      requestId,
      jobId: input.jobId,
      expectedRequestStateVersion,
      sourceShipmentId,
      expectedSourceStateVersion,
      destinationCountryCode: proposedCountryCode,
      quoteContext: sourceQuoteContext,
      now: input.observedAt,
    });
  }
  const reference = buildAddressReplacementPublicReference({
    requestId,
    attemptIdentity: row.request.attemptIdentity ?? input.jobId,
  });
  const recordedCreateIntent = row.request.providerReconciliation
    ?.addressCreateIntent as Record<string, unknown> | null | undefined;
  let mutationAuthorizedAt = input.observedAt;
  let provider: ChitChatsShipment | null = null;
  if (input.outcomeUnknown) {
    if (
      !recordedCreateIntent ||
      typeof recordedCreateIntent !== "object" ||
      Array.isArray(recordedCreateIntent) ||
      recordedCreateIntent.reference !== reference ||
      typeof recordedCreateIntent.authorizedAt !== "string"
    ) {
      throw new AmbiguousShipmentOperationError(
        "Address create intent is unavailable for reconciliation",
      );
    }
    mutationAuthorizedAt = new Date(recordedCreateIntent.authorizedAt);
    if (!Number.isFinite(mutationAuthorizedAt.getTime())) {
      throw new AmbiguousShipmentOperationError(
        "Address create authorization time is invalid",
      );
    }
    const recovered = (await input.client.findShipments(reference)).filter(
      (candidate) => candidate.order_id === reference,
    );
    if (recovered.length !== 1) {
      await markProviderReconciled(requestId, {
        replacementCreateOutcomeUnknown: true,
      });
      throw new AmbiguousShipmentOperationError(
        recovered.length > 1
          ? "Multiple provider shipments matched the immutable address reference"
          : "The provider has not resolved the address replacement create outcome",
      );
    }
    provider = recovered[0]!;
  }
  const policy = await loadShippingPolicyContext(input.observedAt);
  const config = getChitChatsConfig();
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
  const signatureDecisionTerms = addressSignatureDecisionTerms({
    requestId,
    sourceShipmentId: row.shipment.id,
  });
  const hasSignatureConsent =
    provider !== null ||
    (signatureRequired &&
      !row.shipment.signatureRequired &&
      (await hasSignedCustomerDecision({
        orderId: row.order.id,
        kind: "signature_requirement",
        shipmentId: row.shipment.id,
        outcomes: ["accept_signature"],
        ...signatureDecisionTerms,
      })));
  if (
    signatureRequired &&
    !row.shipment.signatureRequired &&
    !hasSignatureConsent
  ) {
    await getPrivateDb().transaction(async (tx) => {
      const decision = await issueCustomerDecisionWithExecutor(tx, {
        orderReference: row.order.orderId,
        shipmentId: row.shipment.id,
        kind: "signature_requirement",
        ...signatureDecisionTerms,
        allowedOutcomes: ["accept_signature", "decline_signature"],
        expiresAt: new Date(input.observedAt.getTime() + 24 * 60 * 60_000),
        notificationOrigin: supplementalPaymentPublicOrigin(),
      });
      const [updated] = await tx
        .update(productOrderAddressChangeRequests)
        .set({
          reconciliationState: "awaiting_signature",
          providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ signatureDecisionId: decision.id, signatureDecisionTerms })}::jsonb`,
          leaseOwner: null,
          leaseExpiresAt: null,
          stateVersion: expectedRequestStateVersion + 1,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, requestId),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              expectedRequestStateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
            isNull(productOrderAddressChangeRequests.preparedShipmentId),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!updated) throw new Error("Address signature decision state changed");
    });
    return { outcomeCode: "awaiting_signature" };
  }
  if (!provider) {
    await reserveAddressCreateIntent({
      requestId,
      jobId: input.jobId,
      expectedRequestStateVersion,
      authorizedAt: mutationAuthorizedAt,
      reference,
    });
  }
  if (!provider)
    try {
      provider = await input.client.createShipment({
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
      const recovered = (
        await input.client.findShipments(reference).catch(() => [])
      ).filter((candidate) => candidate.order_id === reference);
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
        throw new AmbiguousShipmentOperationError(
          error instanceof Error
            ? error.message
            : "Address replacement creation is ambiguous",
        );
      }
      provider = recovered[0]!;
    }
  if (!provider)
    throw new Error("Address replacement provider result is missing");
  const [latestRequestIntent] = await getPrivateDb()
    .select({
      providerReconciliation:
        productOrderAddressChangeRequests.providerReconciliation,
    })
    .from(productOrderAddressChangeRequests)
    .where(eq(productOrderAddressChangeRequests.id, requestId))
    .limit(1);
  if (latestRequestIntent?.providerReconciliation?.revocationPending === true) {
    await enqueueUnpaidProviderDraftCleanup({
      source: row.shipment,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      publicReference: reference,
      destination: recipient,
      rawShipment: stripSignedLabelUrls(provider),
      reason: "address_create_completed_after_revocation",
      now: input.observedAt,
    });
    const [revoked] = await getPrivateDb()
      .update(productOrderAddressChangeRequests)
      .set({
        status: "revoked",
        revokedAt: input.observedAt,
        reconciliationState: "revoked_cleanup_queued",
        cleanupOutcome: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ revocationPending: false, addressCreateReconciledAt: input.observedAt.toISOString(), addressCreateRecoveredProviderShipmentId: provider.id })}::jsonb`,
        stateVersion: expectedRequestStateVersion + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, requestId),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            expectedRequestStateVersion,
          ),
          eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!revoked) throw new Error("Address revocation cleanup state changed");
    return { outcomeCode: "revoked_cleanup_queued" };
  }
  const trackedPostageTypes =
    recipient.countryCode === "US"
      ? new Set(
          [...config.trackedPostageTypes].filter(
            (service) =>
              row.shipment.usShippingContractSnapshot?.importTerms === "DDU" &&
              row.shipment.usShippingContractSnapshot.allowedServiceCodes.includes(
                service,
              ),
          ),
        )
      : config.trackedPostageTypes;
  const rates = selectCustomerRates(provider.rates ?? [], trackedPostageTypes, {
    atRiskValueCents:
      row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
    destinationCountryCode: recipient.countryCode,
    estimatedDeliveryAt: provider.estimated_delivery_at,
    servicePolicies: policy.servicePolicies,
    signatureThresholdCents: signatureRequired ? 0 : Number.MAX_SAFE_INTEGER,
  });
  let selected = rates.find(
    (rate) => rate.postageType === row.shipment.selectedPostageType,
  );
  let substitutionDecisionId: string | null = null;
  let substitutionDecisionTerms: ReturnType<
    typeof addressServiceSubstitutionDecisionTerms
  > | null = null;
  if (!selected && rates[0]) {
    const substitute = rates[0];
    substitutionDecisionTerms = addressServiceSubstitutionDecisionTerms({
      requestId,
      sourceShipmentId: row.shipment.id,
      originalPostageType: row.shipment.selectedPostageType,
      substitutePostageType: substitute.postageType,
      substituteAmountCents: substitute.paymentAmountCents,
    });
    selected = substitute;
  }
  if (!selected) {
    await enqueueUnpaidProviderDraftCleanup({
      source: row.shipment,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      publicReference: reference,
      destination: recipient,
      rawShipment: stripSignedLabelUrls(provider),
      reason: "address_service_unavailable",
      now: input.observedAt,
    });
    throw providerDraftCleanupQueuedError(
      rates.length
        ? "The changed address requires a scoped signed service decision"
        : "No eligible insured tracked service is available for the changed address",
    );
  }
  if (signatureRequired && !row.shipment.signatureRequired) {
    let consumed: string | null;
    try {
      consumed = await consumeSignedCustomerDecision({
        orderId: row.order.id,
        kind: "signature_requirement",
        shipmentId: row.shipment.id,
        outcome: "accept_signature",
        ...signatureDecisionTerms,
        now: mutationAuthorizedAt,
      });
    } catch (error) {
      await enqueueUnpaidProviderDraftCleanup({
        source: row.shipment,
        providerShipmentId: provider.id,
        providerStatus: provider.status,
        publicReference: reference,
        destination: recipient,
        rawShipment: stripSignedLabelUrls(provider),
        reason: "address_signature_decision_failed",
        now: input.observedAt,
      });
      await closeAddressRequestAfterProviderCleanup({
        requestId,
        jobId: input.jobId,
        expectedRequestStateVersion,
        observedAt: input.observedAt,
        reconciliationState: "signature_decision_failed_cleanup_queued",
        detail:
          error instanceof Error ? error.message : "Signature decision failed",
      });
      return { outcomeCode: "signature_decision_failed_cleanup_queued" };
    }
    if (!consumed) {
      await enqueueUnpaidProviderDraftCleanup({
        source: row.shipment,
        providerShipmentId: provider.id,
        providerStatus: provider.status,
        publicReference: reference,
        destination: recipient,
        rawShipment: stripSignedLabelUrls(provider),
        reason: "address_signature_consent_expired",
        now: input.observedAt,
      });
      await closeAddressRequestAfterProviderCleanup({
        requestId,
        jobId: input.jobId,
        expectedRequestStateVersion,
        observedAt: input.observedAt,
        reconciliationState: "signature_consent_expired_cleanup_queued",
        detail:
          "Signature consent expired before address preparation completed",
      });
      return { outcomeCode: "signature_consent_expired_cleanup_queued" };
    }
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
    quoteExpiresAt: new Date(
      input.observedAt.getTime() + 15 * 60_000,
    ).toISOString(),
    rawShipment: stripSignedLabelUrls(provider),
  };
  try {
    await getPrivateDb().transaction(async (tx) => {
      await lockShippingCheckoutReadinessConfiguration(tx);
      await assertShippingQuoteContextCurrent({
        destinationCountryCode: proposedCountryCode,
        expectedContext: sourceQuoteContext,
        now: input.observedAt,
      });
      const [order] = await tx
        .select()
        .from(checkoutOrders)
        .where(eq(checkoutOrders.id, row.order.id))
        .for("update")
        .limit(1);
      const [source] = await tx
        .select()
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, sourceShipmentId),
            eq(productShipments.stateVersion, expectedSourceStateVersion),
          ),
        )
        .for("update")
        .limit(1);
      const [request] = await tx
        .select()
        .from(productOrderAddressChangeRequests)
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, requestId),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              expectedRequestStateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
          ),
        )
        .for("update")
        .limit(1);
      if (request?.providerReconciliation?.revocationPending === true) {
        throw new AddressRevocationPendingError();
      }
      if (
        !order ||
        order.status !== "paid" ||
        order.paymentRiskStatus !== "cleared" ||
        order.fulfillmentQuarantinedAt !== null ||
        order.activeFulfillmentShipmentId !== sourceShipmentId ||
        !source ||
        source.orderId !== order.id ||
        hasCarrierHandoff(source) ||
        !request ||
        request.status !== "approved" ||
        request.preparedShipmentId
      )
        throw new Error("Address preparation lease became stale");
      const shippingLedger = await lockNetCustomerShippingLedger(tx, order.id);
      const [sequence] = await tx
        .select({
          next: sql<number>`coalesce(max(${productShipments.sequence}), -1) + 1`,
        })
        .from(productShipments)
        .where(eq(productShipments.orderId, row.order.id));
      const quoteToken = issueShippingQuoteToken();
      const [generation] = await tx
        .insert(productShipments)
        .values({
          orderId: row.order.id,
          sequence: Number(sequence?.next ?? source.sequence + 1),
          purpose: "reshipment",
          supersedesShipmentId: source.id,
          publicReference: prepared.publicReference,
          quoteTokenHash: hashShippingQuoteToken(quoteToken),
          quoteFingerprint: `address-change:${requestId}:${row.request.leaseVersion}`,
          providerShipmentId: prepared.providerShipmentId,
          providerStatus: prepared.providerStatus,
          destination: {
            ...source.destination,
            ...row.request.proposedAddress!,
            name: row.order.customerName,
            email: row.order.customerEmail,
          },
          packageSnapshot: source.packageSnapshot,
          customsLines: source.customsLines,
          rates,
          selectedRateId: prepared.selectedRateId,
          selectedPostageType: prepared.selectedPostageType,
          quotedShippingCents: prepared.selectedRateAmountCents,
          rawShipment: prepared.rawShipment,
          quoteExpiresAt: new Date(prepared.quoteExpiresAt),
          status: substitutionDecisionTerms ? "quoted" : "ready_for_staff",
          originalHandoffDeadlineAt: source.originalHandoffDeadlineAt,
          autoRefundDeadlineAt: source.autoRefundDeadlineAt,
          calendarVersionId: source.calendarVersionId,
          usShippingContractSnapshot: source.usShippingContractSnapshot,
          deadlinePolicySnapshot: source.deadlinePolicySnapshot,
          latestEstimatedDeliveryAt: prepared.estimatedDeliveryAt
            ? new Date(prepared.estimatedDeliveryAt)
            : null,
          deliveryMaxBusinessDays: prepared.deliveryMaxBusinessDays,
          signatureRequired: prepared.signatureRequired,
          signatureRequested: prepared.signatureRequired,
        })
        .returning({
          id: productShipments.id,
          stateVersion: productShipments.stateVersion,
        });
      if (substitutionDecisionTerms) {
        const decision = await issueCustomerDecisionWithExecutor(tx, {
          orderReference: row.order.orderId,
          shipmentId: row.shipment.id,
          kind: "service_substitution",
          ...substitutionDecisionTerms,
          allowedOutcomes: ["accept_substitute", "decline_substitute"],
          expiresAt: new Date(prepared.quoteExpiresAt),
          notificationOrigin: supplementalPaymentPublicOrigin(),
        });
        substitutionDecisionId = decision.id;
      }
      const updatedRequest = await tx
        .update(productOrderAddressChangeRequests)
        .set({
          preparedShipmentId: generation!.id,
          preparedShipmentStateVersion: generation!.stateVersion,
          postageDifferenceCents:
            prepared.selectedRateAmountCents - shippingLedger.netShippingCents,
          providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ preparedShipment: prepared, substitutionDecisionId, substitutionDecisionTerms, shippingLedgerVersion: shippingLedger.version, netCustomerShippingCents: shippingLedger.netShippingCents })}::jsonb`,
          reconciliationState: substitutionDecisionTerms
            ? "awaiting_service_substitution"
            : "prepared",
          leaseOwner: null,
          leaseExpiresAt: null,
          stateVersion: expectedRequestStateVersion + 1,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, requestId),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              expectedRequestStateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!updatedRequest.length)
        throw new Error(
          "Address preparation request changed during persistence",
        );
    });
  } catch (error) {
    await enqueueUnpaidProviderDraftCleanup({
      source: row.shipment,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      publicReference: reference,
      destination: recipient,
      rawShipment: stripSignedLabelUrls(provider),
      reason: "address_preparation_persistence_failed",
      now: input.observedAt,
    });
    if (error instanceof AddressRevocationPendingError) {
      const [revoked] = await getPrivateDb()
        .update(productOrderAddressChangeRequests)
        .set({
          status: "revoked",
          revokedAt: input.observedAt,
          reconciliationState: "revoked_cleanup_queued",
          cleanupOutcome: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ revocationPending: false, addressCreateReconciledAt: input.observedAt.toISOString(), addressCreateRecoveredProviderShipmentId: provider.id })}::jsonb`,
          stateVersion: expectedRequestStateVersion + 1,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, requestId),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              expectedRequestStateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
            eq(productOrderAddressChangeRequests.status, "approved"),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!revoked)
        throw new Error("Address revocation persistence state changed");
      return { outcomeCode: "revoked_cleanup_queued" };
    }
    throw providerDraftCleanupQueuedError(
      error instanceof Error
        ? error.message
        : "Address preparation could not be persisted",
    );
  }
  return {
    outcomeCode: substitutionDecisionTerms
      ? "awaiting_service_substitution"
      : "prepared",
  };
}

async function resumeAddressServiceSubstitution(input: {
  jobId: string;
  requestId: string;
  sourceShipmentId: string;
  expectedRequestStateVersion: number;
  expectedSourceStateVersion: number;
  decisionId: string;
  preparedShipmentId: string;
  expectedPreparedStateVersion: number;
  observedAt: Date;
}): Promise<{ outcomeCode: string }> {
  return getPrivateDb().transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(productOrderAddressChangeRequests)
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, input.requestId),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            input.expectedRequestStateVersion,
          ),
          eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        ),
      )
      .for("update")
      .limit(1);
    const [source] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.sourceShipmentId))
      .for("update")
      .limit(1);
    const [prepared] = await tx
      .select()
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, input.preparedShipmentId),
          eq(productShipments.stateVersion, input.expectedPreparedStateVersion),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !request ||
      request.status !== "approved" ||
      request.reconciliationState !== "processing" ||
      request.expectedSourceShipmentId !== source?.id ||
      request.preparedShipmentId !== prepared?.id ||
      request.preparedShipmentStateVersion !== prepared.stateVersion ||
      source.orderId !== request.orderId ||
      prepared.orderId !== request.orderId ||
      prepared.status !== "quoted" ||
      prepared.purchasedAt ||
      !prepared.selectedPostageType ||
      prepared.quotedShippingCents === null ||
      prepared.quotedShippingCents <= 0
    ) {
      throw new Error("Address service substitution resume is stale");
    }
    if (source.stateVersion !== input.expectedSourceStateVersion) {
      return closePreparedServiceSubstitutionForReprice(tx, {
        request,
        prepared,
        decisionId: input.decisionId,
        jobId: input.jobId,
        observedAt: input.observedAt,
        reconciliationState: "service_substitution_source_changed",
        cleanupReason: "address_service_substitution_source_changed",
        outcomeCode: "service_substitution_source_changed",
        expectedSourceShipmentStateVersion: source.stateVersion,
      });
    }
    if (prepared.quoteExpiresAt <= input.observedAt) {
      const fencedVersion = prepared.stateVersion + 1;
      const [fenced] = await tx
        .update(productShipments)
        .set({
          status: "abandoned",
          stateVersion: fencedVersion,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productShipments.id, prepared.id),
            eq(productShipments.stateVersion, prepared.stateVersion),
            eq(productShipments.status, "quoted"),
            isNull(productShipments.purchasedAt),
          ),
        )
        .returning({ id: productShipments.id });
      if (!fenced) {
        throw new Error("Expired substitute draft changed before cleanup");
      }
      const cleanupPayload = {
        requestId: request.id,
        reason: "address_service_substitution_quote_expired",
        expectedShipmentStateVersion: fencedVersion,
      };
      await tx
        .insert(productShipmentJobs)
        .values({
          shipmentId: prepared.id,
          type: "cleanup",
          status: "queued",
          idempotencyKey: `address-service-substitution-expired/${input.decisionId}`,
          operationPayloadHash: hashOperationPayload(cleanupPayload),
          payload: cleanupPayload,
        })
        .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
      const [decisionClosed] = await tx
        .update(productOrderCustomerDecisions)
        .set({
          consumedAt: input.observedAt,
          processedAt: input.observedAt,
          stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderCustomerDecisions.id, input.decisionId),
            eq(productOrderCustomerDecisions.status, "selected"),
            eq(
              productOrderCustomerDecisions.selectedOutcome,
              "accept_substitute",
            ),
            isNull(productOrderCustomerDecisions.consumedAt),
          ),
        )
        .returning({ id: productOrderCustomerDecisions.id });
      if (!decisionClosed) {
        throw new Error("Expired substitution decision changed");
      }
      const [reprice] = await tx
        .update(productOrderAddressChangeRequests)
        .set({
          preparedShipmentId: null,
          preparedShipmentStateVersion: null,
          reconciliationState: "service_substitution_expired",
          cleanupOutcome: "queued",
          providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'preparedShipment' - 'substitutionDecisionId' - 'substitutionDecisionTerms') || ${JSON.stringify({ substitutionDecisionOutcome: "quote_expired", substitutionDecisionClosedAt: input.observedAt.toISOString() })}::jsonb`,
          leaseOwner: null,
          leaseExpiresAt: null,
          stateVersion: request.stateVersion + 1,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, request.id),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              request.stateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!reprice) throw new Error("Expired substitution state changed");
      return { outcomeCode: "service_substitution_quote_expired" };
    }
    const decisionTerms = addressServiceSubstitutionDecisionTerms({
      requestId: request.id,
      sourceShipmentId: source.id,
      originalPostageType: source.selectedPostageType,
      substitutePostageType: prepared.selectedPostageType,
      substituteAmountCents: prepared.quotedShippingCents,
    });
    const consumed = await consumeSignedCustomerDecisionWithExecutor(tx, {
      orderId: request.orderId,
      kind: "service_substitution",
      shipmentId: source.id,
      outcome: "accept_substitute",
      ...decisionTerms,
      now: input.observedAt,
    });
    if (consumed !== input.decisionId) {
      throw new Error("Exact substitute service consent is unavailable");
    }
    const [ready] = await tx
      .update(productShipments)
      .set({
        status: "ready_for_staff",
        stateVersion: prepared.stateVersion + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(productShipments.id, prepared.id),
          eq(productShipments.stateVersion, prepared.stateVersion),
          eq(productShipments.status, "quoted"),
          isNull(productShipments.purchasedAt),
        ),
      )
      .returning({ stateVersion: productShipments.stateVersion });
    if (!ready)
      throw new Error("Substitute service draft changed before consent");
    const [updated] = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        preparedShipmentStateVersion: ready.stateVersion,
        reconciliationState: "prepared",
        providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ substitutionDecisionId: input.decisionId, substitutionAcceptedAt: input.observedAt.toISOString() })}::jsonb`,
        leaseOwner: null,
        leaseExpiresAt: null,
        stateVersion: request.stateVersion + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, request.id),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            request.stateVersion,
          ),
          eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!updated) throw new Error("Address substitution state changed");
    return { outcomeCode: "service_substitution_accepted" };
  });
}

async function reconcileAmbiguousAddressCreateForCleanup(input: {
  client: ChitChatsClient;
  jobId: string;
  observedAt: Date;
  request: typeof productOrderAddressChangeRequests.$inferSelect;
  order: typeof checkoutOrders.$inferSelect;
  source: typeof productShipments.$inferSelect;
  expectedRequestStateVersion: number;
  revoked: boolean;
}): Promise<{ outcomeCode: string }> {
  const intent = input.request.providerReconciliation?.addressCreateIntent as
    | Record<string, unknown>
    | null
    | undefined;
  const reference = buildAddressReplacementPublicReference({
    requestId: input.request.id,
    attemptIdentity: input.request.attemptIdentity ?? input.jobId,
  });
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    intent.reference !== reference
  ) {
    throw new AmbiguousShipmentOperationError(
      "Address create intent is unavailable for cleanup reconciliation",
    );
  }
  const recovered = (await input.client.findShipments(reference)).filter(
    (candidate) => candidate.order_id === reference,
  );
  if (recovered.length !== 1) {
    throw new AmbiguousShipmentOperationError(
      recovered.length > 1
        ? "Multiple address drafts matched cleanup reconciliation"
        : "Address draft cleanup reconciliation remains unresolved",
    );
  }
  const recipient = addressChangeRecipient({
    proposedAddress:
      input.request.proposedAddress ?? input.request.originalAddress,
    originalDestination: input.source.destination,
    customerName: input.order.customerName,
    customerEmail: input.order.customerEmail,
  });
  await enqueueUnpaidProviderDraftCleanup({
    source: input.source,
    providerShipmentId: recovered[0]!.id,
    providerStatus: recovered[0]!.status,
    publicReference: reference,
    destination: recipient,
    rawShipment: stripSignedLabelUrls(recovered[0]!),
    reason: input.revoked
      ? "address_create_reconciled_after_revocation"
      : "address_create_reconciled_after_source_change",
    now: input.observedAt,
  });
  const [updated] = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      ...(input.revoked
        ? { status: "revoked" as const, revokedAt: input.observedAt }
        : {}),
      reconciliationState: input.revoked
        ? "revoked_cleanup_queued"
        : "source_generation_changed_cleanup_queued",
      cleanupOutcome: "queued",
      providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ addressCreateReconciledAt: input.observedAt.toISOString(), addressCreateRecoveredProviderShipmentId: recovered[0]!.id, revocationPending: false })}::jsonb`,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: input.expectedRequestStateVersion + 1,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, input.request.id),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          input.expectedRequestStateVersion,
        ),
        eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!updated) throw new Error("Address cleanup reconciliation state changed");
  return {
    outcomeCode: input.revoked
      ? "revoked_cleanup_queued"
      : "source_generation_changed_cleanup_queued",
  };
}

async function closeAddressRequestAfterProviderCleanup(input: {
  requestId: string;
  jobId: string;
  expectedRequestStateVersion: number;
  observedAt: Date;
  reconciliationState: string;
  detail: string;
}): Promise<void> {
  const [updated] = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      reconciliationState: input.reconciliationState,
      cleanupOutcome: "queued",
      providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'signatureDecisionId' - 'signatureDecisionTerms') || ${JSON.stringify({ signatureDecisionOutcome: input.reconciliationState, signatureDecisionDetail: input.detail, signatureDecisionClosedAt: input.observedAt.toISOString() })}::jsonb`,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: input.expectedRequestStateVersion + 1,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, input.requestId),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          input.expectedRequestStateVersion,
        ),
        eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!updated) throw new Error("Address cleanup state changed");
}

async function closePreparedServiceSubstitutionForReprice(
  tx: CustomerDecisionExecutor,
  input: {
    request: typeof productOrderAddressChangeRequests.$inferSelect;
    prepared: typeof productShipments.$inferSelect;
    decisionId: string;
    jobId: string;
    observedAt: Date;
    reconciliationState: string;
    cleanupReason: string;
    outcomeCode: string;
    expectedSourceShipmentStateVersion: number;
  },
): Promise<{ outcomeCode: string }> {
  const fencedVersion = input.prepared.stateVersion + 1;
  const [fenced] = await tx
    .update(productShipments)
    .set({
      status: "abandoned",
      stateVersion: fencedVersion,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productShipments.id, input.prepared.id),
        eq(productShipments.stateVersion, input.prepared.stateVersion),
        eq(productShipments.status, "quoted"),
        isNull(productShipments.purchasedAt),
      ),
    )
    .returning({ id: productShipments.id });
  if (!fenced)
    throw new Error("Substitute draft changed before reprice cleanup");
  const cleanupPayload = {
    requestId: input.request.id,
    reason: input.cleanupReason,
    expectedShipmentStateVersion: fencedVersion,
  };
  await tx
    .insert(productShipmentJobs)
    .values({
      shipmentId: input.prepared.id,
      type: "cleanup",
      status: "queued",
      idempotencyKey: `${input.cleanupReason}/${input.decisionId}`,
      operationPayloadHash: hashOperationPayload(cleanupPayload),
      payload: cleanupPayload,
    })
    .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
  const [decisionClosed] = await tx
    .update(productOrderCustomerDecisions)
    .set({
      consumedAt: input.observedAt,
      processedAt: input.observedAt,
      stateVersion: sql`${productOrderCustomerDecisions.stateVersion} + 1`,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productOrderCustomerDecisions.id, input.decisionId),
        eq(productOrderCustomerDecisions.status, "selected"),
        eq(productOrderCustomerDecisions.selectedOutcome, "accept_substitute"),
        isNull(productOrderCustomerDecisions.consumedAt),
      ),
    )
    .returning({ id: productOrderCustomerDecisions.id });
  if (!decisionClosed)
    throw new Error("Substitution decision changed before reprice");
  const [requestUpdated] = await tx
    .update(productOrderAddressChangeRequests)
    .set({
      preparedShipmentId: null,
      preparedShipmentStateVersion: null,
      expectedSourceShipmentStateVersion:
        input.expectedSourceShipmentStateVersion,
      reconciliationState: input.reconciliationState,
      cleanupOutcome: "queued",
      providerReconciliation: sql`(coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) - 'preparedShipment' - 'substitutionDecisionId' - 'substitutionDecisionTerms') || ${JSON.stringify({ substitutionDecisionOutcome: input.reconciliationState, substitutionDecisionClosedAt: input.observedAt.toISOString() })}::jsonb`,
      leaseOwner: null,
      leaseExpiresAt: null,
      stateVersion: input.request.stateVersion + 1,
      updatedAt: input.observedAt,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, input.request.id),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          input.request.stateVersion,
        ),
        eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!requestUpdated) throw new Error("Address reprice state changed");
  return { outcomeCode: input.outcomeCode };
}

async function refreshPreparedAddressChangeShipment(input: {
  jobId: string;
  requestId: string;
  sourceShipmentId: string;
  expectedRequestStateVersion: number;
  expectedSourceStateVersion: number;
  preparedShipmentId: string;
  expectedPreparedStateVersion: number;
  refreshIntentAt: Date;
  shipDate: string;
  client: ChitChatsClient;
  observedAt: Date;
  outcomeUnknown: boolean;
}): Promise<{ outcomeCode: string }> {
  const [row] = await getPrivateDb()
    .select({
      request: productOrderAddressChangeRequests,
      order: checkoutOrders,
      source: productShipments,
    })
    .from(productOrderAddressChangeRequests)
    .innerJoin(
      checkoutOrders,
      eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
    )
    .innerJoin(
      productShipments,
      eq(productShipments.id, input.sourceShipmentId),
    )
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, input.requestId),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          input.expectedRequestStateVersion,
        ),
        eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        eq(productShipments.stateVersion, input.expectedSourceStateVersion),
      ),
    )
    .limit(1);
  const prepared = await getPrivateDb().query.productShipments.findFirst({
    where: and(
      eq(productShipments.id, input.preparedShipmentId),
      eq(productShipments.orderId, row?.order.id ?? input.preparedShipmentId),
      eq(productShipments.stateVersion, input.expectedPreparedStateVersion),
    ),
  });
  if (
    !row?.request.proposedAddress ||
    row.request.preparedShipmentId !== input.preparedShipmentId ||
    row.request.preparedShipmentStateVersion !==
      input.expectedPreparedStateVersion ||
    row.order.activeFulfillmentShipmentId !== input.sourceShipmentId ||
    row.order.status !== "paid" ||
    row.order.paymentRiskStatus !== "cleared" ||
    row.order.fulfillmentQuarantinedAt !== null ||
    !prepared?.providerShipmentId ||
    !prepared.selectedPostageType ||
    !["quoted", "ready_for_staff"].includes(prepared.status) ||
    hasCarrierHandoff(row.source)
  ) {
    throw new Error("The prepared address generation is no longer refreshable");
  }
  const quoteContext = parseShippingQuoteContextSnapshot(
    prepared.deadlinePolicySnapshot,
  );
  if (!quoteContext) {
    throw new Error(
      "The prepared address generation has no certified quote context",
    );
  }
  const destinationCountryCode =
    prepared.destination.countryCode ??
    (prepared.destination.country.toUpperCase() === "CANADA" ? "CA" : "US");
  await assertShippingQuoteContextCurrent({
    destinationCountryCode,
    expectedContext: quoteContext,
    now: input.observedAt,
  });
  await assertAddressProviderMutationFence({
    requestId: input.requestId,
    jobId: input.jobId,
    expectedRequestStateVersion: input.expectedRequestStateVersion,
    sourceShipmentId: input.sourceShipmentId,
    expectedSourceStateVersion: input.expectedSourceStateVersion,
    preparedShipmentId: input.preparedShipmentId,
    expectedPreparedStateVersion: input.expectedPreparedStateVersion,
    destinationCountryCode,
    quoteContext,
    now: input.observedAt,
  });

  const refreshIntent = {
    packageType: prepared.packageSnapshot.packageType,
    weightGrams: prepared.packageSnapshot.totalWeightGrams,
    lengthCm: prepared.packageSnapshot.lengthCm,
    widthCm: prepared.packageSnapshot.widthCm,
    heightCm: prepared.packageSnapshot.heightCm,
    shipDate: input.shipDate,
    signatureRequested: prepared.signatureRequired,
  };
  let provider: ChitChatsShipment;
  if (input.outcomeUnknown) {
    provider = await input.client.getShipment(prepared.providerShipmentId);
    assertProviderRefreshMatches(provider, refreshIntent);
  } else {
    try {
      provider = await input.client.refreshShipment(
        prepared.providerShipmentId,
        refreshIntent,
      );
      assertProviderRefreshMatches(provider, refreshIntent);
    } catch (error) {
      try {
        provider = await input.client.getShipment(prepared.providerShipmentId);
        assertProviderRefreshMatches(provider, refreshIntent);
      } catch {
        throw new AmbiguousShipmentOperationError(
          error instanceof Error
            ? error.message
            : "The prepared address quote refresh outcome is unknown",
        );
      }
    }
  }
  if (provider.id !== prepared.providerShipmentId) {
    throw new AmbiguousShipmentOperationError(
      "The provider returned a different prepared address shipment",
    );
  }
  if (provider.postage_purchase_date) {
    throw new Error(
      "The prepared address generation was unexpectedly purchased",
    );
  }
  const policy = await loadShippingPolicyContext(input.observedAt);
  const config = getChitChatsConfig();
  const trackedPostageTypes =
    destinationCountryCode === "US"
      ? new Set(
          [...config.trackedPostageTypes].filter(
            (service) =>
              prepared.usShippingContractSnapshot &&
              "importTerms" in prepared.usShippingContractSnapshot &&
              prepared.usShippingContractSnapshot.importTerms === "DDU" &&
              prepared.usShippingContractSnapshot.allowedServiceCodes.includes(
                service,
              ),
          ),
        )
      : config.trackedPostageTypes;
  const rates = selectCustomerRates(provider.rates ?? [], trackedPostageTypes, {
    atRiskValueCents:
      row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
    destinationCountryCode,
    estimatedDeliveryAt: provider.estimated_delivery_at,
    servicePolicies: policy.servicePolicies,
    signatureThresholdCents: prepared.signatureRequired
      ? 0
      : Number.MAX_SAFE_INTEGER,
  });
  const selected = rates.find(
    (rate) => rate.postageType === prepared.selectedPostageType,
  );
  if (!selected) {
    await getPrivateDb()
      .update(productOrderAddressChangeRequests)
      .set({
        leaseExpiresAt: null,
        leaseOwner: null,
        providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify(
          {
            preparedRefreshManualReview: true,
            preparedRefreshReason: "certified_service_unavailable",
          },
        )}::jsonb`,
        reconciliationState: "manual_review",
        stateVersion: input.expectedRequestStateVersion + 1,
        updatedAt: input.observedAt,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, input.requestId),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            input.expectedRequestStateVersion,
          ),
          eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
        ),
      );
    await openProductShippingCase({
      orderId: row.order.id,
      shipmentId: row.source.id,
      type: "postage_failure",
      cause: "address_change_paid_quote_refresh_service_unavailable",
    });
    await fencePreparedGenerationAndEnqueueCleanup({
      shipmentId: input.preparedShipmentId,
      expectedStateVersion: input.expectedPreparedStateVersion,
      reason: "address_prepared_refresh_no_eligible_rates",
      now: input.observedAt,
    });
    return { outcomeCode: "prepared_refresh_manual_review" };
  }
  const quoteExpiresAt = new Date(input.observedAt.getTime() + 15 * 60_000);
  const refreshedPrepared: PreparedAddressChangeShipment = {
    providerShipmentId: provider.id,
    providerStatus: provider.status,
    publicReference: prepared.publicReference,
    selectedPostageType: selected.postageType,
    selectedRateId: selected.id,
    selectedRateAmountCents: selected.paymentAmountCents,
    ...(selected.deliveryMaxBusinessDays
      ? { deliveryMaxBusinessDays: selected.deliveryMaxBusinessDays }
      : {}),
    ...(selected.estimatedDeliveryAt
      ? { estimatedDeliveryAt: selected.estimatedDeliveryAt }
      : {}),
    signatureRequired: prepared.signatureRequired,
    quoteExpiresAt: quoteExpiresAt.toISOString(),
    rawShipment: stripSignedLabelUrls(provider),
  };
  try {
    await getPrivateDb().transaction(async (tx) => {
      await lockShippingCheckoutReadinessConfiguration(tx);
      await assertShippingQuoteContextCurrent({
        destinationCountryCode,
        expectedContext: quoteContext,
        now: input.observedAt,
      });
      const [lockedOrder] = await tx
        .select()
        .from(checkoutOrders)
        .where(eq(checkoutOrders.id, row.order.id))
        .for("update")
        .limit(1);
      const [lockedSource] = await tx
        .select()
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, input.sourceShipmentId),
            eq(productShipments.stateVersion, input.expectedSourceStateVersion),
          ),
        )
        .for("update")
        .limit(1);
      const [lockedRequest] = await tx
        .select()
        .from(productOrderAddressChangeRequests)
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, input.requestId),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              input.expectedRequestStateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
            eq(
              productOrderAddressChangeRequests.preparedShipmentId,
              input.preparedShipmentId,
            ),
            eq(
              productOrderAddressChangeRequests.preparedShipmentStateVersion,
              input.expectedPreparedStateVersion,
            ),
          ),
        )
        .for("update")
        .limit(1);
      const [lockedPrepared] = await tx
        .select()
        .from(productShipments)
        .where(
          and(
            eq(productShipments.id, input.preparedShipmentId),
            eq(
              productShipments.stateVersion,
              input.expectedPreparedStateVersion,
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !lockedOrder ||
        lockedOrder.status !== "paid" ||
        lockedOrder.paymentRiskStatus !== "cleared" ||
        lockedOrder.fulfillmentQuarantinedAt !== null ||
        lockedOrder.activeFulfillmentShipmentId !== input.sourceShipmentId ||
        !lockedSource ||
        lockedSource.orderId !== lockedOrder.id ||
        hasCarrierHandoff(lockedSource) ||
        !lockedRequest ||
        lockedRequest.status !== "approved" ||
        !lockedPrepared
      ) {
        throw new Error("The prepared address refresh lease became stale");
      }
      const shippingLedger = await lockNetCustomerShippingLedger(
        tx,
        lockedOrder.id,
      );
      const newDifferenceCents =
        selected.paymentAmountCents - shippingLedger.netShippingCents;
      const variance = {
        absorbedIncreaseCents: Math.max(0, newDifferenceCents),
        supplementRefundCents: Math.max(0, -newDifferenceCents),
      };
      const nextPreparedStateVersion = lockedPrepared.stateVersion + 1;
      const updatedPrepared = await tx
        .update(productShipments)
        .set({
          deliveryMaxBusinessDays: selected.deliveryMaxBusinessDays,
          latestEstimatedDeliveryAt: selected.estimatedDeliveryAt
            ? new Date(selected.estimatedDeliveryAt)
            : null,
          providerStatus: provider.status,
          quoteExpiresAt,
          quotedShippingCents: selected.paymentAmountCents,
          rates,
          rawShipment: stripSignedLabelUrls(provider),
          selectedRateId: selected.id,
          stateVersion: nextPreparedStateVersion,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productShipments.id, lockedPrepared.id),
            eq(productShipments.stateVersion, lockedPrepared.stateVersion),
          ),
        )
        .returning({ id: productShipments.id });
      if (!updatedPrepared.length) {
        throw new Error(
          "The prepared address generation changed during refresh",
        );
      }
      const updatedRequest = await tx
        .update(productOrderAddressChangeRequests)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          postageDifferenceCents: newDifferenceCents,
          preparedShipmentStateVersion: nextPreparedStateVersion,
          providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify(
            {
              absorbedPostPaymentIncreaseCents: variance.absorbedIncreaseCents,
              postPaymentDecreaseRefundCents: variance.supplementRefundCents,
              preparedRefreshAt: input.observedAt.toISOString(),
              preparedShipment: refreshedPrepared,
              shippingLedgerVersion: shippingLedger.version,
              netCustomerShippingCents: shippingLedger.netShippingCents,
            },
          )}::jsonb`,
          reconciliationState: "prepared",
          stateVersion: lockedRequest.stateVersion + 1,
          updatedAt: input.observedAt,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, lockedRequest.id),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              lockedRequest.stateVersion,
            ),
            eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!updatedRequest.length) {
        throw new Error("The prepared address request changed during refresh");
      }
    });
  } catch (error) {
    await fencePreparedGenerationAndEnqueueCleanup({
      shipmentId: input.preparedShipmentId,
      expectedStateVersion: input.expectedPreparedStateVersion,
      reason: "address_prepared_refresh_lost_fence",
      now: input.observedAt,
    }).catch(() => false);
    throw new AmbiguousShipmentOperationError(
      error instanceof Error
        ? error.message
        : "The refreshed address quote could not be persisted",
    );
  }
  return { outcomeCode: "prepared_refreshed" };
}

async function assertAddressProviderMutationFence(input: {
  requestId: string;
  jobId: string;
  expectedRequestStateVersion: number;
  sourceShipmentId: string;
  expectedSourceStateVersion: number;
  preparedShipmentId?: string;
  expectedPreparedStateVersion?: number;
  destinationCountryCode: "CA" | "US";
  quoteContext: NonNullable<
    ReturnType<typeof parseShippingQuoteContextSnapshot>
  >;
  now: Date;
}): Promise<void> {
  await getPrivateDb().transaction(async (tx) => {
    await lockShippingCheckoutReadinessConfiguration(tx);
    await assertShippingQuoteContextCurrent({
      destinationCountryCode: input.destinationCountryCode,
      expectedContext: input.quoteContext,
      now: input.now,
    });
    const [request] = await tx
      .select()
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.id, input.requestId))
      .for("update")
      .limit(1);
    const [source] = await tx
      .select()
      .from(productShipments)
      .where(eq(productShipments.id, input.sourceShipmentId))
      .for("update")
      .limit(1);
    const [order] = source?.orderId
      ? await tx
          .select()
          .from(checkoutOrders)
          .where(eq(checkoutOrders.id, source.orderId))
          .for("update")
          .limit(1)
      : [];
    const [prepared] = input.preparedShipmentId
      ? await tx
          .select()
          .from(productShipments)
          .where(eq(productShipments.id, input.preparedShipmentId))
          .for("update")
          .limit(1)
      : [];
    if (
      !request ||
      request.status !== "approved" ||
      request.stateVersion !== input.expectedRequestStateVersion ||
      request.leaseOwner !== input.jobId ||
      request.expectedSourceShipmentId !== input.sourceShipmentId ||
      !source ||
      source.stateVersion !== input.expectedSourceStateVersion ||
      hasCarrierHandoff(source) ||
      !order ||
      order.status !== "paid" ||
      order.paymentRiskStatus !== "cleared" ||
      order.fulfillmentQuarantinedAt !== null ||
      order.activeFulfillmentShipmentId !== source.id ||
      (input.preparedShipmentId !== undefined &&
        (!prepared ||
          prepared.orderId !== order.id ||
          prepared.stateVersion !== input.expectedPreparedStateVersion ||
          request.preparedShipmentId !== prepared.id))
    ) {
      throw new Error("Address provider-mutation fence is stale");
    }
  });
}

function providerDraftCleanupQueuedError(message: string): Error {
  const error = new Error(message);
  error.name = "ProviderDraftCleanupQueuedError";
  return error;
}

function requirePayloadString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Address operation payload ${key} is invalid`);
  return value;
}

function requirePayloadInteger(
  payload: Record<string, unknown>,
  key: string,
): number {
  const value = payload[key];
  if (!Number.isInteger(value))
    throw new Error(`Address operation payload ${key} is invalid`);
  return value as number;
}

function requirePayloadInstant(
  payload: Record<string, unknown>,
  key: string,
): Date {
  const value = requirePayloadString(payload, key);
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Address operation payload ${key} is invalid`);
  }
  return instant;
}

function requirePayloadDate(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = requirePayloadString(payload, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Address operation payload ${key} is invalid`);
  }
  return value;
}

function assertProviderRefreshMatches(
  shipment: ChitChatsShipment,
  intent: {
    packageType: string;
    weightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    shipDate: string;
    signatureRequested: boolean;
  },
): void {
  if (
    shipment.package_type !== intent.packageType ||
    shipment.weight_unit !== "g" ||
    providerNumericField(shipment.weight) !== intent.weightGrams ||
    shipment.size_unit !== "cm" ||
    providerNumericField(shipment.size_x) !== intent.lengthCm ||
    providerNumericField(shipment.size_y) !== intent.widthCm ||
    providerNumericField(shipment.size_z) !== intent.heightCm ||
    shipment.signature_requested !== intent.signatureRequested ||
    providerShipDate(shipment.ship_date) !== intent.shipDate
  ) {
    throw new AmbiguousShipmentOperationError(
      "The provider has not echoed the exact prepared-address refresh intent",
    );
  }
}

function providerNumericField(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function providerShipDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return /^(\d{4}-\d{2}-\d{2})T/.exec(value)?.[1] ?? null;
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

async function reserveAddressCreateIntent(input: {
  requestId: string;
  jobId: string;
  expectedRequestStateVersion: number;
  authorizedAt: Date;
  reference: string;
}): Promise<void> {
  const [reserved] = await getPrivateDb()
    .update(productOrderAddressChangeRequests)
    .set({
      providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ addressCreateIntent: { authorizedAt: input.authorizedAt.toISOString(), jobId: input.jobId, reference: input.reference } })}::jsonb`,
      updatedAt: input.authorizedAt,
    })
    .where(
      and(
        eq(productOrderAddressChangeRequests.id, input.requestId),
        eq(productOrderAddressChangeRequests.status, "approved"),
        eq(
          productOrderAddressChangeRequests.stateVersion,
          input.expectedRequestStateVersion,
        ),
        eq(productOrderAddressChangeRequests.leaseOwner, input.jobId),
      ),
    )
    .returning({ id: productOrderAddressChangeRequests.id });
  if (!reserved) {
    throw new Error("Address create intent lost its provider-mutation fence");
  }
}

export async function issueAddressChange(input: {
  orderReference: string;
  notificationOrigin?: string;
}): Promise<{ id: string; email: string; token: string }> {
  const token = issueShippingCustomerToken();
  const now = new Date();
  return getPrivateDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(checkoutOrders)
      .where(eq(checkoutOrders.orderId, input.orderReference))
      .for("update")
      .limit(1);
    const shipment = order?.activeFulfillmentShipmentId
      ? await tx.query.productShipments.findFirst({
          where: and(
            eq(productShipments.id, order.activeFulfillmentShipmentId),
            eq(productShipments.orderId, order.id),
          ),
        })
      : null;
    if (!order?.shippingAddress || order.status !== "paid" || order.redactedAt)
      throw new Error("Order does not have a shipping address");
    if (hasCarrierHandoff(shipment ?? null))
      throw new Error("Address changes are unavailable after carrier handoff");
    await revokeOpenAddressChangesInTransaction(tx, order.id, now);
    const [created] = await tx
      .insert(productOrderAddressChangeRequests)
      .values({
        orderId: order.id,
        shipmentId: shipment?.id,
        expectedSourceShipmentId: shipment?.id,
        expectedSourceShipmentStateVersion: shipment?.stateVersion,
        originalAddress: order.shippingAddress,
        tokenHash: hashShippingCustomerToken(token, "address-change"),
        expiresAt: new Date(now.getTime() + 30 * 60_000),
      })
      .returning({ id: productOrderAddressChangeRequests.id });
    await claimShippingCustomerLinkIssuance(tx, {
      orderId: order.id,
      kind: "address_change",
      targetId: created!.id,
      now,
    });
    if (input.notificationOrigin) {
      const link = new URL("/orders/address-change", input.notificationOrigin);
      link.searchParams.set("token", token);
      await sendShippingCustomerLinkEmail({
        to: order.customerEmail,
        orderReference: input.orderReference,
        link: link.toString(),
        purpose: "address-change",
        idempotencyKey: `address-change/${created!.id}`,
        orderDatabaseId: order.id,
        now,
        executor: tx,
      });
    }
    return { id: created!.id, email: order.customerEmail, token };
  });
}

export async function revokeAddressChanges(input: {
  orderReference: string;
  requestId: string;
  expectedStateVersion: number;
  requestedByAdminUserId: string;
  rationale: string;
  evidenceReference: string;
  stepUpAuthenticatedAt: Date;
}): Promise<number> {
  const now = new Date();
  const rationale = input.rationale.trim().slice(0, 1_000);
  const evidenceReference = input.evidenceReference.trim().slice(0, 500);
  if (rationale.length < 10 || evidenceReference.length < 6)
    throw new Error("Revocation rationale and evidence are required");
  if (
    input.stepUpAuthenticatedAt > now ||
    now.getTime() - input.stepUpAuthenticatedAt.getTime() > 5 * 60_000
  )
    throw new Error("Step-up authentication has expired");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.requestedByAdminUserId,
    );
    const [order] = await tx
      .select({ id: checkoutOrders.id })
      .from(checkoutOrders)
      .where(eq(checkoutOrders.orderId, input.orderReference))
      .for("update")
      .limit(1);
    if (!order) return 0;
    return revokeOpenAddressChangesInTransaction(tx, order.id, now, {
      evidenceReference,
      expectedStateVersion: input.expectedStateVersion,
      rationale,
      requestId: input.requestId,
      requestedByAdminUserId: input.requestedByAdminUserId,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
    });
  });
}

type AddressChangeTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

async function revokeOpenAddressChangesInTransaction(
  tx: AddressChangeTransaction,
  orderId: string,
  now: Date,
  authorization?: {
    evidenceReference: string;
    expectedStateVersion: number;
    rationale: string;
    requestId: string;
    requestedByAdminUserId: string;
    stepUpAuthenticatedAt: Date;
  },
): Promise<number> {
  const open = await tx
    .select({
      id: productOrderAddressChangeRequests.id,
      stateVersion: productOrderAddressChangeRequests.stateVersion,
      riskIncidentId: productOrderAddressChangeRequests.riskIncidentId,
      preparedShipmentId: productOrderAddressChangeRequests.preparedShipmentId,
      preparedShipmentStateVersion:
        productOrderAddressChangeRequests.preparedShipmentStateVersion,
      adoptionOutcome: productOrderAddressChangeRequests.adoptionOutcome,
      reconciliationState:
        productOrderAddressChangeRequests.reconciliationState,
      providerReconciliation:
        productOrderAddressChangeRequests.providerReconciliation,
    })
    .from(productOrderAddressChangeRequests)
    .where(
      and(
        eq(productOrderAddressChangeRequests.orderId, orderId),
        ...(authorization
          ? [eq(productOrderAddressChangeRequests.id, authorization.requestId)]
          : []),
        inArray(productOrderAddressChangeRequests.status, [
          "pending_customer",
          "submitted",
          "risk_review",
          "approved",
        ]),
      ),
    )
    .for("update");
  if (!open.length) return 0;
  const ambiguousCreates = open.filter(
    (request) =>
      !request.preparedShipmentId &&
      request.reconciliationState === "processing" &&
      request.providerReconciliation?.addressCreateIntent,
  );
  if (ambiguousCreates.length && !authorization) {
    throw new Error(
      "The prior address provider create must be reconciled before issuing another address change",
    );
  }
  if (
    authorization &&
    (open.length !== 1 ||
      open[0]!.stateVersion !== authorization.expectedStateVersion)
  )
    throw new Error("Address change revocation version is stale");
  const requestIds = open.map((request) => request.id);
  const [order] = await tx
    .select({
      orderReference: checkoutOrders.orderId,
      shippingPolicyVersion: checkoutOrders.shippingPolicyVersion,
    })
    .from(checkoutOrders)
    .where(eq(checkoutOrders.id, orderId))
    .limit(1);
  if (!order) throw new Error("Address-change order no longer exists");
  const obligations = await tx
    .select()
    .from(orderPaymentObligations)
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        eq(orderPaymentObligations.purpose, "address_increase"),
        inArray(orderPaymentObligations.status, ["pending", "paid"]),
        inArray(orderPaymentObligations.sourceReferenceId, requestIds),
      ),
    )
    .for("update");
  const paidObligations = obligations.filter(
    (candidate) => candidate.status === "paid",
  );
  if (paidObligations.length && !authorization) {
    throw new Error(
      "A paid address supplement requires explicit owner-authorized revocation",
    );
  }
  if (authorization) {
    await tx.insert(fulfillmentOwnerActions).values({
      targetType: "address_change",
      targetId: authorization.requestId,
      action: "address_change_revocation_executed",
      adminUserId: authorization.requestedByAdminUserId,
      policyVersion: order.shippingPolicyVersion ?? "unconfigured",
      rationale: authorization.rationale,
      evidence: {
        evidenceReference: authorization.evidenceReference,
        expectedStateVersion: authorization.expectedStateVersion,
        paidObligationIds: paidObligations.map((obligation) => obligation.id),
        preparedShipmentIds: open
          .map((request) => request.preparedShipmentId)
          .filter((id): id is string => Boolean(id)),
      },
      stepUpAuthenticatedAt: authorization.stepUpAuthenticatedAt,
      coolingOffUntil: now,
      executedAt: now,
    });
  }
  for (const obligation of paidObligations) {
    const transactions = await tx
      .select()
      .from(orderPaymentTransactions)
      .where(eq(orderPaymentTransactions.obligationId, obligation.id))
      .for("update");
    if (
      transactions.length !== 1 ||
      transactions[0]!.amountCents !== obligation.totalAmountCents ||
      transactions[0]!.currency.toUpperCase() !==
        obligation.currency.toUpperCase() ||
      obligation.merchandiseAmountCents !== 0 ||
      obligation.taxAmountCents !== 0 ||
      obligation.shippingAmountCents !== obligation.totalAmountCents
    ) {
      throw new Error(
        "Paid address supplement cannot be revoked without an exact immutable capture",
      );
    }
    const transaction = transactions[0]!;
    const reservedShippingRefunds = await tx
      .select({ amountCents: productOrderRefunds.amountCents })
      .from(productOrderRefunds)
      .innerJoin(
        productOrderAdjustments,
        eq(productOrderRefunds.adjustmentId, productOrderAdjustments.id),
      )
      .where(
        and(
          eq(productOrderRefunds.paymentTransactionId, transaction.id),
          eq(productOrderAdjustments.direction, "refund"),
          eq(productOrderAdjustments.component, "outbound_shipping"),
          inArray(productOrderRefunds.status, [
            "queued",
            "processing",
            "succeeded",
            "outcome_unknown",
            "manual_review",
          ]),
          isNull(productOrderRefunds.fulfillmentQuarantinedAt),
        ),
      )
      .for("update", { of: productOrderRefunds });
    const reservedCents = reservedShippingRefunds.reduce(
      (total, refund) => total + refund.amountCents,
      0,
    );
    const remainingCents = obligation.shippingAmountCents - reservedCents;
    if (remainingCents < 0) {
      throw new Error("Address supplement refund ledger exceeds its capture");
    }
    if (remainingCents > 0) {
      await queueProductOrderRefundAllocationsInTransaction(tx, {
        orderReference: order.orderReference,
        paymentTransactionId: transaction.id,
        amountCents: remainingCents,
        component: "outbound_shipping",
        sourceAddressRequestId: obligation.sourceReferenceId ?? undefined,
        reason: "Address change revoked before fulfillment adoption",
        automated: true,
      });
    }
  }
  await tx
    .update(orderPaymentObligations)
    .set({ status: "superseded", updatedAt: now })
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        eq(orderPaymentObligations.purpose, "address_increase"),
        eq(orderPaymentObligations.status, "pending"),
        inArray(orderPaymentObligations.sourceReferenceId, requestIds),
      ),
    );
  const activeRiskIncidentIds = open
    .map((request) => request.riskIncidentId)
    .filter((id): id is string => Boolean(id));
  if (activeRiskIncidentIds.length) {
    await tx
      .update(productPaymentRiskIncidents)
      .set({
        status: "not_required",
        outcome: "address_change_revoked",
        reviewedAt: now,
        stateVersion: sql`${productPaymentRiskIncidents.stateVersion} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          inArray(productPaymentRiskIncidents.id, activeRiskIncidentIds),
          inArray(productPaymentRiskIncidents.status, [
            "pending",
            "review_required",
          ]),
        ),
      );
    const remainingActiveIncidents = await tx
      .select({ reasonCodes: productPaymentRiskIncidents.reasonCodes })
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
      .for("update");
    const remainingReasonCodes = [
      ...new Set(
        remainingActiveIncidents.flatMap((incident) => incident.reasonCodes),
      ),
    ];
    const paymentEvidence = await tx
      .select({ riskStatus: orderPaymentTransactions.riskStatus })
      .from(orderPaymentTransactions)
      .innerJoin(
        orderPaymentObligations,
        eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
      )
      .where(
        and(
          eq(orderPaymentObligations.orderId, orderId),
          isNull(orderPaymentObligations.quarantinedAt),
        ),
      )
      .for("update", { of: orderPaymentTransactions });
    const authoritativePaymentRiskCleared =
      paymentEvidence.length > 0 &&
      paymentEvidence.every(
        (transaction) => transaction.riskStatus === "cleared",
      );
    await tx
      .update(checkoutOrders)
      .set(
        remainingActiveIncidents.length
          ? {
              paymentRiskStatus: "review_required",
              paymentRiskAssessedAt: now,
              paymentRiskSource: "address_change_revocation",
              fraudClassification: "high",
              fraudRiskReasons: remainingReasonCodes,
              fraudClearedAt: null,
              fulfillmentClearedAt: null,
              updatedAt: now,
            }
          : authoritativePaymentRiskCleared
            ? {
                paymentRiskStatus: "cleared",
                paymentRiskAssessedAt: now,
                paymentRiskSource: "address_change_revocation",
                fraudClassification: "low",
                fraudRiskReasons: [],
                fraudClearedAt: now,
                updatedAt: now,
              }
            : {
                paymentRiskStatus: "review_required",
                paymentRiskAssessedAt: now,
                paymentRiskSource: "address_change_revocation",
                fraudClassification: "high",
                fraudRiskReasons: ["AUTHORITATIVE_PAYMENT_RISK_UNAVAILABLE"],
                fraudClearedAt: null,
                fulfillmentClearedAt: null,
                updatedAt: now,
              },
      )
      .where(eq(checkoutOrders.id, orderId));
  }
  for (const request of open) {
    if (
      !request.preparedShipmentId ||
      request.preparedShipmentStateVersion === null ||
      request.adoptionOutcome === "adopted"
    ) {
      continue;
    }
    const [preparedShipment] = await tx
      .select({
        purchasedAt: productShipments.purchasedAt,
        stateVersion: productShipments.stateVersion,
        status: productShipments.status,
      })
      .from(productShipments)
      .where(eq(productShipments.id, request.preparedShipmentId))
      .for("update")
      .limit(1);
    if (!preparedShipment)
      throw new Error("Prepared address shipment no longer exists");
    if (
      preparedShipment.status === "purchase_pending" &&
      !preparedShipment.purchasedAt
    )
      throw new Error(
        "Prepared address postage outcome must be reconciled before revocation",
      );
    const purchased =
      Boolean(preparedShipment.purchasedAt) ||
      preparedShipment.status === "label_ready";
    if (purchased && !authorization)
      throw new Error(
        "Purchased address postage requires explicit owner-authorized revocation",
      );
    const payload = {
      requestId: request.id,
      reason: purchased
        ? "address_change_revoked_purchased_postage"
        : "address_change_revoked",
      expectedShipmentStateVersion: preparedShipment.stateVersion,
    };
    await tx
      .insert(productShipmentJobs)
      .values({
        shipmentId: request.preparedShipmentId,
        type: purchased ? "refund" : "cleanup",
        status: "queued",
        idempotencyKey: purchased
          ? `address-prepared-refund/${request.id}/${request.preparedShipmentId}`
          : `address-prepared-cleanup/${request.id}/${request.preparedShipmentId}`,
        operationPayloadHash: hashOperationPayload(payload),
        payload,
      })
      .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
  }
  for (const request of ambiguousCreates) {
    await tx
      .update(productOrderAddressChangeRequests)
      .set({
        providerReconciliation: sql`coalesce(${productOrderAddressChangeRequests.providerReconciliation}, '{}'::jsonb) || ${JSON.stringify({ revocationPending: true, revocationRequestedAt: now.toISOString() })}::jsonb`,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, request.id),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            request.stateVersion,
          ),
          eq(productOrderAddressChangeRequests.status, "approved"),
        ),
      );
  }
  const terminalRequestIds = requestIds.filter(
    (id) => !ambiguousCreates.some((request) => request.id === id),
  );
  const revoked = terminalRequestIds.length
    ? await tx
        .update(productOrderAddressChangeRequests)
        .set({
          status: "revoked",
          revokedAt: now,
          cleanupOutcome: sql`case when ${productOrderAddressChangeRequests.preparedShipmentId} is not null and coalesce(${productOrderAddressChangeRequests.adoptionOutcome}, '') <> 'adopted' then 'queued' else ${productOrderAddressChangeRequests.cleanupOutcome} end`,
          stateVersion: sql`${productOrderAddressChangeRequests.stateVersion} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            inArray(productOrderAddressChangeRequests.id, terminalRequestIds),
            inArray(productOrderAddressChangeRequests.status, [
              "pending_customer",
              "submitted",
              "risk_review",
              "approved",
            ]),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id })
    : [];
  return revoked.length + ambiguousCreates.length;
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
  const proposedAddress = canonicalizeReplacementAddress(input.proposedAddress);
  const policy = await loadShippingPolicyContext(now);
  return getPrivateDb().transaction(async (tx) => {
    const [locked] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
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
    const [shipment] = locked?.request.shipmentId
      ? await tx
          .select()
          .from(productShipments)
          .where(eq(productShipments.id, locked.request.shipmentId))
          .for("update")
          .limit(1)
      : [];
    const row = locked ? { ...locked, shipment: shipment ?? null } : null;
    if (
      !row ||
      row.order.status !== "paid" ||
      row.order.redactedAt ||
      hasCarrierHandoff(row.shipment)
    )
      return false;
    if (
      !isSameCountryAddressChange(row.request.originalAddress, proposedAddress)
    )
      return false;
    if (proposedAddress.countryCode === "US") {
      const config = getChitChatsConfig();
      const [certification] = config.usShippingEnabled
        ? await tx
            .select({
              id: fulfillmentProviderCertifications.id,
              contract: fulfillmentProviderCertifications.contractSnapshot,
            })
            .from(fulfillmentProviderCertifications)
            .where(
              and(
                eq(fulfillmentProviderCertifications.provider, "chitchats"),
                eq(
                  fulfillmentProviderCertifications.environment,
                  config.environment,
                ),
                eq(
                  fulfillmentProviderCertifications.scope,
                  "us_shipping_contract",
                ),
                gt(fulfillmentProviderCertifications.validUntil, now),
                isNull(fulfillmentProviderCertifications.revokedAt),
                sql`length(trim(${fulfillmentProviderCertifications.evidenceReference})) > 0`,
              ),
            )
            .limit(1)
        : [];
      if (
        !certification ||
        !certification.contract ||
        !("importTerms" in certification.contract) ||
        certification.contract.importTerms !== "DDU" ||
        new Date(certification.contract.effectiveFrom) > now ||
        new Date(certification.contract.effectiveUntil) <= now
      )
        throw new Error(
          "United States address changes require a current service/customs certification",
        );
    }
    const [previous] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(productOrderAddressChangeRequests)
      .where(eq(productOrderAddressChangeRequests.orderId, row.order.id));
    const flags = addressRiskFlags({
      original: row.request.originalAddress,
      proposed: proposedAddress,
      previousRequestCount: Number(previous?.count ?? 0),
      postagePurchased: Boolean(row.shipment?.purchasedAt),
      atRiskValueCents:
        row.order.atRiskValueCents ?? row.order.merchandiseAmountCents ?? 0,
      reviewThresholdCents: policy.settings.addressReviewThresholdCents,
      forwarderPatterns: policy.settings.forwarderPatterns,
    });
    const highRisk = flags.length > 0;
    const [updated] = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        status: flags.length ? "risk_review" : "submitted",
        proposedAddress,
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
          paymentRiskStatus: "review_required",
          paymentRiskAssessedAt: now,
          paymentRiskSource: "address_change",
          updatedAt: now,
        })
        .where(eq(checkoutOrders.id, row.order.id));
    if (updated && highRisk) {
      const [incident] = await tx
        .insert(productPaymentRiskIncidents)
        .values({
          orderId: row.order.id,
          incidentKey: `address-change/${row.request.id}`,
          status: "review_required",
          reasonCodes: flags.map((flag) => `ADDRESS_${flag.toUpperCase()}`),
          providerEvidence: {},
          policyVersion: row.order.shippingPolicyVersion ?? "unconfigured",
          alertedAt: now,
        })
        .onConflictDoUpdate({
          target: productPaymentRiskIncidents.incidentKey,
          set: { status: "review_required", updatedAt: now },
        })
        .returning({ id: productPaymentRiskIncidents.id });
      if (incident)
        await tx
          .update(productOrderAddressChangeRequests)
          .set({
            riskIncidentId: incident.id,
            stateVersion: sql`${productOrderAddressChangeRequests.stateVersion} + 1`,
          })
          .where(eq(productOrderAddressChangeRequests.id, row.request.id));
    }
    return Boolean(updated);
  });
}

export async function approveAddressChange(input: {
  requestId: string;
  adminUserId: string;
  expectedCallbackEvidenceReference?: string;
  expectedStateVersion: number;
  action: "address_approval" | "fraud_clearance";
  responsibility?: "customer" | "lash_her";
  rationale?: string;
  stepUpAuthenticatedAt?: Date;
}): Promise<{
  complete: boolean;
  action: "address_approval" | "fraud_clearance";
  coolingOffUntil?: string;
  pendingActions: Array<"address_approval" | "fraud_clearance">;
}> {
  const now = new Date();
  const rationale = input.rationale?.trim().slice(0, 1_000) ?? "";
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(tx, input.adminUserId);
    const [row] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
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
    if (
      !row ||
      row.request.stateVersion !== input.expectedStateVersion ||
      !["submitted", "risk_review"].includes(row.request.status)
    )
      throw new Error("Address change is not awaiting approval");
    if (!input.responsibility)
      throw new Error("Address-change cost responsibility is required");
    const recordedResponsibility =
      row.request.providerReconciliation?.responsibility;
    if (
      (recordedResponsibility === "customer" ||
        recordedResponsibility === "lash_her") &&
      recordedResponsibility !== input.responsibility
    )
      throw new Error(
        "Address-change responsibility cannot change after review starts",
      );
    if (rationale.length < 10)
      throw new Error(
        "A documented rationale of at least 10 characters is required",
      );
    const highRisk = row.request.riskFlags.length > 0;
    const policyVersion = row.policyVersion ?? "unconfigured";
    if (!highRisk && input.action !== "address_approval") {
      throw new Error(
        "Fraud clearance is not required for this address change",
      );
    }
    const [incident] = highRisk
      ? await tx
          .select()
          .from(productPaymentRiskIncidents)
          .where(
            and(
              eq(
                productPaymentRiskIncidents.id,
                row.request.riskIncidentId ?? "missing",
              ),
              eq(productPaymentRiskIncidents.orderId, row.request.orderId),
            ),
          )
          .for("update")
          .limit(1)
      : [undefined];
    if (highRisk && !incident)
      throw new Error("Address-change risk incident is missing");
    if (
      highRisk &&
      input.action === "fraud_clearance" &&
      incident!.status !== "review_required"
    )
      throw new Error("Address-change risk incident is not reviewable");
    const [callbackEvidence] = await tx
      .select()
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "address_change"),
          eq(fulfillmentOwnerActions.targetId, row.request.id),
          eq(
            fulfillmentOwnerActions.action,
            "original_order_phone_callback_recorded",
          ),
        ),
      )
      .orderBy(desc(fulfillmentOwnerActions.createdAt))
      .limit(1);
    const transactions = await tx
      .select({
        id: orderPaymentTransactions.id,
        providerTransactionId: orderPaymentTransactions.providerTransactionId,
        providerType: orderPaymentTransactions.providerType,
        providerStatus: orderPaymentTransactions.providerStatus,
        avsCode: orderPaymentTransactions.avsCode,
        cvvCode: orderPaymentTransactions.cvvCode,
        riskStatus: orderPaymentTransactions.riskStatus,
        riskReasonCodes: orderPaymentTransactions.riskReasonCodes,
        capturedAt: orderPaymentTransactions.capturedAt,
      })
      .from(orderPaymentTransactions)
      .innerJoin(
        orderPaymentObligations,
        eq(orderPaymentTransactions.obligationId, orderPaymentObligations.id),
      )
      .where(
        and(
          eq(orderPaymentObligations.orderId, row.request.orderId),
          isNull(orderPaymentObligations.quarantinedAt),
        ),
      )
      .orderBy(orderPaymentTransactions.capturedAt);
    const commonEvidence = {
      addressRequestId: row.request.id,
      addressRiskFlags: row.request.riskFlags,
      originalAddressHash: hashAddressEvidence(row.request.originalAddress),
      proposedAddressHash: row.request.proposedAddress
        ? hashAddressEvidence(row.request.proposedAddress)
        : null,
      riskIncidentId: incident?.id ?? null,
      riskIncidentKey: incident?.incidentKey ?? null,
      policyVersion,
      paymentTransactions: transactions.map((transaction) => ({
        ...transaction,
        capturedAt: transaction.capturedAt.toISOString(),
      })),
      callbackEvidenceId: callbackEvidence?.id ?? null,
      callbackEvidenceReference:
        typeof callbackEvidence?.evidence?.evidenceReference === "string"
          ? callbackEvidence.evidence.evidenceReference
          : null,
    };
    const evidence = buildAddressApprovalEvidence(
      input.action,
      commonEvidence,
      incident,
    );
    if (highRisk) {
      if (!input.stepUpAuthenticatedAt)
        throw new Error("Step-up authentication is required");
      if (
        input.stepUpAuthenticatedAt > now ||
        now.getTime() - input.stepUpAuthenticatedAt.getTime() > 5 * 60_000
      )
        throw new Error("Step-up authentication has expired");
      if (
        !transactions.length ||
        transactions.some(
          (transaction) =>
            !transaction.providerTransactionId ||
            !transaction.providerType ||
            !transaction.providerStatus ||
            !transaction.avsCode ||
            !transaction.cvvCode ||
            transaction.riskStatus !== "cleared",
        )
      )
        throw new Error("Authoritative provider evidence is required");
      if (
        input.action === "address_approval" &&
        (!callbackEvidence ||
          typeof callbackEvidence.evidence?.evidenceReference !== "string" ||
          callbackEvidence.evidence.evidenceReference.trim().length < 6)
      )
        throw new Error("Original-order-phone callback evidence is required");
      if (
        input.action === "address_approval" &&
        input.expectedCallbackEvidenceReference?.trim() !==
          String(callbackEvidence!.evidence!.evidenceReference).trim()
      )
        throw new Error(
          "Original-order-phone callback evidence changed; refresh and review again",
        );
      const targetType =
        input.action === "fraud_clearance"
          ? "payment_risk_incident"
          : "address_change";
      const targetId =
        input.action === "fraud_clearance" ? incident!.id : row.request.id;
      const proposalAction = `${input.action}_proposed`;
      const executionAction = `${input.action}_executed`;
      const [execution] = await tx
        .select({ id: fulfillmentOwnerActions.id })
        .from(fulfillmentOwnerActions)
        .where(
          and(
            eq(fulfillmentOwnerActions.targetType, targetType),
            eq(fulfillmentOwnerActions.targetId, targetId),
            eq(fulfillmentOwnerActions.action, executionAction),
          ),
        )
        .limit(1);
      let executed = Boolean(execution);
      const [proposal] = await tx
        .select()
        .from(fulfillmentOwnerActions)
        .where(
          and(
            eq(fulfillmentOwnerActions.targetType, targetType),
            eq(fulfillmentOwnerActions.targetId, targetId),
            eq(fulfillmentOwnerActions.action, proposalAction),
          ),
        )
        .orderBy(desc(fulfillmentOwnerActions.createdAt))
        .limit(1);
      if (!proposal && !executed) {
        const coolingOffUntil = new Date(now.getTime() + 15 * 60_000);
        await tx.insert(fulfillmentOwnerActions).values({
          targetType,
          targetId,
          action: proposalAction,
          adminUserId: input.adminUserId,
          policyVersion,
          rationale,
          evidence,
          stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          coolingOffUntil,
        });
        const updatedRequest = await tx
          .update(productOrderAddressChangeRequests)
          .set({
            customerCaused: input.responsibility === "customer",
            phoneCallbackCompletedAt:
              input.action === "address_approval" ? now : undefined,
            callbackEvidenceReference:
              input.action === "address_approval"
                ? String(callbackEvidence!.evidence!.evidenceReference)
                : undefined,
            stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
            coolingOffUntil,
            ownerRationale: rationale,
            providerReconciliation: {
              ...(row.request.providerReconciliation ?? {}),
              responsibility: input.responsibility,
              approvalEvidence: evidence,
            },
            stateVersion: row.request.stateVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(productOrderAddressChangeRequests.id, row.request.id),
              eq(
                productOrderAddressChangeRequests.stateVersion,
                input.expectedStateVersion,
              ),
            ),
          )
          .returning({ id: productOrderAddressChangeRequests.id });
        if (!updatedRequest.length)
          throw new Error("Address change approval state changed");
        return {
          complete: false,
          action: input.action,
          coolingOffUntil: coolingOffUntil.toISOString(),
          pendingActions: highRisk
            ? ["address_approval", "fraud_clearance"]
            : ["address_approval"],
        };
      }
      if (!executed && proposal!.coolingOffUntil > now) {
        return {
          complete: false,
          action: input.action,
          coolingOffUntil: proposal!.coolingOffUntil.toISOString(),
          pendingActions: highRisk
            ? ["address_approval", "fraud_clearance"]
            : ["address_approval"],
        };
      }
      if (!executed) {
        if (
          proposal!.policyVersion !== policyVersion ||
          proposal!.rationale !== rationale ||
          stableJson(proposal!.evidence) !== stableJson(evidence)
        )
          throw new Error(
            "The approved rationale and evidence changed during cooling-off",
          );
        await tx.insert(fulfillmentOwnerActions).values({
          targetType,
          targetId,
          action: executionAction,
          adminUserId: input.adminUserId,
          policyVersion,
          rationale,
          evidence,
          stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
          coolingOffUntil: proposal!.coolingOffUntil,
          executedAt: now,
        });
        executed = true;
      }
      if (input.action === "fraud_clearance" && executed) {
        const [clearedIncident] = await tx
          .update(productPaymentRiskIncidents)
          .set({
            status: "cleared",
            ownerAdminUserId: input.adminUserId,
            stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
            coolingOffUntil: proposal?.coolingOffUntil ?? now,
            reviewedAt: now,
            rationale,
            outcome: "cleared",
            providerEvidence: evidence,
            stateVersion: incident!.stateVersion + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(productPaymentRiskIncidents.id, incident!.id),
              eq(productPaymentRiskIncidents.status, "review_required"),
              eq(
                productPaymentRiskIncidents.stateVersion,
                incident!.stateVersion,
              ),
            ),
          )
          .returning({ id: productPaymentRiskIncidents.id });
        if (!clearedIncident)
          throw new Error("Address-change risk incident changed during review");
        const [otherActiveIncident] = await tx
          .select({ id: productPaymentRiskIncidents.id })
          .from(productPaymentRiskIncidents)
          .where(
            and(
              eq(productPaymentRiskIncidents.orderId, row.request.orderId),
              ne(productPaymentRiskIncidents.id, incident!.id),
              inArray(productPaymentRiskIncidents.status, [
                "pending",
                "review_required",
              ]),
            ),
          )
          .limit(1);
        if (!otherActiveIncident) {
          await tx
            .update(checkoutOrders)
            .set({
              paymentRiskStatus: "cleared",
              paymentRiskAssessedAt: now,
              paymentRiskSource: "manual_address_change",
              fraudClearedAt: now,
              updatedAt: now,
            })
            .where(eq(checkoutOrders.id, row.request.orderId));
        }
      }
    }
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
    const executedActions = highRisk
      ? await tx
          .select({ action: fulfillmentOwnerActions.action })
          .from(fulfillmentOwnerActions)
          .where(
            sql`${fulfillmentOwnerActions.action} in ('address_approval_executed', 'fraud_clearance_executed') and (
              (${fulfillmentOwnerActions.targetType} = 'address_change' and ${fulfillmentOwnerActions.targetId} = ${row.request.id})
              or (${fulfillmentOwnerActions.targetType} = 'payment_risk_incident' and ${fulfillmentOwnerActions.targetId} = ${incident?.id ?? "missing"})
            )`,
          )
      : [{ action: "address_approval_executed" }];
    const actionSet = new Set(executedActions.map((entry) => entry.action));
    const pendingActions = (
      ["address_approval", "fraud_clearance"] as const
    ).filter((action) => highRisk && !actionSet.has(`${action}_executed`));
    const complete = !highRisk || pendingActions.length === 0;
    const updatedRequest = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        firstApprovedByAdminUserId: complete ? input.adminUserId : undefined,
        firstApprovedAt: complete ? now : undefined,
        status: complete ? "approved" : "risk_review",
        customerCaused: input.responsibility === "customer",
        ownerRationale: rationale,
        updatedAt: now,
        providerReconciliation: {
          ...(row.request.providerReconciliation ?? {}),
          responsibility: input.responsibility,
          approvalEvidence: evidence,
        },
        stateVersion: row.request.stateVersion + 1,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, row.request.id),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            input.expectedStateVersion,
          ),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!updatedRequest.length)
      throw new Error("Address change approval state changed");
    return { complete, action: input.action, pendingActions };
  });
}

export async function recordAddressPhoneCallbackEvidence(input: {
  requestId: string;
  adminUserId: string;
  expectedStateVersion: number;
  rationale: string;
  evidenceReference: string;
  stepUpAuthenticatedAt: Date;
}): Promise<{ id: string }> {
  const now = new Date();
  const reference = input.evidenceReference.trim().slice(0, 500);
  const rationale = input.rationale.trim().slice(0, 1_000);
  if (reference.length < 6 || rationale.length < 10)
    throw new Error("Callback evidence reference and rationale are required");
  if (
    input.stepUpAuthenticatedAt > now ||
    now.getTime() - input.stepUpAuthenticatedAt.getTime() > 5 * 60_000
  )
    throw new Error("Step-up authentication has expired");
  return getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(tx, input.adminUserId);
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
      .innerJoin(
        productShipments,
        eq(productOrderAddressChangeRequests.shipmentId, productShipments.id),
      )
      .where(eq(productOrderAddressChangeRequests.id, input.requestId))
      .for("update")
      .limit(1);
    const originalPhone = row?.shipment.destination.phone?.trim();
    if (
      !row ||
      row.request.stateVersion !== input.expectedStateVersion ||
      !["submitted", "risk_review"].includes(row.request.status) ||
      !originalPhone
    )
      throw new Error("Original-order phone evidence is unavailable");
    const [existing] = await tx
      .select()
      .from(fulfillmentOwnerActions)
      .where(
        and(
          eq(fulfillmentOwnerActions.targetType, "address_change"),
          eq(fulfillmentOwnerActions.targetId, row.request.id),
          eq(
            fulfillmentOwnerActions.action,
            "original_order_phone_callback_recorded",
          ),
        ),
      )
      .limit(1);
    const evidence = {
      evidenceReference: reference,
      originalOrderPhoneHash: createHash("sha256")
        .update(originalPhone)
        .digest("hex"),
    };
    if (existing) {
      if (
        existing.rationale !== rationale ||
        stableJson(existing.evidence) !== stableJson(evidence)
      )
        throw new Error("Recorded callback evidence is immutable");
      return { id: existing.id };
    }
    const [created] = await tx
      .insert(fulfillmentOwnerActions)
      .values({
        targetType: "address_change",
        targetId: row.request.id,
        action: "original_order_phone_callback_recorded",
        adminUserId: input.adminUserId,
        policyVersion: row.order.shippingPolicyVersion ?? "unconfigured",
        rationale,
        evidence,
        stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
        coolingOffUntil: now,
        executedAt: now,
      })
      .returning({ id: fulfillmentOwnerActions.id });
    const updated = await tx
      .update(productOrderAddressChangeRequests)
      .set({
        stateVersion: row.request.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productOrderAddressChangeRequests.id, row.request.id),
          eq(
            productOrderAddressChangeRequests.stateVersion,
            input.expectedStateVersion,
          ),
        ),
      )
      .returning({ id: productOrderAddressChangeRequests.id });
    if (!updated.length)
      throw new Error("Address change approval state changed");
    return { id: created!.id };
  });
}

export async function applyApprovedAddressChange(input: {
  requestId: string;
  requestedByAdminUserId: string;
  expectedStateVersion: number;
}): Promise<{
  orderReference: string;
  refundDecreaseCents: number;
  refundOperationIds?: string[];
  requiresSupplementalPayment: boolean;
  supplementalObligationId?: string;
  preparedRefreshPending?: boolean;
  preparedPurchasePending?: boolean;
  operationId?: string;
  freshQuoteRequired?: boolean;
}> {
  const requestId = input.requestId;
  const applied = await getPrivateDb().transaction(async (tx) => {
    await assertConfiguredFulfillmentOwnerInTransaction(
      tx,
      input.requestedByAdminUserId,
    );
    const [locked] = await tx
      .select({
        request: productOrderAddressChangeRequests,
        order: checkoutOrders,
      })
      .from(productOrderAddressChangeRequests)
      .innerJoin(
        checkoutOrders,
        eq(productOrderAddressChangeRequests.orderId, checkoutOrders.id),
      )
      .where(eq(productOrderAddressChangeRequests.id, requestId))
      .for("update")
      .limit(1);
    const [shipment] = locked?.request.shipmentId
      ? await tx
          .select()
          .from(productShipments)
          .where(eq(productShipments.id, locked.request.shipmentId))
          .for("update")
          .limit(1)
      : [];
    const row = locked ? { ...locked, shipment: shipment ?? null } : null;
    if (
      !row?.request.proposedAddress ||
      row.request.status !== "approved" ||
      row.request.stateVersion !== input.expectedStateVersion
    )
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
    if (
      [
        "awaiting_signature",
        "awaiting_service_substitution",
        "decision_resume_queued",
      ].includes(row.request.reconciliationState)
    ) {
      throw new Error("The address change is awaiting signed customer consent");
    }
    const prepared = readPreparedShipment(
      row.request.providerReconciliation ?? {},
    );
    if (!prepared)
      throw new Error("Replacement shipment must be prepared first");
    const responsibility = row.request.providerReconciliation?.responsibility;
    if (responsibility !== "customer" && responsibility !== "lash_her")
      throw new Error("Address-change cost responsibility is missing");
    const shippingLedger = await lockNetCustomerShippingLedger(
      tx,
      row.order.id,
    );
    const difference =
      prepared.selectedRateAmountCents - shippingLedger.netShippingCents;
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
          const stalePreparedShipmentId = row.request.preparedShipmentId;
          const stalePreparedShipmentStateVersion =
            row.request.preparedShipmentStateVersion;
          await tx
            .update(productOrderAddressChangeRequests)
            .set({
              supplementalObligationId: null,
              offerExpiresAt: null,
              preparedShipmentId: null,
              preparedShipmentStateVersion: null,
              reconciliationState: "not_started",
              cleanupOutcome: "required",
              stateVersion: row.request.stateVersion + 1,
              updatedAt: new Date(),
            })
            .where(eq(productOrderAddressChangeRequests.id, row.request.id));
          if (
            stalePreparedShipmentId &&
            stalePreparedShipmentStateVersion !== null
          ) {
            const cleanupPayload = {
              requestId: row.request.id,
              reason: "address_supplement_expired",
              expectedShipmentStateVersion: stalePreparedShipmentStateVersion,
            };
            await tx
              .insert(productShipmentJobs)
              .values({
                shipmentId: stalePreparedShipmentId,
                type: "cleanup",
                status: "queued",
                idempotencyKey: `address-expired-quote/${row.request.id}/${stalePreparedShipmentId}`,
                operationPayloadHash: hashOperationPayload(cleanupPayload),
                payload: cleanupPayload,
              })
              .onConflictDoNothing({
                target: productShipmentJobs.idempotencyKey,
              });
          }
          return {
            orderReference: row.order.orderId,
            refundDecreaseCents: 0,
            requiresSupplementalPayment: false,
            freshQuoteRequired: true as const,
            stalePreparedShipmentId,
            stalePreparedShipmentStateVersion,
          };
        }
        if (!row.order.shippingPolicyVersion || !row.order.taxPolicyVersion) {
          throw new Error(
            "Policy and tax snapshots are required for supplemental payment",
          );
        }
        const obligationNow = new Date();
        const primaryObligations = await tx
          .select({
            disclosureSnapshot: orderPaymentObligations.disclosureSnapshot,
            taxPolicyVersion: orderPaymentObligations.taxPolicyVersion,
          })
          .from(orderPaymentObligations)
          .where(
            and(
              eq(orderPaymentObligations.orderId, row.order.id),
              eq(orderPaymentObligations.purpose, "primary"),
            ),
          )
          .limit(2);
        const primaryObligation = primaryObligations[0];
        const primaryDisclosure = primaryObligation?.disclosureSnapshot;
        const primaryQuoteContext =
          primaryDisclosure &&
          typeof primaryDisclosure === "object" &&
          !Array.isArray(primaryDisclosure)
            ? parseShippingQuoteContextSnapshot(
                primaryDisclosure.shippingQuoteContext,
              )
            : null;
        if (
          primaryObligations.length !== 1 ||
          !primaryQuoteContext ||
          primaryObligation.taxPolicyVersion !== row.order.taxPolicyVersion ||
          primaryQuoteContext.taxPolicyVersion !== row.order.taxPolicyVersion
        ) {
          throw new Error(
            "The primary payment tax-policy approval snapshot is unavailable",
          );
        }
        const taxPolicyApproval =
          await assertProductTaxPolicyApprovalInTransaction(
            tx,
            primaryQuoteContext.taxPolicyApproval,
            obligationNow,
          );
        const offerExpiresAt = new Date(
          obligationNow.getTime() + 24 * 60 * 60_000,
        );
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
            paymentProvider: "square",
            sourceWorkflow: `address_change/${row.request.id}`,
            sourceReferenceId: row.request.id,
            disclosureSnapshot: {
              taxPolicyApproval,
              responsibility: "customer",
              proposedAddressCountry:
                row.request.proposedAddress.countryCode ??
                row.request.proposedAddress.country,
            },
            taxPolicyVersion: row.order.taxPolicyVersion,
            policyVersion: row.order.shippingPolicyVersion,
            quoteVersion: row.request.stateVersion,
            expiresAt: offerExpiresAt,
            idempotencyKey: `address-increase/${row.request.id}/${row.request.stateVersion}/${prepared.publicReference}/${shippingLedger.version}/${difference}`,
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
        await issueSupplementalPaymentOfferInTransaction(tx, {
          obligationId: obligation.id,
          notificationOrigin: supplementalPaymentPublicOrigin(),
          now: new Date(),
        });
        return {
          orderReference: row.order.orderId,
          refundDecreaseCents: 0,
          requiresSupplementalPayment: true,
          supplementalObligationId: obligation!.id,
        };
      }
    }
    const sourceVersionIsCurrent =
      row.request.expectedSourceShipmentStateVersion ===
        row.shipment.stateVersion ||
      (row.request.reconciliationState === "reconciling_old_postage" &&
        row.shipment.status === "voided");
    if (
      !row.request.preparedShipmentId ||
      row.request.preparedShipmentStateVersion === null ||
      row.request.expectedSourceShipmentId !== row.shipment.id ||
      !sourceVersionIsCurrent ||
      row.order.activeFulfillmentShipmentId !== row.shipment.id
    )
      throw new Error("The address-change generation intent is stale");
    const [preparedGeneration] = await tx
      .select({
        actualPurchaseTotalCents: productShipments.actualPurchaseTotalCents,
        id: productShipments.id,
        packageSnapshot: productShipments.packageSnapshot,
        providerShipmentId: productShipments.providerShipmentId,
        purchasedAt: productShipments.purchasedAt,
        selectedPostageType: productShipments.selectedPostageType,
        stateVersion: productShipments.stateVersion,
        status: productShipments.status,
        quoteExpiresAt: productShipments.quoteExpiresAt,
      })
      .from(productShipments)
      .where(
        and(
          eq(productShipments.id, row.request.preparedShipmentId),
          eq(productShipments.orderId, row.order.id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !preparedGeneration ||
      preparedGeneration.stateVersion <
        row.request.preparedShipmentStateVersion ||
      preparedGeneration.providerShipmentId !== prepared.providerShipmentId ||
      preparedGeneration.selectedPostageType !== prepared.selectedPostageType ||
      ![
        "quoted",
        "ready_for_staff",
        "purchase_pending",
        "label_ready",
      ].includes(preparedGeneration.status)
    )
      throw new Error("The prepared address-change generation is stale");
    const now = new Date();
    if (
      !preparedGeneration.purchasedAt &&
      preparedGeneration.quoteExpiresAt <= now
    ) {
      const nextRequestStateVersion = row.request.stateVersion + 1;
      const payload = {
        mode: "refresh_prepared",
        requestId,
        sourceShipmentId: row.shipment.id,
        expectedRequestStateVersion: nextRequestStateVersion,
        expectedSourceStateVersion: row.shipment.stateVersion,
        preparedShipmentId: preparedGeneration.id,
        expectedPreparedStateVersion: preparedGeneration.stateVersion,
        refreshIntentAt: now.toISOString(),
        shipDate: now.toISOString().slice(0, 10),
      };
      const idempotencyKey = `address-prepared-refresh/${requestId}/${preparedGeneration.id}/${preparedGeneration.stateVersion}`;
      const [operation] = await tx
        .insert(productShipmentJobs)
        .values({
          shipmentId: row.shipment.id,
          type: "address_replace",
          status: "queued",
          idempotencyKey,
          operationPayloadHash: hashOperationPayload(payload),
          payload,
        })
        .onConflictDoUpdate({
          target: productShipmentJobs.idempotencyKey,
          set: { updatedAt: now },
          setWhere: and(
            eq(
              productShipmentJobs.operationPayloadHash,
              hashOperationPayload(payload),
            ),
            eq(productShipmentJobs.type, "address_replace"),
            eq(productShipmentJobs.shipmentId, row.shipment.id),
          ),
        })
        .returning({ id: productShipmentJobs.id });
      if (!operation) {
        throw new Error("A conflicting address quote refresh operation exists");
      }
      const updatedRequest = await tx
        .update(productOrderAddressChangeRequests)
        .set({
          reconciliationState: "refresh_queued",
          stateVersion: nextRequestStateVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(productOrderAddressChangeRequests.id, row.request.id),
            eq(
              productOrderAddressChangeRequests.stateVersion,
              row.request.stateVersion,
            ),
          ),
        )
        .returning({ id: productOrderAddressChangeRequests.id });
      if (!updatedRequest.length) {
        throw new Error("The address request changed before quote refresh");
      }
      return {
        orderReference: row.order.orderId,
        refundDecreaseCents: 0,
        requiresSupplementalPayment: false,
        preparedRefreshPending: true as const,
        operationId: operation.id,
      };
    }
    let safeOldPostageOutcome: "refund_confirmed" | "delete_confirmed";
    if (row.shipment.purchasedAt && row.shipment.status !== "voided") {
      const nextSourceVersion = row.shipment.stateVersion + 1;
      const [held] = await tx
        .update(productShipments)
        .set({
          status: "refund_pending",
          stateVersion: nextSourceVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(productShipments.id, row.shipment.id),
            eq(productShipments.stateVersion, row.shipment.stateVersion),
            inArray(productShipments.status, ["label_ready", "exception"]),
          ),
        )
        .returning({ id: productShipments.id });
      if (!held)
        throw new Error("Old postage is not eligible for safe reconciliation");
      const payload = {
        requestId,
        reason: "address_change_before_adoption",
        expectedShipmentStateVersion: nextSourceVersion,
      };
      await tx
        .insert(productShipmentJobs)
        .values({
          shipmentId: row.shipment.id,
          type: "refund",
          status: "queued",
          idempotencyKey: `address-source-refund/${requestId}/${row.shipment.id}`,
          operationPayloadHash: hashOperationPayload(payload),
          payload,
        })
        .onConflictDoNothing({ target: productShipmentJobs.idempotencyKey });
      await tx
        .update(productOrderAddressChangeRequests)
        .set({
          expectedSourceShipmentStateVersion: nextSourceVersion,
          reconciliationState: "reconciling_old_postage",
          oldPostageOutcome: "refund_pending",
          updatedAt: now,
        })
        .where(eq(productOrderAddressChangeRequests.id, row.request.id));
      return {
        orderReference: row.order.orderId,
        refundDecreaseCents: 0,
        requiresSupplementalPayment: false,
        oldPostageReconciliationPending: true as const,
      };
    }
    if (row.shipment.purchasedAt) {
      if (row.shipment.status !== "voided")
        throw new Error("Old purchased postage has not been safely voided");
      safeOldPostageOutcome = "refund_confirmed";
    } else {
      const cleanupKey = `address-source-delete/${requestId}/${row.shipment.id}`;
      const existingCleanup = await tx.query.productShipmentJobs.findFirst({
        where: eq(productShipmentJobs.idempotencyKey, cleanupKey),
      });
      if (existingCleanup?.status !== "succeeded") {
        if (!existingCleanup) {
          const nextSourceVersion = row.shipment.stateVersion + 1;
          const [held] = await tx
            .update(productShipments)
            .set({
              status: "abandoned",
              stateVersion: nextSourceVersion,
              updatedAt: now,
            })
            .where(
              and(
                eq(productShipments.id, row.shipment.id),
                eq(productShipments.stateVersion, row.shipment.stateVersion),
                inArray(productShipments.status, [
                  "payment_pending",
                  "ready_for_staff",
                  "quoted",
                ]),
              ),
            )
            .returning({ id: productShipments.id });
          if (!held)
            throw new Error("The source shipment changed before cleanup");
          const payload = {
            requestId,
            reason: "address_change_before_adoption",
            expectedShipmentStateVersion: nextSourceVersion,
          };
          await tx.insert(productShipmentJobs).values({
            shipmentId: row.shipment.id,
            type: "delete",
            status: "queued",
            idempotencyKey: cleanupKey,
            operationPayloadHash: hashOperationPayload(payload),
            payload,
          });
          await tx
            .update(productOrderAddressChangeRequests)
            .set({
              expectedSourceShipmentStateVersion: nextSourceVersion,
              reconciliationState: "reconciling_old_postage",
              oldPostageOutcome: "delete_pending",
              updatedAt: now,
            })
            .where(eq(productOrderAddressChangeRequests.id, row.request.id));
        }
        return {
          orderReference: row.order.orderId,
          refundDecreaseCents: 0,
          requiresSupplementalPayment: false,
          oldPostageReconciliationPending: true as const,
        };
      }
      if (row.shipment.status !== "abandoned")
        throw new Error(
          "Old unpaid postage cleanup has not been safely fenced",
        );
      safeOldPostageOutcome = "delete_confirmed";
    }
    const settledPurchaseCents = preparedGeneration.actualPurchaseTotalCents;
    if (
      preparedGeneration.status !== "label_ready" ||
      !preparedGeneration.purchasedAt ||
      settledPurchaseCents === null ||
      settledPurchaseCents <= 0
    ) {
      const operation = await enqueuePreparedAddressPurchaseInTransaction(tx, {
        orderId: row.order.id,
        requestId: row.request.id,
        sourceShipmentId: row.shipment.id,
        preparedShipmentId: preparedGeneration.id,
        expectedPreparedStateVersion: preparedGeneration.stateVersion,
        oldPostageOutcome: safeOldPostageOutcome,
        payload: {
          measuredWeightGrams:
            preparedGeneration.packageSnapshot.totalWeightGrams,
          shipDate: now.toISOString().slice(0, 10),
        },
        now,
      });
      if (!operation)
        throw new Error(
          "Replacement purchase could not be reserved under current funding controls",
        );
      return {
        orderReference: row.order.orderId,
        refundDecreaseCents: 0,
        requiresSupplementalPayment: false,
        preparedPurchasePending: true as const,
        operationId: operation.id,
      };
    }
    const [fencedSource] = await tx
      .update(productShipments)
      .set({
        stateVersion: row.shipment.stateVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productShipments.id, row.shipment.id),
          eq(productShipments.stateVersion, row.shipment.stateVersion),
        ),
      )
      .returning({ id: productShipments.id });
    if (!fencedSource) {
      throw new Error("The source shipment changed before address adoption");
    }
    const [adopted] = await tx
      .update(checkoutOrders)
      .set({
        shippingAddress: row.request.proposedAddress,
        activeFulfillmentShipmentId: preparedGeneration.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(checkoutOrders.id, row.order.id),
          eq(checkoutOrders.activeFulfillmentShipmentId, row.shipment.id),
        ),
      )
      .returning({ id: checkoutOrders.id });
    if (!adopted) throw new Error("The active shipment generation changed");
    await tx
      .update(productOrderAddressChangeRequests)
      .set({
        status: "applied",
        appliedAt: now,
        adoptionOutcome: "adopted",
        oldPostageOutcome: safeOldPostageOutcome,
        preparedShipmentStateVersion: preparedGeneration.stateVersion,
        reconciliationState: "adopted",
        stateVersion: row.request.stateVersion + 1,
        updatedAt: now,
      })
      .where(eq(productOrderAddressChangeRequests.id, row.request.id));
    const finalShippingLedger = await lockNetCustomerShippingLedger(
      tx,
      row.order.id,
    );
    const refundDecreaseCents = calculateSettledAddressShippingRefund({
      netCustomerShippingCents: finalShippingLedger.netShippingCents,
      settledPurchaseCents,
    });
    const refunds = refundDecreaseCents
      ? await queueProductOrderRefundAllocationsInTransaction(tx, {
          orderReference: row.order.orderId,
          amountCents: refundDecreaseCents,
          component: "outbound_shipping",
          sourceAddressRequestId: row.request.id,
          reason: "Address change reduced shipping price",
          requestedByAdminUserId: input.requestedByAdminUserId,
          automated: true,
        })
      : [];
    return {
      orderReference: row.order.orderId,
      refundDecreaseCents,
      refundOperationIds: refunds.map((refund) => refund.id),
      requiresSupplementalPayment: false,
    };
  });
  if ("freshQuoteRequired" in applied && applied.freshQuoteRequired) {
    if (
      applied.stalePreparedShipmentId &&
      applied.stalePreparedShipmentStateVersion !== null
    )
      await enqueueShipmentOperation({
        shipmentId: applied.stalePreparedShipmentId,
        type: "cleanup",
        idempotencyKey: `address-expired-quote/${requestId}/${applied.stalePreparedShipmentId}`,
        payload: {
          requestId,
          reason: "address_supplement_expired",
          expectedShipmentStateVersion:
            applied.stalePreparedShipmentStateVersion,
        },
      });
    // The stale supplemental offer has been superseded and its shipment cleanup
    // enqueued. This is a normal state transition (not a failure): signal the
    // caller that a fresh re-rate is required so they can re-price, rather than
    // surfacing it as an error.
    return {
      orderReference: applied.orderReference,
      refundDecreaseCents: applied.refundDecreaseCents,
      requiresSupplementalPayment: false,
      freshQuoteRequired: true,
    };
  }
  if (
    "oldPostageReconciliationPending" in applied &&
    applied.oldPostageReconciliationPending
  ) {
    return applied;
  }
  return applied;
}

function hashAddressEvidence(
  value: CheckoutOrderShippingAddressSnapshot,
): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(value.map((entry) => JSON.parse(stableJson(entry))));
  if (!value || typeof value !== "object") return JSON.stringify(value ?? null);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, JSON.parse(stableJson(nested))]),
    ),
  );
}

export function buildAddressApprovalEvidence<T extends Record<string, unknown>>(
  action: "address_approval" | "fraud_clearance",
  commonEvidence: T,
  incident:
    | Pick<
        typeof productPaymentRiskIncidents.$inferSelect,
        "providerEvidence" | "reasonCodes" | "status"
      >
    | undefined,
): T & {
  riskIncidentReviewSnapshot?: {
    providerEvidenceHash: string;
    reasonCodes: string[];
    status: string | null;
  };
} {
  if (action === "address_approval") return commonEvidence;
  return {
    ...commonEvidence,
    riskIncidentReviewSnapshot: {
      providerEvidenceHash: createHash("sha256")
        .update(stableJson(incident?.providerEvidence ?? null))
        .digest("hex"),
      reasonCodes: incident?.reasonCodes ?? [],
      status: incident?.status ?? null,
    },
  };
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

export function canonicalizeReplacementAddress(
  address: CheckoutOrderShippingAddressSnapshot,
): CheckoutOrderShippingAddressSnapshot {
  const countryText = address.country.trim().toUpperCase();
  const countryCode =
    address.countryCode ??
    (countryText === "CANADA" || countryText === "CA"
      ? "CA"
      : countryText === "UNITED STATES" ||
          countryText === "US" ||
          countryText === "USA"
        ? "US"
        : null);
  if (!countryCode)
    throw new Error("Address country must be Canada or United States");
  const province = address.province.trim().toUpperCase();
  const postalCode = address.postalCode
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  const validRegion =
    countryCode === "CA" ? CA_PROVINCES.has(province) : US_STATES.has(province);
  const validPostal =
    countryCode === "CA"
      ? /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(
          postalCode,
        )
      : /^\d{5}(?:-\d{4})?$/.test(postalCode);
  if (!validRegion || !validPostal)
    throw new Error("Province/state and postal/ZIP combination is invalid");
  if (!address.line1.trim() || !address.city.trim())
    throw new Error("Street address and city are required");
  return {
    ...address,
    line1: address.line1.trim(),
    line2: address.line2?.trim() || undefined,
    city: address.city.trim(),
    province,
    postalCode:
      countryCode === "CA"
        ? `${postalCode.slice(0, 3)} ${postalCode.slice(3)}`
        : postalCode,
    country: countryCode === "CA" ? "Canada" : "United States",
    countryCode,
    phone: address.phone?.trim() || undefined,
  };
}

const CA_PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

const US_STATES = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC",
]);

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

export function calculateAddressRefreshVariance(input: {
  newDifferenceCents: number;
  settledSupplementCents: number;
}): { absorbedIncreaseCents: number; supplementRefundCents: number } {
  const requiredSupplementCents = Math.max(0, input.newDifferenceCents);
  return {
    absorbedIncreaseCents: Math.max(
      0,
      requiredSupplementCents - input.settledSupplementCents,
    ),
    supplementRefundCents: Math.max(
      0,
      input.settledSupplementCents - requiredSupplementCents,
    ),
  };
}

async function lockNetCustomerShippingLedger(
  tx: AddressChangeTransaction,
  orderId: string,
): Promise<{
  capturedShippingCents: number;
  reservedRefundCents: number;
  netShippingCents: number;
  version: string;
}> {
  const obligations = await tx
    .select()
    .from(orderPaymentObligations)
    .where(
      and(
        eq(orderPaymentObligations.orderId, orderId),
        inArray(orderPaymentObligations.purpose, [
          "primary",
          "address_increase",
          "manual_shipping",
        ]),
        isNull(orderPaymentObligations.quarantinedAt),
      ),
    )
    .for("update");
  const obligationIds = obligations.map((obligation) => obligation.id);
  // The authoritative captures are recorded under the order's own single
  // payment gateway (square today, helcim for historical orders). Read the
  // provider from the order, not an obligation: address_increase obligations
  // are always minted on Square regardless of the order's original gateway,
  // so obligations[0] would misrepresent a historical Helcim order.
  const [order] = await tx
    .select({ paymentProvider: checkoutOrders.paymentProvider })
    .from(checkoutOrders)
    .where(eq(checkoutOrders.id, orderId));
  const orderPaymentProvider = order?.paymentProvider;
  const transactions =
    obligationIds.length && orderPaymentProvider
      ? await tx
          .select()
          .from(orderPaymentTransactions)
          .where(
            and(
              inArray(orderPaymentTransactions.obligationId, obligationIds),
              eq(orderPaymentTransactions.provider, orderPaymentProvider),
            ),
          )
          .for("update")
      : [];
  const obligationById = new Map(
    obligations.map((obligation) => [obligation.id, obligation]),
  );
  const capturedShippingCents = transactions.reduce((total, transaction) => {
    const obligation = obligationById.get(transaction.obligationId);
    if (
      !obligation ||
      transaction.amountCents !== obligation.totalAmountCents ||
      transaction.currency.toUpperCase() !== obligation.currency.toUpperCase()
    ) {
      throw new Error(
        "Shipping payment ledger contains a non-authoritative capture",
      );
    }
    return total + obligation.shippingAmountCents;
  }, 0);
  const adjustments = await tx
    .select()
    .from(productOrderAdjustments)
    .where(
      and(
        eq(productOrderAdjustments.orderId, orderId),
        eq(productOrderAdjustments.direction, "refund"),
        eq(productOrderAdjustments.component, "outbound_shipping"),
        inArray(productOrderAdjustments.status, [
          "reserved",
          "processing",
          "succeeded",
          "outcome_unknown",
          // Manual review retains the financial reservation until an operator
          // explicitly releases or settles it.
          "manual_review",
        ]),
      ),
    )
    .for("update");
  const reservedRefundCents = adjustments.reduce(
    (total, adjustment) => total + adjustment.amountCents,
    0,
  );
  if (reservedRefundCents > capturedShippingCents) {
    throw new Error("Shipping refund ledger exceeds successful captures");
  }
  const version = createHash("sha256")
    .update(
      stableJson({
        obligations: obligations
          .map((obligation) => ({
            id: obligation.id,
            purpose: obligation.purpose,
            shippingAmountCents: obligation.shippingAmountCents,
            status: obligation.status,
            updatedAt: obligation.updatedAt.toISOString(),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        transactions: transactions
          .map((transaction) => ({
            id: transaction.id,
            obligationId: transaction.obligationId,
            providerTransactionId: transaction.providerTransactionId,
            amountCents: transaction.amountCents,
            capturedAt: transaction.capturedAt.toISOString(),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        refunds: adjustments
          .map((adjustment) => ({
            id: adjustment.id,
            amountCents: adjustment.amountCents,
            status: adjustment.status,
            idempotencyKey: adjustment.idempotencyKey,
            updatedAt: adjustment.updatedAt.toISOString(),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    )
    .digest("hex");
  return {
    capturedShippingCents,
    reservedRefundCents,
    netShippingCents: capturedShippingCents - reservedRefundCents,
    version,
  };
}

export function calculateSettledAddressShippingRefund(input: {
  netCustomerShippingCents: number;
  settledPurchaseCents: number;
}): number {
  const decreaseCents = Math.max(
    0,
    Math.max(0, input.netCustomerShippingCents) -
      Math.max(0, input.settledPurchaseCents),
  );
  return decreaseCents >= 100 ? decreaseCents : 0;
}

export function buildAddressReplacementPublicReference(input: {
  requestId: string;
  attemptIdentity: string;
}): string {
  return `lha-${input.requestId.slice(0, 8)}-${createHash("sha256").update(input.attemptIdentity).digest("hex").slice(0, 12)}`;
}

export function isSameCountryAddressChange(
  original: CheckoutOrderShippingAddressSnapshot,
  proposed: CheckoutOrderShippingAddressSnapshot,
): boolean {
  const countryCode = (address: CheckoutOrderShippingAddressSnapshot) =>
    address.countryCode ??
    (address.country.toUpperCase() === "CANADA" ? "CA" : "US");
  return countryCode(original) === countryCode(proposed);
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

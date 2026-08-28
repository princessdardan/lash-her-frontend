import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { ChitChatsClient } from "./chitchats-client";
import {
  ChitChatsApiError as ProviderError,
  createChitChatsClient,
} from "./chitchats-client";
import { getChitChatsConfig, isChitChatsCheckoutEnabled } from "./config";
import {
  assertShippingQuoteContextCurrent,
  assertUsShippingContractCurrent,
} from "./readiness";
import { loadShippingPolicyContext } from "./policy";
import { sendShippingPolicyAlert } from "./policy-alerts";
import { queueProductOrderRefund } from "./customer-refunds";
import { parseShippingQuoteContextSnapshot } from "./quote-token";
import { parseProviderSettlement } from "./provider-money";
import { selectCustomerRates } from "./rates";
import {
  claimShipmentOperationJobs,
  completeQuote,
  completeShipmentJob,
  fenceProviderDraftAndEnqueueCleanup,
  finalizeShipmentFundingReservation,
  getCustomerPaidShipmentShippingContext,
  getShipmentForOperation,
  markShipmentOperationManualReview,
  markShipmentMutationIntent,
  markShipmentPurchaseProviderCallIntent,
  persistKnownProviderDraft,
  persistRefreshedProviderQuote,
  recordUnsettledProviderAccountingEvidence,
  recordShipmentEvent,
  recheckShipmentPurchaseFunding,
  retryShipmentJob,
  updateShipmentFromProvider,
  type ShipmentOperationRow,
} from "./shipment-store";
import {
  normalizeChitChatsStatus,
  normalizeChitChatsTransition,
  providerShipmentTransitionEvent,
  stripSignedLabelUrls,
} from "./status";
import type { ChitChatsShipment } from "./types";
import type { ProductShipmentRateSnapshot } from "@/lib/private-db/schema";

export interface ShippingOperationWorkerResult {
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  fenced: number;
}

export interface ShippingOperationWorkerDependencies {
  client: ChitChatsClient;
  now: () => Date;
  workerId: string;
  assertQuoteContextCurrent?: typeof assertShippingQuoteContextCurrent;
}

export async function runShippingOperationWorker(
  dependencies: ShippingOperationWorkerDependencies = defaultDependencies(),
): Promise<ShippingOperationWorkerResult> {
  const jobs = await claimShipmentOperationJobs({
    workerId: dependencies.workerId,
    now: dependencies.now(),
    limit: 50,
  });
  const result: ShippingOperationWorkerResult = {
    claimed: jobs.length,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    fenced: 0,
  };
  for (const job of jobs) {
    const outcome = await processClaimedShipmentOperation(job, dependencies);
    result[outcome] += 1;
  }
  return result;
}

export async function processClaimedShipmentOperation(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<"succeeded" | "retried" | "deadLettered" | "fenced"> {
  try {
    if (!job.outcomeUnknown && MUTATING_OPERATION_TYPES.has(job.type)) {
      const marked = await markShipmentMutationIntent({
        operationId: job.id,
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
        now: dependencies.now(),
      });
      if (!marked) return "fenced";
    }
    const outcomeCode = await dispatch(job, dependencies);
    const completed = await completeShipmentJob(job.id, {
      outcomeCode,
      leaseOwner: job.leaseOwner ?? dependencies.workerId,
      expectedStateVersion: job.stateVersion,
    });
    return completed ? "succeeded" : "fenced";
  } catch (error) {
    if (error instanceof FencedOperationError) {
      const completed = await completeShipmentJob(job.id, {
        outcomeCode: "shipment_state_fenced",
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
      });
      return completed ? "succeeded" : "fenced";
    }
    const classification = classifyOperationError(error);
    if (!classification.retryable) {
      if (job.type === "purchase" && !classification.outcomeUnknown) {
        await finalizeShipmentFundingReservation({
          operationId: job.id,
          leaseOwner: job.leaseOwner ?? dependencies.workerId,
          expectedStateVersion: job.stateVersion,
          outcome: "released",
          now: dependencies.now(),
        });
      }
      const shipment = await getShipmentForOperation(job.shipmentId);
      if (shipment)
        await markShipmentOperationManualReview({
          shipmentId: shipment.id,
          expectedStateVersion: shipment.stateVersion,
        });
      const completed = await completeShipmentJob(job.id, {
        outcomeCode: classification.code,
        manualReview: true,
        lastError: classification.message,
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
      });
      return completed ? "deadLettered" : "fenced";
    }
    const retryResult = await retryShipmentJob(job.id, {
      error: classification.message,
      retryAfterSeconds: classification.retryAfterSeconds,
      leaseOwner: job.leaseOwner ?? dependencies.workerId,
      expectedStateVersion: job.stateVersion,
      attemptCount: job.attemptCount,
      outcomeUnknown: classification.outcomeUnknown || job.outcomeUnknown,
      now: dependencies.now(),
    });
    if (retryResult.status === "dead_lettered") return "deadLettered";
    if (retryResult.status === "retried") return "retried";
    return "fenced";
  }
}

const MUTATING_OPERATION_TYPES = new Set<ShipmentOperationRow["type"]>([
  "create",
  "quote_refresh",
  "purchase",
  "refund",
  "delete",
  "cleanup",
]);

async function dispatch(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  switch (job.type) {
    case "create":
      return processCreate(job, dependencies);
    case "quote_refresh":
      return processQuoteRefresh(job, dependencies);
    case "purchase":
      return processPurchase(job, dependencies);
    case "tracking":
      return processTracking(job, dependencies);
    case "refund":
      return processRefund(job, dependencies);
    case "delete":
    case "cleanup":
      return processDelete(job, dependencies);
    case "replacement_prepare":
    case "address_replace":
      // The post-sale replacement / address-change subsystem was removed; these
      // job types are no longer enqueued. Reject defensively if one is found.
      throw new DeterministicOperationError(
        `${job.type}_unsupported`,
        `The ${job.type} operation type is no longer supported`,
      );
    case "notification":
      return "notification_delegated";
  }
}

async function processCreate(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  const shipment = await requireShipment(job.shipmentId);
  if (
    shipment.providerShipmentId &&
    ["abandoned", "manual_review"].includes(shipment.status)
  ) {
    return providerDraftCleanupOutcomeCode(
      await fenceProviderDraftAndEnqueueCleanup({
        id: shipment.id,
        providerShipmentId: shipment.providerShipmentId,
        now: dependencies.now(),
      }),
    );
  }
  if (!job.outcomeUnknown && !shipment.providerShipmentId)
    assertExpectedShipmentVersion(job, shipment);
  if (
    !job.outcomeUnknown &&
    !shipment.providerShipmentId &&
    !isChitChatsCheckoutEnabled()
  )
    throw new DeterministicOperationError(
      "checkout_disabled",
      "New shipping quote admission is disabled",
    );
  if (
    !job.outcomeUnknown &&
    !shipment.providerShipmentId &&
    shipment.quoteExpiresAt <= dependencies.now()
  )
    throw new DeterministicOperationError(
      "quote_expired",
      "Quote expired before provider creation",
    );
  let provider: ChitChatsShipment;
  if (job.outcomeUnknown || shipment.providerShipmentId) {
    provider = await reconcileCreate(
      dependencies.client,
      shipment.publicReference,
    );
  } else {
    await requireCurrentShippingQuoteContext(
      shipment,
      dependencies.now(),
      dependencies.assertQuoteContextCurrent,
    );
    try {
      provider = await dependencies.client.createShipment({
        recipient: shipment.destination as never,
        packageSnapshot: shipment.packageSnapshot,
        customsLines: shipment.customsLines,
        merchandiseValueCents: requiredInteger(
          job.payload,
          "merchandiseValueCents",
        ),
        orderReference: shipment.publicReference,
        signatureRequested: job.payload?.signatureRequested === true,
      });
    } catch (error) {
      throw mutationFailure(error, "create_outcome_unknown");
    }
  }
  let persistedShipment: typeof shipment;
  try {
    const persisted = await persistKnownProviderDraft({
      id: shipment.id,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      rawShipment: stripSignedLabelUrls(provider),
      now: dependencies.now(),
    });
    if (!persisted)
      throw new Error("Provider draft conflicted with local shipment state");
    persistedShipment = persisted;
  } catch (error) {
    throw new UnknownMutationOutcomeError("create_persistence_unknown", error);
  }
  if (persistedShipment.quoteExpiresAt <= dependencies.now()) {
    return providerDraftCleanupOutcomeCode(
      await fenceProviderDraftAndEnqueueCleanup({
        id: persistedShipment.id,
        providerShipmentId: provider.id,
        now: dependencies.now(),
      }),
    );
  }
  try {
    await requireCurrentShippingQuoteContext(
      persistedShipment,
      dependencies.now(),
      dependencies.assertQuoteContextCurrent,
    );
  } catch (error) {
    if (
      !(error instanceof DeterministicOperationError) ||
      error.code !== "shipping_quote_context_changed"
    ) {
      throw error;
    }
    const fenceResult = await fenceProviderDraftAndEnqueueCleanup({
      id: persistedShipment.id,
      providerShipmentId: provider.id,
      now: dependencies.now(),
    });
    return providerDraftCleanupOutcomeCode(fenceResult);
  }
  const policy = await loadShippingPolicyContext(dependencies.now());
  const config = getChitChatsConfig();
  const rates = selectCustomerRates(
    provider.rates ?? [],
    allowedTrackedServices(
      config.trackedPostageTypes,
      countryCode(shipment.destination),
      shipment.usShippingContractSnapshot,
    ),
    {
      atRiskValueCents: requiredInteger(job.payload, "merchandiseValueCents"),
      destinationCountryCode: countryCode(shipment.destination),
      estimatedDeliveryAt: provider.estimated_delivery_at,
      servicePolicies: policy.servicePolicies,
      signatureThresholdCents: policy.settings.signatureThresholdCents,
    },
  );
  if (!rates.length) {
    const fenceResult = await fenceProviderDraftAndEnqueueCleanup({
      id: persistedShipment.id,
      providerShipmentId: provider.id,
      now: dependencies.now(),
    });
    return `no_eligible_rates_${providerDraftCleanupOutcomeCode(fenceResult)}`;
  }
  const completed = await completeQuote({
    id: persistedShipment.id,
    expectedStateVersion: persistedShipment.stateVersion,
    providerShipmentId: provider.id,
    providerStatus: provider.status,
    rates,
    rawShipment: stripSignedLabelUrls(provider),
  });
  if (!completed) throw new FencedOperationError();
  return job.outcomeUnknown ? "create_reconciled" : "created";
}

function providerDraftCleanupOutcomeCode(
  result: Awaited<ReturnType<typeof fenceProviderDraftAndEnqueueCleanup>>,
): string {
  switch (result) {
    case "cleanup_enqueued":
      return "shipping_quote_context_changed_cleanup_enqueued";
    case "cleanup_pending":
      return "shipping_quote_context_changed_cleanup_pending";
    case "provider_already_cleaned":
      return "shipping_quote_context_changed_provider_already_cleaned";
    case "manual_review":
      return "shipping_quote_context_changed_cleanup_manual_review";
    case "fenced":
      throw new FencedOperationError();
  }
}

async function processQuoteRefresh(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  const shipment = await requireShipment(job.shipmentId);
  if (!job.outcomeUnknown) assertExpectedShipmentVersion(job, shipment);
  await requireCurrentShippingQuoteContext(
    shipment,
    dependencies.now(),
    dependencies.assertQuoteContextCurrent,
  );
  if (!shipment.providerShipmentId)
    throw new DeterministicOperationError(
      "provider_shipment_missing",
      "Provider shipment is missing",
    );
  let provider: ChitChatsShipment;
  const refreshIntent = shipmentRefreshIntent(job, shipment);
  try {
    provider = job.outcomeUnknown
      ? await dependencies.client.getShipment(shipment.providerShipmentId)
      : await dependencies.client.refreshShipment(
          shipment.providerShipmentId,
          refreshIntent,
        );
  } catch (error) {
    throw mutationFailure(error, "quote_refresh_outcome_unknown");
  }
  assertProviderMatchesRefreshIntent(provider, refreshIntent);
  const policy = await loadShippingPolicyContext(dependencies.now());
  const rates = selectCustomerRates(
    provider.rates ?? [],
    allowedTrackedServices(
      getChitChatsConfig().trackedPostageTypes,
      countryCode(shipment.destination),
      shipment.usShippingContractSnapshot,
    ),
    {
      atRiskValueCents: requiredAnyPositiveInteger(job.payload, [
        "atRiskValueCents",
        "merchandiseValueCents",
      ]),
      destinationCountryCode: countryCode(shipment.destination),
      estimatedDeliveryAt: provider.estimated_delivery_at,
      servicePolicies: policy.servicePolicies,
      signatureThresholdCents: policy.settings.signatureThresholdCents,
    },
  );
  if (!rates.length)
    return `no_eligible_rates_${providerDraftCleanupOutcomeCode(
      await fenceProviderDraftAndEnqueueCleanup({
        id: shipment.id,
        providerShipmentId: shipment.providerShipmentId,
        allowAttached: true,
        now: dependencies.now(),
      }),
    )}`;
  const persisted = await persistRefreshedProviderQuote({
    id: shipment.id,
    expectedStateVersion: shipment.stateVersion,
    providerStatus: provider.status,
    rates,
    rawShipment: stripSignedLabelUrls(provider),
    now: dependencies.now(),
  });
  if (!persisted)
    throw new UnknownMutationOutcomeError("quote_refresh_persistence_unknown");
  return job.outcomeUnknown ? "quote_refresh_reconciled" : "quote_refreshed";
}

async function processPurchase(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  let shipment = await requireShipment(job.shipmentId);
  if (!job.outcomeUnknown) assertExpectedShipmentVersion(job, shipment);
  // Flat-rate shipments defer provider-draft creation to fulfillment: the quote
  // was served synchronously from the cache with no carrier round-trip, so no
  // draft exists yet. Create and attach it now — before the readiness guard —
  // reusing the same create/reconcile safety model as `processCreate`, so the
  // rest of the purchase flow (refresh, rate selection, buy) runs unchanged.
  // Because the draft only exists once `providerShipmentId` is set, this block
  // runs only when no postage purchase has ever been attempted.
  let draftJustEnsured = false;
  if (shipment.flatRate && !shipment.providerShipmentId) {
    shipment = await ensureFlatRateProviderDraft(job, shipment, dependencies);
    draftJustEnsured = true;
  }
  if (!shipment.providerShipmentId || !shipment.selectedPostageType)
    throw new DeterministicOperationError(
      "purchase_not_ready",
      "Shipment is not ready for purchase",
    );
  const providerShipmentId = shipment.providerShipmentId;
  const selectedPostageType = shipment.selectedPostageType;
  let provider: ChitChatsShipment;
  let purchaseRequired = false;
  const refreshIntent = shipmentRefreshIntent(job, shipment);
  // A draft ensured on this run has never been purchased, so treat it as a fresh
  // purchase (refresh → select → buy) rather than reconciling a prior attempt.
  if (job.outcomeUnknown && !draftJustEnsured) {
    provider = await dependencies.client.getShipment(providerShipmentId);
    assertProviderMatchesRefreshIntent(provider, refreshIntent);
    const action = classifyProviderPurchaseAction(provider, true);
    if (action === "wait")
      throw new ReconciliationPendingError("purchase_reconciliation_pending");
    if (action === "manual_review")
      throw new ManualReviewMutationOutcomeError(
        "purchase_ambiguous_without_provider_evidence",
        `Ambiguous postage purchase reconciled to provider status ${provider.status}`,
      );
    purchaseRequired = action === "buy";
  } else {
    await requireCurrentShippingQuoteContext(
      shipment,
      dependencies.now(),
      dependencies.assertQuoteContextCurrent,
    );
    try {
      provider = await dependencies.client.refreshShipment(providerShipmentId, {
        ...refreshIntent,
      });
    } catch (error) {
      throw mutationFailure(error, "purchase_refresh_outcome_unknown");
    }
    assertProviderMatchesRefreshIntent(provider, refreshIntent);
    const action = classifyProviderPurchaseAction(provider, false);
    if (action === "wait")
      throw new ReconciliationPendingError("purchase_reconciliation_pending");
    if (action === "manual_review")
      throw new DeterministicOperationError(
        "purchase_refresh_state_invalid",
        `Refreshed provider status ${provider.status} is not eligible for purchase`,
      );
    purchaseRequired = action === "buy";
  }
  if (purchaseRequired) {
    await requireCurrentShippingQuoteContext(
      shipment,
      dependencies.now(),
      dependencies.assertQuoteContextCurrent,
    );
    const currentPolicy = await loadShippingPolicyContext(dependencies.now());
    const eligibleRates = selectCustomerRates(
      provider.rates ?? [],
      allowedTrackedServices(
        getChitChatsConfig().trackedPostageTypes,
        countryCode(shipment.destination),
        shipment.usShippingContractSnapshot,
      ),
      {
        atRiskValueCents: requiredInteger(job.payload, "atRiskValueCents"),
        destinationCountryCode: countryCode(shipment.destination),
        estimatedDeliveryAt: provider.estimated_delivery_at,
        servicePolicies: currentPolicy.servicePolicies,
        signatureThresholdCents: currentPolicy.settings.signatureThresholdCents,
      },
    );
    const persistedRefresh = await persistRefreshedProviderQuote({
      id: shipment.id,
      expectedStateVersion: shipment.stateVersion,
      providerStatus: provider.status,
      rates: eligibleRates,
      rawShipment: stripSignedLabelUrls(provider),
      now: dependencies.now(),
    });
    if (!persistedRefresh)
      throw new UnknownMutationOutcomeError(
        "purchase_refresh_persistence_unknown",
      );
    shipment = await requireShipment(shipment.id);
    if (!eligibleRates.length) {
      const cleanup = await fenceProviderDraftAndEnqueueCleanup({
        id: shipment.id,
        providerShipmentId,
        allowAttached: true,
        now: dependencies.now(),
      });
      const released = await finalizeShipmentFundingReservation({
        operationId: job.id,
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
        outcome: "released",
        now: dependencies.now(),
      });
      if (!released) throw new FencedOperationError();
      return `purchase_no_eligible_rates_${providerDraftCleanupOutcomeCode(cleanup)}`;
    }
    // Flat-rate orders quoted a fixed price the customer already paid; the
    // studio buys the cheapest eligible service at fulfillment (the stored
    // postage type was only the representative service priced at cache time).
    // Live quotes still buy the exact service the customer selected.
    const eligibleSelected = shipment.flatRate
      ? cheapestEligibleRate(eligibleRates)
      : eligibleRates.find((rate) => rate.postageType === selectedPostageType);
    if (!eligibleSelected) {
      const cleanup = await fenceProviderDraftAndEnqueueCleanup({
        id: shipment.id,
        providerShipmentId,
        allowAttached: true,
        now: dependencies.now(),
      });
      const released = await finalizeShipmentFundingReservation({
        operationId: job.id,
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
        outcome: "released",
        now: dependencies.now(),
      });
      if (!released) throw new FencedOperationError();
      return `selected_service_policy_changed_${providerDraftCleanupOutcomeCode(cleanup)}`;
    }
    const purchaseAmountCents = eligibleSelected.paymentAmountCents;
    if (!purchaseAmountCents || purchaseAmountCents <= 0)
      throw new DeterministicOperationError(
        "purchase_amount_invalid",
        "The refreshed provider purchase amount is invalid",
      );
    const fundingAvailable = await recheckShipmentPurchaseFunding({
      operationId: job.id,
      leaseOwner: job.leaseOwner ?? dependencies.workerId,
      expectedStateVersion: job.stateVersion,
      requiredAmountCents: purchaseAmountCents,
      now: dependencies.now(),
    });
    if (!fundingAvailable)
      throw new DeterministicOperationError(
        "purchase_funding_unavailable",
        "Shipping funding is stale, failed, or insufficient",
      );
    const providerCallAuthorized = await markShipmentPurchaseProviderCallIntent(
      {
        operationId: job.id,
        leaseOwner: job.leaseOwner ?? dependencies.workerId,
        expectedStateVersion: job.stateVersion,
        now: dependencies.now(),
      },
    );
    if (!providerCallAuthorized)
      throw new DeterministicOperationError(
        "p10_termination_started",
        "Postage purchase was fenced before the provider call",
      );
    try {
      provider = await dependencies.client.buyShipment(providerShipmentId, {
        postageType: eligibleSelected.postageType,
      });
    } catch (error) {
      throw mutationFailure(error, "purchase_outcome_unknown");
    }
  }
  if (provider.status === "postage_requested")
    throw new UnknownMutationOutcomeError("purchase_reconciliation_pending");
  if (provider.status === "postage_purchase_failed")
    throw new DeterministicOperationError(
      "postage_purchase_failed",
      "Postage purchase failed",
    );
  const purchaseConfirmation = classifyProviderPurchaseConfirmation(provider);
  if (!purchaseConfirmation.statusConfirmed) {
    throw new UnknownMutationOutcomeError(
      "purchase_accounting_manual_review",
      new Error(
        `Provider status ${provider.status} does not prove a settled postage purchase`,
      ),
    );
  }
  const confirmedSettledPurchaseCents =
    purchaseConfirmation.settledPurchaseCents ??
    shipment.actualPurchaseTotalCents;
  if (confirmedSettledPurchaseCents === null) {
    const settlement = parseProviderSettlement({
      purchaseAmount: provider.purchase_amount,
      postageFee: provider.postage_fee,
      insuranceFee: provider.insurance_fee,
      deliveryFee: provider.delivery_fee,
      tariffFee: provider.tariff_fee,
      fdaPriorNotificationFee: provider.fda_prior_notification_fee,
      federalTax: provider.federal_tax,
      provincialTax: provider.provincial_tax,
    });
    await recordUnsettledProviderAccountingEvidence({
      id: shipment.id,
      expectedStateVersion: shipment.stateVersion,
      providerStatus: provider.status,
      rawShipment: stripSignedLabelUrls(provider),
      actualPostageCents: settlement.postageCents,
      actualInsuranceCents: settlement.insuranceCents,
      actualDeliveryFeeCents: settlement.deliveryFeeCents,
      actualTariffFeeCents: settlement.tariffFeeCents,
      actualFdaPriorNotificationFeeCents:
        settlement.fdaPriorNotificationFeeCents,
      actualFederalTaxCents: settlement.federalTaxCents,
      actualProvincialTaxCents: settlement.provincialTaxCents,
      now: dependencies.now(),
    });
    throw new UnknownMutationOutcomeError(
      "purchase_settlement_missing",
      new Error(
        "Provider status is purchased but settled purchase evidence is missing",
      ),
    );
  }
  try {
    await persistProviderState(shipment, provider, dependencies.now());
  } catch (error) {
    throw new UnknownMutationOutcomeError(
      "purchase_persistence_unknown",
      error,
    );
  }
  const settled = await finalizeShipmentFundingReservation({
    operationId: job.id,
    leaseOwner: job.leaseOwner ?? dependencies.workerId,
    expectedStateVersion: job.stateVersion,
    outcome: "settled",
    now: dependencies.now(),
  });
  if (!settled) throw new FencedOperationError();
  return job.outcomeUnknown ? "purchase_reconciled" : "purchased";
}

/**
 * Create the Chit Chats draft for a flat-rate shipment at fulfillment time and
 * attach it to the local shipment. Mirrors `processCreate`'s safety model: on a
 * fresh attempt it creates the draft; on an outcome-unknown retry it reconciles
 * by public reference so a partial prior attempt never yields a duplicate draft.
 * `persistKnownProviderDraft` is idempotent and fenced on `providerShipmentId`
 * being null, so a re-run after a successful persist is a no-op.
 */
async function ensureFlatRateProviderDraft(
  job: ShipmentOperationRow,
  shipment: Awaited<ReturnType<typeof requireShipment>>,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<Awaited<ReturnType<typeof requireShipment>>> {
  let provider: ChitChatsShipment;
  if (job.outcomeUnknown) {
    provider = await reconcileCreate(
      dependencies.client,
      shipment.publicReference,
    );
  } else {
    try {
      provider = await dependencies.client.createShipment({
        recipient: shipment.destination as never,
        packageSnapshot: shipment.packageSnapshot,
        customsLines: shipment.customsLines,
        merchandiseValueCents: requiredInteger(job.payload, "atRiskValueCents"),
        orderReference: shipment.publicReference,
        signatureRequested: shipment.signatureRequested,
      });
    } catch (error) {
      throw mutationFailure(error, "flat_rate_create_outcome_unknown");
    }
  }
  // Any failure persisting or reloading after the draft exists at the provider
  // must surface as outcome-unknown so the retry RECONCILES by public reference
  // (via the `job.outcomeUnknown` branch above) instead of creating a second,
  // orphaned draft. A raw DB throw here would otherwise be classified as a plain
  // retryable error (outcomeUnknown=false) and re-enter the create branch. This
  // mirrors `processCreate`'s persist handling.
  try {
    const persisted = await persistKnownProviderDraft({
      id: shipment.id,
      providerShipmentId: provider.id,
      providerStatus: provider.status,
      rawShipment: stripSignedLabelUrls(provider),
      now: dependencies.now(),
    });
    if (!persisted)
      throw new Error("Provider draft conflicted with local shipment state");
    return await requireShipment(shipment.id);
  } catch (error) {
    throw new UnknownMutationOutcomeError(
      "flat_rate_create_persistence_unknown",
      error,
    );
  }
}

/** The lowest-cost rate in a non-empty eligible set (flat-rate fulfillment). */
function cheapestEligibleRate(
  rates: readonly ProductShipmentRateSnapshot[],
): ProductShipmentRateSnapshot | undefined {
  return rates.reduce<ProductShipmentRateSnapshot | undefined>(
    (best, rate) =>
      !best || rate.paymentAmountCents < best.paymentAmountCents ? rate : best,
    undefined,
  );
}

export function classifyProviderPurchaseConfirmation(
  provider: ChitChatsShipment,
): { settledPurchaseCents: number | null; statusConfirmed: boolean } {
  const statusConfirmed = [
    "label_ready",
    "accepted",
    "in_transit",
    "delivered",
    "exception",
  ].includes(normalizeChitChatsStatus(provider));
  if (!statusConfirmed) return { settledPurchaseCents: null, statusConfirmed };
  return {
    statusConfirmed,
    settledPurchaseCents: parseProviderSettlement({
      purchaseAmount: provider.purchase_amount,
      postageFee: provider.postage_fee,
      insuranceFee: provider.insurance_fee,
      deliveryFee: provider.delivery_fee,
      tariffFee: provider.tariff_fee,
      fdaPriorNotificationFee: provider.fda_prior_notification_fee,
      federalTax: provider.federal_tax,
      provincialTax: provider.provincial_tax,
    }).settledPurchaseCents,
  };
}

export function classifyProviderPurchaseAction(
  provider: ChitChatsShipment,
  outcomeUnknown: boolean,
): "buy" | "reconcile" | "wait" | "manual_review" {
  const normalized = normalizeChitChatsStatus(provider);
  if (normalized === "purchase_pending") return "wait";
  if (
    [
      "label_ready",
      "accepted",
      "in_transit",
      "exception",
      "delivered",
    ].includes(normalized)
  )
    return "reconcile";
  if (normalized === "quoted") return outcomeUnknown ? "manual_review" : "buy";
  return "manual_review";
}

async function processTracking(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  const shipment = await requireShipment(job.shipmentId);
  assertExpectedShipmentVersion(job, shipment);
  if (!shipment.providerShipmentId)
    throw new DeterministicOperationError(
      "provider_shipment_missing",
      "Provider shipment is missing",
    );
  const provider = await dependencies.client.getShipment(
    shipment.providerShipmentId,
  );
  await persistProviderState(shipment, provider, dependencies.now());
  return "tracking_reconciled";
}

async function processRefund(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  const shipment = await requireShipment(job.shipmentId);
  if (!job.outcomeUnknown) assertExpectedShipmentVersion(job, shipment);
  if (!shipment.providerShipmentId)
    throw new DeterministicOperationError(
      "provider_shipment_missing",
      "Provider shipment is missing",
    );
  let provider: ChitChatsShipment;
  if (job.outcomeUnknown) {
    provider = await dependencies.client.getShipment(
      shipment.providerShipmentId,
    );
    if (normalizeChitChatsStatus(provider) !== "voided")
      throw new ReconciliationPendingError("refund_reconciliation_pending");
  } else {
    try {
      provider = await dependencies.client.refundShipment(
        shipment.providerShipmentId,
      );
    } catch (error) {
      throw mutationFailure(error, "refund_outcome_unknown");
    }
  }
  try {
    await persistProviderState(shipment, provider, dependencies.now());
  } catch (error) {
    throw new UnknownMutationOutcomeError("refund_persistence_unknown", error);
  }
  return normalizeChitChatsStatus(provider) === "voided"
    ? "refund_confirmed"
    : "refund_requested";
}

async function processDelete(
  job: ShipmentOperationRow,
  dependencies: ShippingOperationWorkerDependencies,
): Promise<string> {
  const shipment = await requireShipment(job.shipmentId);
  if (!job.outcomeUnknown) assertExpectedShipmentVersion(job, shipment);
  let providerId = shipment.providerShipmentId;
  if (!providerId) {
    const matches = (
      await dependencies.client.findShipments(shipment.publicReference)
    ).filter((candidate) => candidate.order_id === shipment.publicReference);
    if (matches.length > 1)
      throw new DeterministicOperationError(
        "ambiguous_provider_drafts",
        "Multiple provider drafts matched",
      );
    if (!matches.length) return "provider_not_found";
    providerId = matches[0]!.id;
  }
  try {
    const provider = await dependencies.client.getShipment(providerId);
    if (provider.status !== "unpaid")
      throw new DeterministicOperationError(
        "provider_not_deletable",
        "Provider shipment is no longer unpaid",
      );
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404)
      return job.outcomeUnknown
        ? "provider_deleted_reconciled"
        : "provider_not_found";
    throw error;
  }
  try {
    await dependencies.client.deleteShipment(providerId);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404)
      return "provider_not_found";
    throw mutationFailure(error, "delete_outcome_unknown");
  }
  return "provider_deleted";
}

async function reconcileCreate(
  client: ChitChatsClient,
  publicReference: string,
): Promise<ChitChatsShipment> {
  const matches = (await client.findShipments(publicReference)).filter(
    (candidate) => candidate.order_id === publicReference,
  );
  if (matches.length !== 1)
    throw matches.length > 1
      ? new DeterministicOperationError(
          "ambiguous_provider_drafts",
          "Multiple provider shipments matched",
        )
      : new ReconciliationPendingError("create_reconciliation_pending");
  return matches[0]!;
}

async function persistProviderState(
  shipment: Awaited<ReturnType<typeof requireShipment>>,
  provider: ChitChatsShipment,
  observedAt: Date,
): Promise<void> {
  const settlement = parseProviderSettlement({
    purchaseAmount: provider.purchase_amount,
    postageFee: provider.postage_fee,
    insuranceFee: provider.insurance_fee,
    deliveryFee: provider.delivery_fee,
    tariffFee: provider.tariff_fee,
    fdaPriorNotificationFee: provider.fda_prior_notification_fee,
    federalTax: provider.federal_tax,
    provincialTax: provider.provincial_tax,
  });
  const providerNormalized = normalizeChitChatsStatus(provider);
  let normalized = normalizeChitChatsTransition(shipment.status, provider);
  const settledPurchaseCents =
    settlement.settledPurchaseCents ?? shipment.actualPurchaseTotalCents;
  if (
    [
      "label_ready",
      "accepted",
      "in_transit",
      "exception",
      "delivered",
    ].includes(normalized) &&
    settledPurchaseCents === null
  ) {
    await recordUnsettledProviderAccountingEvidence({
      id: shipment.id,
      expectedStateVersion: shipment.stateVersion,
      providerStatus: provider.status,
      rawShipment: stripSignedLabelUrls(provider),
      actualPostageCents: settlement.postageCents,
      actualInsuranceCents: settlement.insuranceCents,
      actualDeliveryFeeCents: settlement.deliveryFeeCents,
      actualTariffFeeCents: settlement.tariffFeeCents,
      actualFdaPriorNotificationFeeCents:
        settlement.fdaPriorNotificationFeeCents,
      actualFederalTaxCents: settlement.federalTaxCents,
      actualProvincialTaxCents: settlement.provincialTaxCents,
      now: observedAt,
    });
    await sendShippingPolicyAlert({
      duties: ["finance_owner", "operations_lead"],
      critical: true,
      subject: `Missing settled postage cost: ${shipment.publicReference}`,
      message: `The provider shipment is purchased but authoritative purchase_amount is absent. Component evidence totals ${settlement.componentTotalCents ?? "incomplete"} cents and was stored separately without treating it as settlement.`,
      idempotencyKey: `shipping-settlement-missing/${shipment.id}/${provider.status}`,
    }).catch(() => undefined);
    throw new UnknownMutationOutcomeError("settled_cost_missing");
  }
  const transitionEvent = providerShipmentTransitionEvent(provider, observedAt);
  if (
    !transitionEvent.authoritative &&
    normalized === providerNormalized &&
    ["accepted", "in_transit", "exception", "delivered"].includes(
      providerNormalized,
    )
  ) {
    normalized = "manual_review";
    await sendShippingPolicyAlert({
      duties: ["operations_lead", "security_owner"],
      critical: true,
      subject: `Unverified shipment transition time: ${shipment.publicReference}`,
      message: `Chit Chats reported ${provider.status} without a matching certified tracking event timestamp. The shipment was placed in manual review; ${transitionEvent.source} was retained only as fallback evidence.`,
      idempotencyKey: `shipping-transition-time-missing/${shipment.id}/${provider.status}/${transitionEvent.eventAt.toISOString()}`,
    }).catch(() => undefined);
  }
  const eventAt = transitionEvent.eventAt;
  const updated = await updateShipmentFromProvider({
    id: shipment.id,
    expectedStateVersion: shipment.stateVersion,
    status: normalized,
    providerStatus: provider.status,
    rawShipment: stripSignedLabelUrls(provider),
    trackingNumber: provider.carrier_tracking_code,
    trackingUrl: provider.tracking_url,
    actualPurchaseTotalCents: settledPurchaseCents,
    actualPostageCents: settlement.postageCents,
    actualInsuranceCents: settlement.insuranceCents,
    actualDeliveryFeeCents: settlement.deliveryFeeCents,
    actualTariffFeeCents: settlement.tariffFeeCents,
    actualFdaPriorNotificationFeeCents: settlement.fdaPriorNotificationFeeCents,
    actualFederalTaxCents: settlement.federalTaxCents,
    actualProvincialTaxCents: settlement.provincialTaxCents,
    estimatedDeliveryAt: provider.estimated_delivery_at,
    providerEventAt: eventAt,
    providerPurchasedAt: providerInstant(
      provider.postage_purchase_date,
      observedAt,
    ),
    providerShipDateAt: providerInstant(provider.ship_date, observedAt),
  });
  if (!updated) {
    const current = await getShipmentForOperation(shipment.id);
    if (!current?.providerEventAt || current.providerEventAt < eventAt) {
      throw new FencedOperationError();
    }
    normalized = current.status;
  } else if (
    !shipment.flatRate &&
    settledPurchaseCents !== null &&
    shipment.quotedShippingCents !== null &&
    settledPurchaseCents !== shipment.quotedShippingCents
  ) {
    // For flat-rate shipments the settled cost is expected to differ from the
    // quoted flat price by design, so the variance alert is intentionally
    // suppressed to avoid alerting the finance owner on every order.
    const variance = settledPurchaseCents - shipment.quotedShippingCents;
    await sendShippingPolicyAlert({
      duties: ["finance_owner"],
      critical: false,
      subject: `Settled postage variance: ${shipment.publicReference}`,
      message: `The settled Chit Chats debit differs from the customer quote by ${variance} cents. Review the provider adjustment and accounting treatment.`,
      idempotencyKey: `shipping-settlement-variance/${shipment.id}/${settledPurchaseCents}`,
    }).catch(() => undefined);
  }
  for (const event of provider.tracking_events ?? []) {
    const occurredAt = event.created_at
      ? new Date(event.created_at)
      : observedAt;
    if (!Number.isFinite(occurredAt.getTime())) continue;
    await recordShipmentEvent({
      shipmentId: shipment.id,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            shipment.id,
            event.type,
            event.title,
            event.status,
            event.created_at,
          ]),
        )
        .digest("hex"),
      providerStatus: event.status ?? undefined,
      normalizedStatus: normalized,
      description: event.title ?? undefined,
      payload: Object.fromEntries(
        Object.entries(event).filter(
          ([key, value]) =>
            !key.toLowerCase().includes("url") &&
            (value === null ||
              ["string", "number", "boolean"].includes(typeof value)),
        ),
      ),
      occurredAt,
    });
  }
  const context = await getCustomerPaidShipmentShippingContext(shipment.id);
  if (
    !shipment.flatRate &&
    context &&
    settledPurchaseCents !== null &&
    context.paidShippingCents - settledPurchaseCents >= 100
  ) {
    // Flat-rate orders quote a fixed, rounded-up price the studio commits to.
    // The flat price is final both ways (owner directive): the studio absorbs
    // the difference when the settled label costs less, so no variance refund
    // is issued. Live per-order quotes keep the automatic refund below.
    await queueProductOrderRefund({
      orderReference: context.orderReference,
      paymentTransactionId: context.paymentTransactionId,
      amountCents: context.paidShippingCents - settledPurchaseCents,
      component: "outbound_shipping",
      sourceShipmentId: shipment.id,
      reason: `Settled Chit Chats cost decrease for shipment ${shipment.id}`,
      automated: true,
    });
  }
}

function providerInstant(
  value: string | null | undefined,
  observedAt: Date,
): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed <= observedAt
    ? parsed
    : null;
}

async function requireShipment(id: string) {
  const shipment = await getShipmentForOperation(id);
  if (!shipment)
    throw new DeterministicOperationError(
      "local_shipment_missing",
      "Local shipment is missing",
    );
  return shipment;
}

async function requireCurrentShippingQuoteContext(
  shipment: Awaited<ReturnType<typeof requireShipment>>,
  now: Date,
  assertCurrent: typeof assertShippingQuoteContextCurrent = assertShippingQuoteContextCurrent,
): Promise<void> {
  try {
    const expectedContext = parseShippingQuoteContextSnapshot(
      shipment.deadlinePolicySnapshot,
    );
    if (
      !expectedContext &&
      assertCurrent === assertShippingQuoteContextCurrent
    ) {
      throw new Error("Shipping quote context snapshot is missing");
    }
    await assertCurrent({
      destinationCountryCode: countryCode(shipment.destination),
      ...(expectedContext ? { expectedContext } : {}),
      now,
    });
    if (countryCode(shipment.destination) === "US") {
      await assertUsShippingContractCurrent({
        snapshot: shipment.usShippingContractSnapshot,
        now,
      });
    }
  } catch (error) {
    throw new DeterministicOperationError(
      "shipping_quote_context_changed",
      error instanceof Error
        ? error.message
        : "Shipping quote context is no longer current",
    );
  }
}

function mutationFailure(error: unknown, code: string): Error {
  if (
    error instanceof ProviderError &&
    error.status < 500 &&
    error.status !== 429
  )
    return new DeterministicOperationError(
      code.replace("_outcome_unknown", "_rejected"),
      describeProviderRejection(error),
    );
  return new UnknownMutationOutcomeError(code, error);
}

/**
 * Attach the provider's rejection body to the error message so it lands in the
 * dead-lettered job's `last_error` (via completeShipmentJob) and the failure is
 * diagnosable from the DB without replaying the request. Signed URLs and email
 * addresses are redacted, and the body is truncated before persistence.
 */
function describeProviderRejection(error: ProviderError): string {
  const detail = summarizeProviderErrorBody(error.responseBody);
  return detail ? `${error.message}: ${detail}` : error.message;
}

function summarizeProviderErrorBody(body: unknown): string | null {
  const message = extractProviderErrorMessage(body);
  if (message === null) return null;
  const masked = message
    // Strip signed URLs (bearer capabilities); stop at JSON/quote delimiters so
    // trailing context is not swallowed.
    .replace(/https?:\/\/[^\s"',}]+/gi, "[url]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    // Mask long digit runs so an echoed phone/postal/account number cannot be
    // persisted (field-limit maxima like "35" are two digits and survive).
    .replace(/\d{5,}/g, "[redacted]")
    .trim();
  return masked ? masked.slice(0, 500) : null;
}

/**
 * Extract only the provider's human-readable error string. Chit Chats errors
 * are shaped `{ error: { message } }` (or `{ error }` / `{ message }`); prefer
 * that allowlisted field so the full request echo is never persisted. Unknown
 * shapes fall back to a bounded stringify, still scrubbed by the caller.
 */
function extractProviderErrorMessage(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const nested = (record.error as Record<string, unknown>).message;
      if (typeof nested === "string") return nested;
    }
    if (typeof record.message === "string") return record.message;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return null;
  }
}

function classifyOperationError(error: unknown): {
  retryable: boolean;
  outcomeUnknown: boolean;
  retryAfterSeconds: number | null;
  code: string;
  message: string;
} {
  if (error instanceof FencedOperationError)
    return {
      retryable: false,
      outcomeUnknown: false,
      retryAfterSeconds: null,
      code: "state_fenced",
      message: error.message,
    };
  if (error instanceof DeterministicOperationError)
    return {
      retryable: false,
      outcomeUnknown: false,
      retryAfterSeconds: null,
      code: error.code,
      message: error.message,
    };
  if (error instanceof ManualReviewMutationOutcomeError)
    return {
      retryable: false,
      outcomeUnknown: true,
      retryAfterSeconds: null,
      code: error.code,
      message: error.message,
    };
  if (
    error instanceof Error &&
    error.name === "ProviderDraftCleanupQueuedError"
  )
    return {
      retryable: false,
      outcomeUnknown: false,
      retryAfterSeconds: null,
      code: "provider_draft_cleanup_queued",
      message: error.message,
    };
  if (
    error instanceof Error &&
    error.name === "AmbiguousShipmentOperationError"
  )
    return {
      retryable: true,
      outcomeUnknown: true,
      retryAfterSeconds: null,
      code: "provider_mutation_outcome_unknown",
      message: error.message,
    };
  if (error instanceof UnknownMutationOutcomeError)
    return {
      retryable: true,
      outcomeUnknown: true,
      retryAfterSeconds: error.retryAfterSeconds,
      code: error.code,
      message: error.message,
    };
  if (error instanceof ReconciliationPendingError)
    return {
      retryable: true,
      outcomeUnknown: true,
      retryAfterSeconds: null,
      code: error.code,
      message: error.message,
    };
  if (error instanceof ProviderError)
    return {
      retryable: error.status === 429 || error.status >= 500,
      outcomeUnknown: false,
      retryAfterSeconds: error.retryAfterSeconds,
      code: `provider_${error.status}`,
      message: error.message,
    };
  return {
    retryable: true,
    outcomeUnknown: false,
    retryAfterSeconds: null,
    code: "operation_failed",
    message:
      error instanceof Error ? error.message : "Shipment operation failed",
  };
}

class DeterministicOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class ReconciliationPendingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class UnknownMutationOutcomeError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(code, { cause });
    this.retryAfterSeconds =
      cause instanceof ProviderError ? cause.retryAfterSeconds : null;
  }
}

class ManualReviewMutationOutcomeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class FencedOperationError extends Error {
  constructor() {
    super("Shipment operation was fenced by newer state");
  }
}

function requiredInteger(
  payload: Record<string, unknown> | null,
  key: string,
): number {
  const value = payload?.[key];
  if (!Number.isInteger(value) || Number(value) <= 0)
    throw new DeterministicOperationError(
      "operation_payload_invalid",
      `${key} is invalid`,
    );
  return Number(value);
}

function requiredString(
  payload: Record<string, unknown> | null,
  key: string,
): string {
  const value = payload?.[key];
  if (typeof value !== "string" || !value.trim())
    throw new DeterministicOperationError(
      "operation_payload_invalid",
      `${key} is invalid`,
    );
  return value;
}

function requiredAnyPositiveInteger(
  payload: Record<string, unknown> | null,
  keys: string[],
): number {
  for (const key of keys) {
    const value = payload?.[key];
    if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  }
  throw new DeterministicOperationError(
    "operation_payload_invalid",
    `${keys.join(" or ")} is invalid`,
  );
}

type ShipmentRefreshIntent = Parameters<ChitChatsClient["refreshShipment"]>[1];

function shipmentRefreshIntent(
  job: ShipmentOperationRow,
  shipment: Awaited<ReturnType<typeof requireShipment>>,
): ShipmentRefreshIntent {
  return {
    packageType: shipment.packageSnapshot.packageType,
    weightGrams: requiredInteger(job.payload, "measuredWeightGrams"),
    lengthCm: shipment.packageSnapshot.lengthCm,
    widthCm: shipment.packageSnapshot.widthCm,
    heightCm: shipment.packageSnapshot.heightCm,
    shipDate: requiredString(job.payload, "shipDate"),
    signatureRequested: shipment.signatureRequired,
  };
}

/**
 * A GET may reconcile an ambiguous PATCH only when every immutable PATCH
 * field is echoed exactly. Otherwise a retry could buy a stale provider draft.
 */
export function assertProviderMatchesRefreshIntent(
  provider: ChitChatsShipment,
  intent: ShipmentRefreshIntent,
): void {
  const exact =
    provider.package_type === intent.packageType &&
    provider.weight_unit === "g" &&
    exactProviderNumber(provider.weight) === intent.weightGrams &&
    provider.size_unit === "cm" &&
    exactProviderNumber(provider.size_x) === intent.lengthCm &&
    exactProviderNumber(provider.size_y) === intent.widthCm &&
    exactProviderNumber(provider.size_z) === intent.heightCm &&
    provider.signature_requested === intent.signatureRequested &&
    exactProviderShipDate(provider.ship_date) === intent.shipDate;
  if (!exact) {
    throw new UnknownMutationOutcomeError("refresh_intent_mismatch");
  }
}

function exactProviderNumber(value: unknown): number | null {
  if (typeof value === "number")
    return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function exactProviderShipDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
  return match?.[1] ?? null;
}

function assertExpectedShipmentVersion(
  job: ShipmentOperationRow,
  shipment: { stateVersion: number },
): void {
  const expected = job.payload?.expectedShipmentStateVersion;
  if (!Number.isInteger(expected) || expected !== shipment.stateVersion) {
    throw new FencedOperationError();
  }
}

function countryCode(destination: {
  country: string;
  countryCode?: "CA" | "US";
}): "CA" | "US" {
  return (
    destination.countryCode ??
    (destination.country.toUpperCase() === "CANADA" ? "CA" : "US")
  );
}

function allowedTrackedServices(
  configured: ReadonlySet<string>,
  destinationCountryCode: "CA" | "US",
  contract:
    | import("@/lib/private-db/schema").FulfillmentProviderCertificationContractSnapshot
    | null,
): ReadonlySet<string> {
  if (destinationCountryCode !== "US") return configured;
  if (contract?.importTerms !== "DDU") return new Set();
  return new Set(
    [...configured].filter((service) =>
      contract.allowedServiceCodes.includes(service),
    ),
  );
}

function defaultDependencies(): ShippingOperationWorkerDependencies {
  return {
    client: createChitChatsClient(getChitChatsConfig()),
    now: () => new Date(),
    workerId: `chitchats/${randomUUID()}`,
  };
}

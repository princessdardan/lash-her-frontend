import "server-only";

import { getChitChatsConfig } from "./config";
import {
  createChitChatsClient,
  type ChitChatsClient,
} from "./chitchats-client";
import { loadShippingPolicyContext } from "./policy";
import { PRODUCT_SHIPPING_US_DDU_CONTRACT } from "./product-shipping-config";
import { selectCustomerRates } from "./rates";
import { upsertFlatRateCacheEntry } from "./flat-rate-cache-store";
import {
  REPRESENTATIVE_DESTINATIONS,
  REPRESENTATIVE_PARCELS,
  SHIPPING_ZONE_IDS,
  SIZE_BUCKET_IDS,
  type ShippingZoneId,
  type SizeBucketId,
} from "./flat-rate-zones";
import type { ShippingCountryCode, ShippingRecipient } from "./types";
import type {
  ProductShipmentCustomsLineSnapshot,
  ProductShipmentPackageSnapshot,
} from "@/lib/private-db/schema";

/**
 * Weekly (or nightly) refresh of the flat-rate shipping cache.
 *
 * For every `{zone × size bucket}` we create an ephemeral Chit Chats draft for a
 * representative parcel to a representative destination, run the SAME
 * rate-eligibility selection the live fulfillment path uses (tracked + insured +
 * DDU-allowed for the U.S. + signature/insurance policy), take the cheapest
 * eligible rate, and store it. The draft is always deleted afterwards.
 *
 * When a cell yields no eligible rate we DO NOT write a row: checkout falls back
 * to the conservative per-zone default (see DEFAULT_FLAT_RATE_CENTS), so a gap
 * over-charges slightly rather than blocking a sale. That is intentional and
 * consistent with the flat-rate finality decision (the studio absorbs variance).
 *
 * Modeling note: the representative merchandise value is deliberately modest
 * (below the signature threshold and typical insurance limits) so the cached
 * price reflects the common order. High-value orders that require
 * signature-on-delivery therefore under-recover shipping slightly; that
 * difference is absorbed by the studio (flat price is final).
 */

/** Representative declared value for rate probing (cents). Below the signature
 * threshold so cached prices reflect the common, non-signature order. */
const REPRESENTATIVE_MERCHANDISE_VALUE_CENTS = 6000;

/** Representative HS tariff code for a rate-probe customs declaration — a valid
 * 10-digit HTS (3304.20.00.00, eye make-up preparations) that Chit Chats
 * accepts. Only used to shape the ephemeral cross-border draft so the carrier
 * returns rates; the real per-product HS code is declared on the actual shipment
 * at fulfillment, and rate cost does not depend on the HS code. */
const REPRESENTATIVE_HS_TARIFF_CODE = "3304200000";

export interface FlatRateRefreshCellResult {
  zoneId: ShippingZoneId;
  sizeBucketId: SizeBucketId;
  outcome: "updated" | "skipped" | "failed";
  amountCents?: number;
  postageType?: string;
  reason?: string;
}

export interface FlatRateRefreshResult {
  attempted: number;
  updated: number;
  skipped: number;
  failed: number;
  cells: FlatRateRefreshCellResult[];
}

export async function refreshFlatRateCache(deps?: {
  client?: ChitChatsClient;
  now?: () => Date;
}): Promise<FlatRateRefreshResult> {
  const client = deps?.client ?? createChitChatsClient(getChitChatsConfig());
  const now = deps?.now ?? (() => new Date());
  const config = getChitChatsConfig();
  const policy = await loadShippingPolicyContext(now());

  const cells: FlatRateRefreshCellResult[] = [];
  for (const zoneId of SHIPPING_ZONE_IDS) {
    const destination = REPRESENTATIVE_DESTINATIONS[zoneId];
    for (const sizeBucketId of SIZE_BUCKET_IDS) {
      cells.push(
        await refreshCell({
          zoneId,
          sizeBucketId,
          countryCode: destination.countryCode,
          recipient: buildRepresentativeRecipient(zoneId),
          packageSnapshot: buildRepresentativePackage(sizeBucketId),
          customsLines: buildRepresentativeCustomsLines(sizeBucketId),
          client,
          trackedPostageTypes: config.trackedPostageTypes,
          servicePolicies: policy.servicePolicies,
          signatureThresholdCents: policy.settings.signatureThresholdCents,
          now: now(),
        }),
      );
    }
  }

  return {
    attempted: cells.length,
    updated: cells.filter((cell) => cell.outcome === "updated").length,
    skipped: cells.filter((cell) => cell.outcome === "skipped").length,
    failed: cells.filter((cell) => cell.outcome === "failed").length,
    cells,
  };
}

async function refreshCell(input: {
  zoneId: ShippingZoneId;
  sizeBucketId: SizeBucketId;
  countryCode: ShippingCountryCode;
  recipient: ShippingRecipient;
  packageSnapshot: ProductShipmentPackageSnapshot;
  customsLines: ProductShipmentCustomsLineSnapshot[];
  client: ChitChatsClient;
  trackedPostageTypes: ReadonlySet<string>;
  servicePolicies: Awaited<
    ReturnType<typeof loadShippingPolicyContext>
  >["servicePolicies"];
  signatureThresholdCents: number;
  now: Date;
}): Promise<FlatRateRefreshCellResult> {
  const base = { zoneId: input.zoneId, sizeBucketId: input.sizeBucketId };
  let draftId: string | null = null;
  try {
    const draft = await input.client.createShipment({
      recipient: input.recipient,
      packageSnapshot: input.packageSnapshot,
      customsLines: input.customsLines,
      merchandiseValueCents: REPRESENTATIVE_MERCHANDISE_VALUE_CENTS,
      orderReference: `flat-rate-probe-${input.zoneId}-${input.sizeBucketId}`,
      signatureRequested: false,
    });
    draftId = draft.id;

    const eligible = selectCustomerRates(
      draft.rates ?? [],
      allowedRefreshServices(input.countryCode, input.trackedPostageTypes),
      {
        atRiskValueCents: REPRESENTATIVE_MERCHANDISE_VALUE_CENTS,
        destinationCountryCode: input.countryCode,
        estimatedDeliveryAt: draft.estimated_delivery_at,
        servicePolicies: input.servicePolicies,
        signatureThresholdCents: input.signatureThresholdCents,
      },
    );
    const cheapest = eligible.reduce<(typeof eligible)[number] | null>(
      (best, rate) =>
        !best || rate.paymentAmountCents < best.paymentAmountCents
          ? rate
          : best,
      null,
    );
    if (!cheapest || cheapest.paymentAmountCents <= 0) {
      return { ...base, outcome: "skipped", reason: "no_eligible_rate" };
    }

    await upsertFlatRateCacheEntry(
      {
        zoneId: input.zoneId,
        sizeBucketId: input.sizeBucketId,
        countryCode: input.countryCode,
        postageType: cheapest.postageType,
        title: cheapest.title,
        amountCents: cheapest.paymentAmountCents,
        deliveryMaxBusinessDays: cheapest.deliveryMaxBusinessDays ?? null,
      },
      input.now,
    );
    return {
      ...base,
      outcome: "updated",
      amountCents: cheapest.paymentAmountCents,
      postageType: cheapest.postageType,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "failed",
      reason: error instanceof Error ? error.message : "unknown",
    };
  } finally {
    if (draftId) {
      // Best-effort cleanup of the ephemeral rate-probe draft. A leaked draft is
      // harmless (never purchased) and reconciled by the standard cleanup sweep.
      await input.client.deleteShipment(draftId).catch(() => undefined);
    }
  }
}

/** The tracked services eligible for a refresh probe — mirrors the live
 * `allowedTrackedServices` gate: full tracked set for Canada, DDU-allowed subset
 * for the U.S. (empty when no DDU contract is configured). */
function allowedRefreshServices(
  countryCode: ShippingCountryCode,
  configured: ReadonlySet<string>,
): ReadonlySet<string> {
  if (countryCode !== "US") return configured;
  const contract = PRODUCT_SHIPPING_US_DDU_CONTRACT;
  if (contract?.importTerms !== "DDU") return new Set();
  return new Set(
    [...configured].filter((service) =>
      contract.allowedServiceCodes.includes(service),
    ),
  );
}

function buildRepresentativeRecipient(
  zoneId: ShippingZoneId,
): ShippingRecipient {
  const destination = REPRESENTATIVE_DESTINATIONS[zoneId];
  return {
    name: "Lash Her Rate Probe",
    line1: "100 Main Street",
    city: destination.city,
    province: destination.province,
    postalCode: destination.postalCode,
    country: destination.countryCode === "CA" ? "Canada" : "United States",
    countryCode: destination.countryCode,
    email: "shipping-rates@lashher.com",
    phone: "4165550100",
  };
}

function buildRepresentativePackage(
  sizeBucketId: SizeBucketId,
): ProductShipmentPackageSnapshot {
  const parcel = REPRESENTATIVE_PARCELS[sizeBucketId];
  return {
    profileId: `flat-rate-probe-${sizeBucketId}`,
    profileSlug: `flat-rate-probe-${sizeBucketId}`,
    packageType: "parcel",
    lengthCm: parcel.lengthCm,
    widthCm: parcel.widthCm,
    heightCm: parcel.heightCm,
    tareWeightGrams: 0,
    totalWeightGrams: parcel.weightGrams,
  };
}

function buildRepresentativeCustomsLines(
  sizeBucketId: SizeBucketId,
): ProductShipmentCustomsLineSnapshot[] {
  // Always supply a line, including domestic Canada: Chit Chats derives the
  // shipment `description` from these lines and rejects a blank one ("Line Item
  // 1 Description can't be blank"), even though it omits `line_items` for a
  // domestic-CA shipment. The HS code is only sent on cross-border drafts.
  const parcel = REPRESENTATIVE_PARCELS[sizeBucketId];
  return [
    {
      productId: `flat-rate-probe-${sizeBucketId}`,
      sku: `PROBE-${sizeBucketId.toUpperCase()}`,
      description: "Beauty merchandise",
      quantity: 1,
      unitValueCents: REPRESENTATIVE_MERCHANDISE_VALUE_CENTS,
      unitWeightGrams: parcel.weightGrams,
      countryOfOrigin: "CA",
      hsTariffCode: REPRESENTATIVE_HS_TARIFF_CODE,
    },
  ];
}

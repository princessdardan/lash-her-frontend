/**
 * Source-controlled product-shipping operating policy.
 *
 * This replaces the owner-attested, step-up-certified, versioned DB records
 * (fulfillment policy versions, calendar versions, service-policy reviews,
 * funding reviews, intake-location attestations) with a single committed config
 * for a solo-operator business. The separation-of-duties ceremony those records
 * enforced is meaningless when one person holds every duty; the operational
 * *values* they carried live here instead, versioned in git.
 *
 * These are OPERATIONAL inputs the runtime consumes (SLA math, rate eligibility,
 * signature/insurance gating), not compliance theatre. Legal/regulatory policy
 * is observed operationally by the owner and is not encoded here.
 *
 * VERIFY the service insurance limits and signature capability against Chit
 * Chats' current published terms before go-live. Conservative (lower) insurance
 * limits fail safe (they offer fewer rates); a too-high limit would offer an
 * under-insured service. Rates + limits change — re-verify periodically.
 */

import {
  expectedOntarioClosureDates,
  type ShippingCalendarClosure,
} from "./calendar-validation";
import type { ShippingServicePolicy } from "./policy";
import type { FulfillmentProviderCertificationContractSnapshot } from "@/lib/private-db/schema";

/** Bump when any operational value below changes (audit/debug aid only). */
export const PRODUCT_SHIPPING_POLICY_VERSION = "product-shipping-config-v1";

export interface ProductShippingSettings {
  timezone: string;
  /** "HH:MM:SS" local to `timezone`. */
  orderCutoff: string;
  coverageStartsAt: string;
  coverageEndsAt: string;
  beforeCutoffHandoffBusinessDays: number;
  afterCutoffHandoffBusinessDays: number;
  autoRefundBusinessDays: number;
  signatureThresholdCents: number;
  addressReviewThresholdCents: number;
  manualReviewAlertCoverageHours: number;
  manualReviewEscalationCoverageHours: number;
  fundingReloadThresholdCents: number;
  fundingMaximumBalanceCents: number;
  pilotStartedAt: Date | null;
  /** Freight-forwarder / reshipper address fragments that force manual review. */
  forwarderPatterns: string[];
}

/** Grounded in the migration 0033 `shipping_policy_settings` column defaults. */
export const PRODUCT_SHIPPING_SETTINGS: ProductShippingSettings = {
  timezone: "America/Toronto",
  orderCutoff: "14:00:00",
  coverageStartsAt: "09:00:00",
  coverageEndsAt: "17:00:00",
  beforeCutoffHandoffBusinessDays: 1,
  afterCutoffHandoffBusinessDays: 2,
  autoRefundBusinessDays: 2,
  signatureThresholdCents: 50_000, // CAD 500 (P-11)
  addressReviewThresholdCents: 15_000, // CAD 150 (P-07)
  manualReviewAlertCoverageHours: 2,
  manualReviewEscalationCoverageHours: 4,
  fundingReloadThresholdCents: 2_500,
  fundingMaximumBalanceCents: 50_000,
  pilotStartedAt: null,
  forwarderPatterns: [],
};

/**
 * Branch / drop-spot / mail-in-hub closures beyond the statutory Ontario
 * holidays (which are computed). Add dates the owner's intake location is
 * closed. `kind` must be "branch_closure".
 */
export const PRODUCT_SHIPPING_BRANCH_CLOSURES: ShippingCalendarClosure[] = [];

export interface ConfiguredServicePolicy {
  postageType: string;
  destinationCountryCode: "CA" | "US";
  trackingRequired: boolean;
  signatureCapable: boolean;
  insuranceLimitCents: number;
  claimWaitingDays: number;
  claimDeadlineDays: number;
}

/**
 * Rate eligibility by Chit Chats postage type + destination. `selectCustomerRates`
 * offers NO rate for a postage type/destination without a matching entry here,
 * and blocks any rate whose at-risk value exceeds `insuranceLimitCents`.
 *
 * ⚠️ Confirm `insuranceLimitCents` and `signatureCapable` against Chit Chats'
 * published coverage/eligibility for each service before enabling checkout.
 * Values below are conservative starters (CAD 100 included-coverage baseline).
 */
export const PRODUCT_SHIPPING_SERVICE_POLICIES: ConfiguredServicePolicy[] = [
  // Canada domestic
  svc("chit_chats_canada_tracked", "CA", { signatureCapable: true }),
  svc("chit_chats_select", "CA", { signatureCapable: true }),
  // United States (DDU)
  svc("chit_chats_us_edge", "US"),
  svc("chit_chats_us_connect", "US", { signatureCapable: true }),
  svc("chit_chats_us_select", "US", { signatureCapable: true }),
  svc("canada_post_tracked_packet_usa", "US"),
  svc("canada_post_expedited_parcel_usa", "US", { signatureCapable: true }),
  svc("usps_ground_advantage", "US"),
  svc("usps_priority", "US", { signatureCapable: true }),
  svc("usps_express", "US", { signatureCapable: true }),
];

function svc(
  postageType: string,
  destinationCountryCode: "CA" | "US",
  overrides: Partial<ConfiguredServicePolicy> = {},
): ConfiguredServicePolicy {
  return {
    postageType,
    destinationCountryCode,
    trackingRequired: true,
    signatureCapable: false,
    insuranceLimitCents: 10_000, // CAD 100 baseline — VERIFY per service
    claimWaitingDays: 0,
    claimDeadlineDays: 90, // Chit Chats outer claim submission window
    ...overrides,
  };
}

/**
 * Manual (studio pickup) checkout cancellation/refund policy shown to the
 * customer. Non-null enables manual checkout when `MANUAL_PRODUCT_CHECKOUT_ENABLED`
 * is on.
 *
 * ⚠️ CONFIRM the final `text` wording and `version` with the business/legal owner
 * before production. Bump `version` on any wording change (checkout re-validates
 * the accepted policy against `version` + a SHA-256 of `text`).
 */
export const PRODUCT_MANUAL_CANCELLATION_POLICY: {
  version: string;
  text: string;
} | null = {
  version: "manual-pickup-cancellation-2026-08",
  text: "Payment is received now. Pickup is arranged separately, and cancellation is approved by default before accepted irreversible customization or product preparation begins.",
};

/**
 * Certified U.S. DDU shipping contract snapshot (import terms + disclosure).
 * Non-null enables U.S. shipping when `CHITCHATS_US_SHIPPING_ENABLED` is on.
 *
 * ⚠️ CONFIRM the `disclosure.text`, the effective window, and the schema
 * `version` strings with the business/legal owner before production. Editing any
 * field invalidates in-flight U.S. quotes by design (they re-derive). SKU-level
 * `usRegulatoryCertification.*Version` values on U.S. products must match the
 * `version` / `tariffMetadataSchema.version` / `fdaRequirements.version` here.
 */
export const PRODUCT_SHIPPING_US_DDU_CONTRACT: FulfillmentProviderCertificationContractSnapshot | null =
  {
    importTerms: "DDU",
    disclosure: {
      version: "us-ddu-disclosure-2026-08",
      text: "U.S. orders ship DDU. Duties, taxes, and brokerage may be collected from the recipient on delivery.",
    },
    allowedServiceCodes: [
      "chit_chats_us_edge",
      "chit_chats_us_connect",
      "chit_chats_us_select",
      "canada_post_tracked_packet_usa",
      "canada_post_expedited_parcel_usa",
      "usps_ground_advantage",
      "usps_priority",
      "usps_express",
    ],
    trackedRequired: true,
    insuredRequired: true,
    tariffMetadataSchema: {
      version: "us-tariff-schema-2026-08",
      additionalTariffDetails: "required_when_applicable",
      fields: ["steel", "copper", "aluminum"],
    },
    fdaRequirements: {
      version: "us-fda-2026-08",
      mode: "required_when_applicable",
    },
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "2027-08-01T00:00:00.000Z",
    evidenceReference: "source-controlled-config",
    version: "us-ddu-contract-2026-08",
  };

/** Key used by `selectCustomerRates` / `getServicePolicy`. */
export function productShippingServiceKey(
  postageType: string,
  destinationCountryCode: string,
): string {
  return `${postageType}:${destinationCountryCode.toUpperCase()}`;
}

/**
 * Build the `postageType:COUNTRY` → policy map the quote path consumes. `now`
 * stamps `reviewedAt` (config is always current; there is no staleness gate).
 */
export function getProductShippingServicePolicyMap(
  now = new Date(),
): Map<string, ShippingServicePolicy> {
  return new Map(
    PRODUCT_SHIPPING_SERVICE_POLICIES.map((policy) => [
      productShippingServiceKey(
        policy.postageType,
        policy.destinationCountryCode,
      ),
      { ...policy, reviewedAt: now },
    ]),
  );
}

/**
 * Statutory Ontario holidays (computed) merged with configured branch closures,
 * covering [today, today + `monthsAhead`]. Replaces the attested calendar
 * version + its 21-month coverage requirement.
 */
export function getProductShippingClosureDates(
  now = new Date(),
  monthsAhead = 21,
): ShippingCalendarClosure[] {
  const startYear = now.getUTCFullYear();
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + monthsAhead,
      now.getUTCDate(),
    ),
  );
  const startsOn = now.toISOString().slice(0, 10);
  const endsOn = end.toISOString().slice(0, 10);

  const closures: ShippingCalendarClosure[] = [];
  const seen = new Set<string>();
  for (let year = startYear; year <= end.getUTCFullYear(); year += 1) {
    for (const date of expectedOntarioClosureDates(year)) {
      if (date < startsOn || date > endsOn || seen.has(date)) continue;
      seen.add(date);
      closures.push({
        date,
        kind: "ontario_holiday",
        label: "Ontario holiday",
      });
    }
  }
  for (const closure of PRODUCT_SHIPPING_BRANCH_CLOSURES) {
    if (
      closure.date >= startsOn &&
      closure.date <= endsOn &&
      !seen.has(closure.date)
    ) {
      seen.add(closure.date);
      closures.push(closure);
    }
  }
  return closures.sort((a, b) => a.date.localeCompare(b.date));
}

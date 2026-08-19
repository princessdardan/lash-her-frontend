/**
 * Deterministic config → ShippingQuoteContext adapter (Phase 2).
 *
 * Builds the quote context the checkout path snapshots and fingerprints, sourced
 * from the source-controlled config instead of owner-attested DB records. The
 * `ShippingQuoteContext` shape is preserved so quote-token fingerprinting,
 * snapshot parsing, and order storage are unaffected. The former attestation
 * evidence fields (admin ids, step-up timestamps, evidence hashes) no longer
 * gate anything, so they carry fixed constants; change-detection at commit is
 * done by comparing `policyVersion`/`taxPolicyVersion` to the config versions,
 * not by diffing these vestigial fields.
 *
 * Pure and dependency-injected (region + provider contracts passed in) so it is
 * unit-testable and free of server-only imports.
 */

import type { ChitChatsRegion } from "./config";
import type { ShippingQuoteContext } from "./quote-token";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  HelcimProductPaymentsCertificationContractSnapshot,
} from "@/lib/private-db/schema";
import { PRODUCT_TAX_POLICY_VERSION } from "@/lib/commerce/product-tax-policy";
import {
  PRODUCT_SHIPPING_POLICY_VERSION,
  PRODUCT_SHIPPING_SERVICE_POLICIES,
  PRODUCT_SHIPPING_SETTINGS,
  getProductShippingClosureDates,
} from "./product-shipping-config";

// Vestigial values for the removed attestation-evidence fields. They must still
// satisfy the snapshot validators (non-empty strings, valid instants, 64-hex
// hashes) but nothing validates their meaning any more.
export const CONFIG_MARKER = "source-controlled-config";
export const CONFIG_INSTANT = "2026-01-01T00:00:00.000Z";
export const CONFIG_EVIDENCE_HASH = "0".repeat(64);

/**
 * The tax-policy approval snapshot the config stands in for. The evidence fields
 * are vestigial; `version` is the real change-detector (it must equal the code's
 * PRODUCT_TAX_POLICY_VERSION, enforced at checkout).
 */
export function configuredTaxPolicyApproval(): ShippingQuoteContext["taxPolicyApproval"] {
  return {
    approvalAction: "approve_product_tax_policy",
    approvalEvidenceHash: CONFIG_EVIDENCE_HASH,
    approvalEvidenceVersion: PRODUCT_TAX_POLICY_VERSION,
    approvalStepUpAuthenticatedAt: CONFIG_INSTANT,
    approvedAt: CONFIG_INSTANT,
    approvedByAdminUserId: CONFIG_MARKER,
    coverage: {
      merchandise: true,
      shipping: true,
      supplements: true,
      usOrders: true,
      componentRefunds: true,
    },
    effectiveAt: CONFIG_INSTANT,
    evidenceReference: CONFIG_MARKER,
    ownerName: "Configured Owner",
    version: PRODUCT_TAX_POLICY_VERSION,
  };
}

export function buildConfiguredQuoteContext(input: {
  destinationCountryCode: "CA" | "US";
  region: ChitChatsRegion;
  helcimProductPaymentsContract: HelcimProductPaymentsCertificationContractSnapshot;
  usShippingContract?: FulfillmentProviderCertificationContractSnapshot | null;
  now?: Date;
}): ShippingQuoteContext {
  const now = input.now ?? new Date();
  const servicePolicies = PRODUCT_SHIPPING_SERVICE_POLICIES.filter(
    (service) =>
      service.destinationCountryCode === input.destinationCountryCode,
  )
    .map((service) => ({
      claimDeadlineDays: service.claimDeadlineDays,
      claimWaitingDays: service.claimWaitingDays,
      destinationCountryCode: service.destinationCountryCode,
      insuranceLimitCents: service.insuranceLimitCents,
      postageType: service.postageType,
      evidenceReference: CONFIG_MARKER,
      reviewAction: "approve_shipping_service_policy" as const,
      reviewEvidenceHash: CONFIG_EVIDENCE_HASH,
      reviewEvidenceVersion: PRODUCT_SHIPPING_POLICY_VERSION,
      reviewedAt: CONFIG_INSTANT,
      reviewedByAdminUserId: CONFIG_MARKER,
      reviewStepUpAuthenticatedAt: CONFIG_INSTANT,
      signatureCapable: service.signatureCapable,
      trackingRequired: service.trackingRequired,
    }))
    .sort((left, right) => left.postageType.localeCompare(right.postageType));

  return {
    helcimProductPaymentsContract: input.helcimProductPaymentsContract,
    policyVersion: PRODUCT_SHIPPING_POLICY_VERSION,
    region: input.region,
    servicePolicies,
    shippingPolicySnapshot: {
      afterCutoffHandoffBusinessDays:
        PRODUCT_SHIPPING_SETTINGS.afterCutoffHandoffBusinessDays,
      autoRefundBusinessDays: PRODUCT_SHIPPING_SETTINGS.autoRefundBusinessDays,
      beforeCutoffHandoffBusinessDays:
        PRODUCT_SHIPPING_SETTINGS.beforeCutoffHandoffBusinessDays,
      closureDates: getProductShippingClosureDates(now),
      coverageEndsAt: PRODUCT_SHIPPING_SETTINGS.coverageEndsAt,
      coverageStartsAt: PRODUCT_SHIPPING_SETTINGS.coverageStartsAt,
      orderCutoff: PRODUCT_SHIPPING_SETTINGS.orderCutoff,
      signatureThresholdCents:
        PRODUCT_SHIPPING_SETTINGS.signatureThresholdCents,
      timezone: PRODUCT_SHIPPING_SETTINGS.timezone,
    },
    taxPolicyApproval: configuredTaxPolicyApproval(),
    taxPolicyVersion: PRODUCT_TAX_POLICY_VERSION,
    usShippingContract: input.usShippingContract ?? null,
  };
}

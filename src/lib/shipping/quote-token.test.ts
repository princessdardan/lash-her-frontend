import assert from "node:assert/strict";
import test from "node:test";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  HelcimProductPaymentsCertificationContractSnapshot,
} from "@/lib/private-db/schema";
import {
  bindShippingFingerprintToContext,
  createShippingFingerprint,
  parseShippingQuoteContextSnapshot,
  type ShippingQuoteContext,
} from "./quote-token";

const usShippingContract = {
  importTerms: "DDU",
  disclosure: {
    version: "DDU-2026-08-14",
    text: "Import duties, taxes, and brokerage may be due on delivery.",
  },
  allowedServiceCodes: ["tracked_packet_usa"],
  trackedRequired: true,
  insuredRequired: true,
  tariffMetadataSchema: {
    version: "2026-08-14",
    additionalTariffDetails: "required_when_applicable",
    fields: ["steel", "copper", "aluminum"],
  },
  fdaRequirements: {
    version: "2026-08-14",
    mode: "required_when_applicable",
  },
  effectiveFrom: "2026-08-14T00:00:00.000Z",
  effectiveUntil: "2027-08-14T00:00:00.000Z",
  evidenceReference: "certification/us-ddu/2026-08-14",
  version: "provider-contract-2026-08",
} satisfies FulfillmentProviderCertificationContractSnapshot;

const helcimProductPaymentsContract = {
  contract: "helcim_product_payments",
  version: "helcim-product-payments-v1",
  evidenceReference: "certification/helcim/product-payments/v1",
  effectiveFrom: "2026-08-14T00:00:00.000Z",
  effectiveUntil: "2027-08-14T00:00:00.000Z",
  purchaseTransactionTypes: ["purchase"],
  refundTransactionTypes: ["refund"],
  purchaseSuccessfulStatuses: ["approved"],
  refundSuccessfulStatuses: ["approved"],
  avs: {
    fieldNames: ["avsResponse"],
    matchCodes: ["m"],
    mismatchCodes: ["n"],
  },
  cvv: {
    fieldNames: ["cvvResponse"],
    matchCodes: ["m"],
    mismatchCodes: ["n"],
  },
  refundCorrelation: {
    providerRefundIdFields: ["transactionId"],
    originalTransactionIdFields: ["originalTransactionId"],
    merchantReferenceFields: ["merchantReference"],
  },
} satisfies HelcimProductPaymentsCertificationContractSnapshot;

function quoteContext(
  overrides: Partial<ShippingQuoteContext> = {},
): ShippingQuoteContext {
  return {
    calendarVersionId: "33333333-3333-4333-8333-333333333333",
    fundingAttestationId: "44444444-4444-4444-8444-444444444444",
    helcimProductPaymentsContract,
    intakeLocationAttestationId: "11111111-1111-4111-8111-111111111111",
    packageProfileApprovals: [],
    policyVersion: "policy-v1",
    providerCertificationApprovals: [],
    region: "ontario_manitoba",
    servicePolicies: [],
    shippingPolicySnapshot: {
      afterCutoffHandoffBusinessDays: 2,
      autoRefundBusinessDays: 2,
      beforeCutoffHandoffBusinessDays: 1,
      closureDates: [],
      coverageEndsAt: "17:00:00",
      coverageStartsAt: "09:00:00",
      orderCutoff: "14:00:00",
      signatureThresholdCents: 50_000,
      timezone: "America/Toronto",
    },
    taxPolicyApproval: {
      approvalAction: "approve_product_tax_policy",
      approvalEvidenceHash: "c".repeat(64),
      approvalEvidenceVersion: "v1",
      approvalStepUpAuthenticatedAt: "2026-08-14T11:59:00.000Z",
      approvedAt: "2026-08-14T12:00:00.000Z",
      approvedByAdminUserId: "11111111-1111-4111-8111-111111111111",
      coverage: {
        merchandise: true,
        shipping: true,
        supplements: true,
        usOrders: true,
        componentRefunds: true,
      },
      effectiveAt: "2026-08-14T12:00:00.000Z",
      evidenceReference: "evidence/tax/v1",
      ownerName: "Test Owner",
      version: "tax-v1",
    },
    taxPolicyVersion: "tax-v1",
    usShippingContract: null,
    ...overrides,
  };
}

test("shipping fingerprint binds the U.S. DDU disclosure version", () => {
  const base = { recipient: { countryCode: "US" as const } };
  assert.notEqual(
    createShippingFingerprint(base),
    createShippingFingerprint({
      ...base,
      dduNoticeVersion: "DDU-2026-08-14",
    }),
  );
});

test("shipping fingerprint remains stable across object key order", () => {
  assert.equal(
    createShippingFingerprint({
      recipient: { postalCode: "14201", countryCode: "US" },
      dduNoticeVersion: "DDU-2026-08-14",
    }),
    createShippingFingerprint({
      dduNoticeVersion: "DDU-2026-08-14",
      recipient: { countryCode: "US", postalCode: "14201" },
    }),
  );
});

test("shipping fingerprint binds certified import terms and disclosure text", () => {
  const base = {
    recipient: { countryCode: "US" as const },
    usImportDisclosureVersion: "provider-contract-2026-08",
    usImportDisclosureText: "Certified disclosure text",
  };
  assert.notEqual(
    createShippingFingerprint({ ...base, usImportTerms: "DDU" }),
    createShippingFingerprint({
      ...base,
      usImportTerms: "DDU",
      usImportDisclosureVersion: "provider-contract-2026-09",
    }),
  );
  assert.notEqual(
    createShippingFingerprint({ ...base, usImportTerms: "DDU" }),
    createShippingFingerprint({
      ...base,
      usImportTerms: "DDU",
      usImportDisclosureText: "Changed disclosure text",
    }),
  );
});

test("shipping fingerprint binds the local intake attestation and region", () => {
  const fingerprint = createShippingFingerprint({
    recipient: { countryCode: "CA", postalCode: "M5V2T6" },
  });
  const context = quoteContext();

  assert.notEqual(
    bindShippingFingerprintToContext(fingerprint, context),
    bindShippingFingerprintToContext(fingerprint, {
      ...context,
      intakeLocationAttestationId: "22222222-2222-4222-8222-222222222222",
    }),
  );
  assert.notEqual(
    bindShippingFingerprintToContext(fingerprint, context),
    bindShippingFingerprintToContext(fingerprint, {
      ...context,
      region: "quebec",
    }),
  );
});

test("shipping fingerprint binds the certified U.S. shipping contract", () => {
  const fingerprint = createShippingFingerprint({
    recipient: { countryCode: "US", postalCode: "14201" },
  });
  const context = quoteContext({ usShippingContract });

  assert.notEqual(
    bindShippingFingerprintToContext(fingerprint, context),
    bindShippingFingerprintToContext(fingerprint, {
      ...context,
      usShippingContract: {
        ...usShippingContract,
        version: "provider-contract-2026-09",
      },
    }),
  );
});

test("shipping fingerprint binds the certified Helcim product-payment contract", () => {
  const original = bindShippingFingerprintToContext(
    "fingerprint",
    quoteContext(),
  );
  const changed = bindShippingFingerprintToContext(
    "fingerprint",
    quoteContext({
      helcimProductPaymentsContract: {
        ...helcimProductPaymentsContract,
        version: "helcim-product-payments-v2",
      },
    }),
  );
  assert.notEqual(original, changed);
});

test("quote context parsing rejects a missing or malformed Helcim contract", () => {
  const missing = { ...quoteContext() } as Record<string, unknown>;
  delete missing.helcimProductPaymentsContract;
  assert.equal(parseShippingQuoteContextSnapshot(missing), null);
  assert.equal(
    parseShippingQuoteContextSnapshot({
      ...quoteContext(),
      helcimProductPaymentsContract: {
        ...helcimProductPaymentsContract,
        purchaseTransactionTypes: ["purchase", "purchase"],
      },
    }),
    null,
  );
});

test("quote context accepts and fingerprints readiness-produced service-policy evidence", () => {
  const reviewedAt = "2026-08-14T12:00:00.000Z";
  const reviewerId = "11111111-1111-4111-8111-111111111111";
  const evidenceHash = "a".repeat(64);
  const context = quoteContext({
    packageProfileApprovals: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        reviewedAt,
        reviewedByAdminUserId: reviewerId,
        reviewStepUpAuthenticatedAt: reviewedAt,
        evidenceReference: "evidence/package/v1",
        reviewEvidenceHash: evidenceHash,
        reviewEvidenceVersion: "v1",
        reviewAction: "approve_shipping_package_profile",
      },
    ],
    servicePolicies: [
      {
        claimDeadlineDays: 30,
        claimWaitingDays: 7,
        destinationCountryCode: "CA",
        insuranceLimitCents: 10_000,
        postageType: "tracked_packet",
        reviewedAt,
        reviewedByAdminUserId: reviewerId,
        reviewStepUpAuthenticatedAt: reviewedAt,
        evidenceReference: "evidence/service/v1",
        reviewEvidenceHash: evidenceHash,
        reviewEvidenceVersion: "v1",
        reviewAction: "approve_shipping_service_policy",
        signatureCapable: true,
        trackingRequired: true,
      },
    ],
  });
  assert.notEqual(
    bindShippingFingerprintToContext("fingerprint", context),
    bindShippingFingerprintToContext("fingerprint", {
      ...context,
      packageProfileApprovals: context.packageProfileApprovals.map(
        (approval) => ({ ...approval, reviewEvidenceHash: "b".repeat(64) }),
      ),
    }),
  );
  assert.deepEqual(parseShippingQuoteContextSnapshot(context), context);
  assert.equal(
    parseShippingQuoteContextSnapshot({
      ...context,
      servicePolicies: context.servicePolicies.map((service) => ({
        ...service,
        reviewEvidenceHash: "not-a-hash",
      })),
    }),
    null,
  );
});

test("shipping fingerprint binds the full product-tax approval identity", () => {
  const context = quoteContext();
  assert.notEqual(
    bindShippingFingerprintToContext("fingerprint", context),
    bindShippingFingerprintToContext("fingerprint", {
      ...context,
      taxPolicyApproval: {
        ...context.taxPolicyApproval,
        approvalEvidenceHash: "d".repeat(64),
      },
    }),
  );
  assert.equal(
    parseShippingQuoteContextSnapshot({
      ...context,
      taxPolicyApproval: {
        ...context.taxPolicyApproval,
        coverage: { ...context.taxPolicyApproval.coverage, supplements: false },
      },
    }),
    null,
  );
});

test("shipping fingerprint binds provider certification owner evidence", () => {
  const context = quoteContext({
    providerCertificationApprovals: [
      {
        certificationAction: "certify_fulfillment_provider",
        certificationEvidenceHash: "e".repeat(64),
        certificationEvidenceVersion: "v1",
        certificationStepUpAuthenticatedAt: "2026-08-14T11:59:00.000Z",
        certifiedAt: "2026-08-14T12:00:00.000Z",
        certifiedByAdminUserId: "11111111-1111-4111-8111-111111111111",
        environment: "staging",
        evidenceReference: "evidence/helcim/v1",
        provider: "helcim",
        scope: "product_payments",
        validUntil: "2027-08-14T12:00:00.000Z",
        version: "helcim-product-payments-v1",
      },
    ],
  });
  assert.notEqual(
    bindShippingFingerprintToContext("fingerprint", context),
    bindShippingFingerprintToContext("fingerprint", {
      ...context,
      providerCertificationApprovals:
        context.providerCertificationApprovals.map((approval) => ({
          ...approval,
          certificationEvidenceHash: "f".repeat(64),
        })),
    }),
  );
});

import type { HelcimProductPaymentsCertificationContractSnapshot } from "@/lib/private-db/schema";
import { PRODUCT_MANUAL_CANCELLATION_POLICY } from "@/lib/shipping/product-shipping-config";

// Derived from the config so the fixture cannot drift from the policy text the
// checkout re-validates (version + SHA-256 of text). The policy may be null
// (manual checkout disabled); the E2E suite enables it, so the sentinel only
// guards the type.
export const COMMERCE_E2E_MANUAL_POLICY_TEXT =
  PRODUCT_MANUAL_CANCELLATION_POLICY?.text ?? "";

export const COMMERCE_E2E_HELCIM_CONTRACT = {
  contract: "helcim_product_payments",
  version: "commerce-e2e-helcim-v1",
  evidenceReference: "e2e://helcim/product-payments-v1",
  effectiveFrom: "2026-08-01T00:00:00.000Z",
  effectiveUntil: "2027-08-01T00:00:00.000Z",
  purchaseTransactionTypes: ["purchase"],
  refundTransactionTypes: ["refund"],
  purchaseSuccessfulStatuses: ["approved"],
  refundSuccessfulStatuses: ["approved"],
  avs: {
    fieldNames: ["avsResponse"],
    matchCodes: ["y"],
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
    merchantReferenceFields: ["invoiceNumber"],
  },
} satisfies HelcimProductPaymentsCertificationContractSnapshot;

export const COMMERCE_E2E_HELCIM_CONTRACT_JSON = JSON.stringify(
  COMMERCE_E2E_HELCIM_CONTRACT,
);

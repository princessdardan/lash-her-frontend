import type { HelcimProductPaymentsCertificationContractSnapshot } from "@/lib/private-db/schema";

export const COMMERCE_E2E_MANUAL_POLICY_TEXT =
  "Payment is received now. Pickup is arranged separately, and cancellation is approved by default before accepted irreversible customization or product preparation begins.";

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

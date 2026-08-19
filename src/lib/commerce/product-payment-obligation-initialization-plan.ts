export function paymentObligationInitializationProviderPhase(input: {
  providerInvoiceId: number | null;
  providerInvoiceNumber: string | null;
}): "create_invoice" | "initialize_pay" | "manual_review" {
  if (
    input.providerInvoiceId === null &&
    input.providerInvoiceNumber === null
  ) {
    return "create_invoice";
  }
  if (
    Number.isSafeInteger(input.providerInvoiceId) &&
    (input.providerInvoiceId ?? 0) > 0 &&
    typeof input.providerInvoiceNumber === "string" &&
    input.providerInvoiceNumber.trim()
  ) {
    return "initialize_pay";
  }
  return "manual_review";
}

export function paymentObligationInitializationReconciliationScope(input: {
  action: string;
  evidenceReference: string;
  expectedStateVersion: number;
  obligationId: string;
  orderId: string;
  providerEvidenceHash: string;
  providerEvidenceKind: string;
  rationale: string;
}): Record<string, unknown> {
  return {
    action: input.action,
    evidenceReference: input.evidenceReference,
    expectedStateVersion: input.expectedStateVersion,
    obligationId: input.obligationId,
    orderId: input.orderId,
    providerEvidenceHash: input.providerEvidenceHash,
    providerEvidenceKind: input.providerEvidenceKind,
    rationale: input.rationale,
  };
}

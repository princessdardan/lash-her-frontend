/** Parse a provider decimal currency value without binary-float rounding. */
export function parseProviderMoneyCents(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "number" ? String(value) : value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Invalid provider monetary amount");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("Provider monetary amount is outside the supported range");
  }
  return cents;
}

export interface ProviderSettlementInput {
  purchaseAmount?: string | number | null;
  postageFee?: string | number | null;
  insuranceFee?: string | number | null;
  deliveryFee?: string | number | null;
  tariffFee?: string | number | null;
  fdaPriorNotificationFee?: string | number | null;
  federalTax?: string | number | null;
  provincialTax?: string | number | null;
}

export interface ProviderSettlement {
  settledPurchaseCents: number | null;
  componentTotalCents: number | null;
  componentVarianceCents: number | null;
  hasCompleteComponentEvidenceWithoutSettlement: boolean;
  postageCents: number | null;
  insuranceCents: number | null;
  deliveryFeeCents: number | null;
  tariffFeeCents: number | null;
  fdaPriorNotificationFeeCents: number | null;
  federalTaxCents: number | null;
  provincialTaxCents: number | null;
}

export function parseProviderSettlement(
  input: ProviderSettlementInput,
): ProviderSettlement {
  const components = {
    postageCents: parseProviderMoneyCents(input.postageFee),
    insuranceCents: parseProviderMoneyCents(input.insuranceFee),
    deliveryFeeCents: parseProviderMoneyCents(input.deliveryFee),
    tariffFeeCents: parseProviderMoneyCents(input.tariffFee),
    fdaPriorNotificationFeeCents: parseProviderMoneyCents(
      input.fdaPriorNotificationFee,
    ),
    federalTaxCents: parseProviderMoneyCents(input.federalTax),
    provincialTaxCents: parseProviderMoneyCents(input.provincialTax),
  };
  const knownComponents = Object.values(components).filter(
    (value): value is number => value !== null,
  );
  const allComponentsKnown =
    knownComponents.length === Object.keys(components).length;
  const componentTotalCents = allComponentsKnown
    ? knownComponents.reduce((sum, value) => sum + value, 0)
    : null;
  const authoritative = parseProviderMoneyCents(input.purchaseAmount);
  return {
    // Chit Chats documents purchase_amount as the settled debit. Fee/tax
    // components are supporting accounting evidence and must never be used to
    // infer settlement when that authoritative field is absent.
    settledPurchaseCents: authoritative,
    componentTotalCents,
    componentVarianceCents:
      authoritative === null || componentTotalCents === null
        ? null
        : authoritative - componentTotalCents,
    hasCompleteComponentEvidenceWithoutSettlement:
      authoritative === null && componentTotalCents !== null,
    ...components,
  };
}

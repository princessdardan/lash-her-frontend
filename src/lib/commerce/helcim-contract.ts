export type HelcimTransactionKind = "purchase" | "refund" | "unknown";

export interface HelcimTransactionClassification {
  kind: HelcimTransactionKind;
  successful: boolean;
  normalizedStatus: string | null;
  normalizedType: string | null;
}

const DEFAULT_PURCHASE_TYPES = ["purchase"];
const DEFAULT_REFUND_TYPES = ["refund"];
const DEFAULT_SUCCESS_STATUSES = ["approved"];

export function classifyHelcimTransaction(input: {
  originalTransactionId?: string;
  status?: string;
  transactionType?: string;
}): HelcimTransactionClassification {
  const normalizedType = normalizeContractValue(input.transactionType);
  const normalizedStatus = normalizeContractValue(input.status);
  const purchaseTypes = configuredValues(
    "HELCIM_CERTIFIED_PURCHASE_TYPES",
    DEFAULT_PURCHASE_TYPES,
  );
  const refundTypes = configuredValues(
    "HELCIM_CERTIFIED_REFUND_TYPES",
    DEFAULT_REFUND_TYPES,
  );
  const successStatuses = configuredValues(
    "HELCIM_CERTIFIED_SUCCESS_STATUSES",
    DEFAULT_SUCCESS_STATUSES,
  );
  const kind =
    normalizedType && purchaseTypes.has(normalizedType)
      ? "purchase"
      : normalizedType &&
          refundTypes.has(normalizedType) &&
          Boolean(input.originalTransactionId?.trim())
        ? "refund"
        : "unknown";
  return {
    kind,
    successful: Boolean(
      kind !== "unknown" &&
      normalizedStatus &&
      successStatuses.has(normalizedStatus),
    ),
    normalizedStatus,
    normalizedType,
  };
}

export function assessCertifiedCardEvidence(input: {
  avsCode?: string;
  cvvCode?: string;
}): {
  status: "cleared" | "review_required";
  reasonCodes: string[];
  avsCode: string | null;
  cvvCode: string | null;
} {
  const avsCode = normalizeEvidenceCode(input.avsCode);
  const cvvCode = normalizeEvidenceCode(input.cvvCode);
  const avsMatches = configuredValues("HELCIM_CERTIFIED_AVS_MATCH_CODES", [
    "y",
  ]);
  const cvvMatches = configuredValues("HELCIM_CERTIFIED_CVV_MATCH_CODES", [
    "m",
  ]);
  const reasonCodes: string[] = [];
  if (!avsCode) reasonCodes.push("AVS_MISSING");
  else if (!avsMatches.has(avsCode.toLowerCase()))
    reasonCodes.push("AVS_NOT_CERTIFIED_MATCH");
  if (!cvvCode) reasonCodes.push("CVV_MISSING");
  else if (!cvvMatches.has(cvvCode.toLowerCase()))
    reasonCodes.push("CVV_NOT_CERTIFIED_MATCH");
  return {
    status: reasonCodes.length === 0 ? "cleared" : "review_required",
    reasonCodes,
    avsCode,
    cvvCode,
  };
}

function configuredValues(name: string, defaults: string[]): Set<string> {
  const configured = process.env[name]
    ?.split(",")
    .map(normalizeContractValue)
    .filter((value): value is string => Boolean(value));
  return new Set(configured?.length ? configured : defaults);
}

function normalizeContractValue(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function normalizeEvidenceCode(value: string | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z0-9_-]{1,32}$/.test(normalized)
    ? normalized
    : null;
}

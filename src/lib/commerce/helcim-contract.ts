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
  const purchaseSuccessStatuses = configuredValues(
    "HELCIM_CERTIFIED_PURCHASE_SUCCESS_STATUSES",
    DEFAULT_SUCCESS_STATUSES,
  );
  const refundSuccessStatuses = configuredValues(
    "HELCIM_CERTIFIED_REFUND_SUCCESS_STATUSES",
    DEFAULT_SUCCESS_STATUSES,
  );
  const hasOriginalTransaction = Boolean(input.originalTransactionId?.trim());
  const kind =
    normalizedType &&
    purchaseTypes.has(normalizedType) &&
    !hasOriginalTransaction
      ? "purchase"
      : normalizedType &&
          refundTypes.has(normalizedType) &&
          hasOriginalTransaction
        ? "refund"
        : "unknown";
  return {
    kind,
    successful: Boolean(
      kind !== "unknown" &&
      normalizedStatus &&
      (kind === "purchase"
        ? purchaseSuccessStatuses
        : refundSuccessStatuses
      ).has(normalizedStatus),
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

export function assessCertifiedOwnerReviewEvidence(input: {
  avsCode?: string;
  cvvCode?: string;
}): {
  available: boolean;
  avsCode: string | null;
  cvvCode: string | null;
  reasonCodes: string[];
} {
  const assessment = assessCertifiedCardEvidence(input);
  if (assessment.status === "cleared") {
    return { available: true, ...assessment };
  }
  const avsMismatches = configuredValues(
    "HELCIM_CERTIFIED_AVS_MISMATCH_CODES",
    [],
  );
  const cvvMismatches = configuredValues(
    "HELCIM_CERTIFIED_CVV_MISMATCH_CODES",
    [],
  );
  const avsAvailable = Boolean(
    assessment.avsCode &&
    (configuredValues("HELCIM_CERTIFIED_AVS_MATCH_CODES", ["y"]).has(
      assessment.avsCode.toLowerCase(),
    ) ||
      avsMismatches.has(assessment.avsCode.toLowerCase())),
  );
  const cvvAvailable = Boolean(
    assessment.cvvCode &&
    (configuredValues("HELCIM_CERTIFIED_CVV_MATCH_CODES", ["m"]).has(
      assessment.cvvCode.toLowerCase(),
    ) ||
      cvvMismatches.has(assessment.cvvCode.toLowerCase())),
  );
  return { available: avsAvailable && cvvAvailable, ...assessment };
}

function configuredValues(name: string, defaults: string[]): Set<string> {
  const contract = getConfiguredHelcimProductPaymentsContract();
  if (contract && helcimContractIsEffective(contract)) {
    const values = {
      HELCIM_CERTIFIED_PURCHASE_TYPES: contract.purchaseTransactionTypes,
      HELCIM_CERTIFIED_REFUND_TYPES: contract.refundTransactionTypes,
      HELCIM_CERTIFIED_PURCHASE_SUCCESS_STATUSES:
        contract.purchaseSuccessfulStatuses,
      HELCIM_CERTIFIED_REFUND_SUCCESS_STATUSES:
        contract.refundSuccessfulStatuses,
      HELCIM_CERTIFIED_AVS_MATCH_CODES: contract.avs.matchCodes,
      HELCIM_CERTIFIED_CVV_MATCH_CODES: contract.cvv.matchCodes,
      HELCIM_CERTIFIED_AVS_MISMATCH_CODES: contract.avs.mismatchCodes,
      HELCIM_CERTIFIED_CVV_MISMATCH_CODES: contract.cvv.mismatchCodes,
    }[name];
    return new Set(values ?? []);
  }
  if (
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.NODE_ENV === "production"
  ) {
    return new Set();
  }
  return new Set(defaults);
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
import {
  getConfiguredHelcimProductPaymentsContract,
  helcimContractIsEffective,
} from "./helcim-certified-contract";

import { createHash } from "node:crypto";
import type { HelcimProductPaymentsCertificationContractSnapshot } from "@/lib/private-db/schema";

export function getConfiguredHelcimProductPaymentsContract(): HelcimProductPaymentsCertificationContractSnapshot | null {
  const raw = process.env.HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON?.trim();
  if (!raw) return null;
  try {
    return parseHelcimProductPaymentsContract(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function requireConfiguredHelcimProductPaymentsContract(): HelcimProductPaymentsCertificationContractSnapshot {
  const contract = getConfiguredHelcimProductPaymentsContract();
  if (!contract) {
    throw new Error(
      "HELCIM_PRODUCT_PAYMENTS_CONTRACT_JSON must contain the certified Helcim contract",
    );
  }
  return contract;
}

export function parseHelcimProductPaymentsContract(
  value: unknown,
): HelcimProductPaymentsCertificationContractSnapshot | null {
  if (!isRecord(value) || value.contract !== "helcim_product_payments") {
    return null;
  }
  const avs = parseEvidenceVocabulary(value.avs);
  const cvv = parseEvidenceVocabulary(value.cvv);
  const refundCorrelation = isRecord(value.refundCorrelation)
    ? {
        providerRefundIdFields: stringArray(
          value.refundCorrelation.providerRefundIdFields,
          false,
        ),
        originalTransactionIdFields: stringArray(
          value.refundCorrelation.originalTransactionIdFields,
          false,
        ),
        merchantReferenceFields: stringArray(
          value.refundCorrelation.merchantReferenceFields,
          false,
        ),
      }
    : null;
  const parsed = {
    contract: value.contract,
    version: clean(value.version),
    evidenceReference: clean(value.evidenceReference),
    effectiveFrom: clean(value.effectiveFrom),
    effectiveUntil: clean(value.effectiveUntil),
    purchaseTransactionTypes: stringArray(value.purchaseTransactionTypes),
    refundTransactionTypes: stringArray(value.refundTransactionTypes),
    purchaseSuccessfulStatuses: stringArray(value.purchaseSuccessfulStatuses),
    refundSuccessfulStatuses: stringArray(value.refundSuccessfulStatuses),
    avs,
    cvv,
    refundCorrelation,
  };
  if (
    !parsed.version ||
    !parsed.evidenceReference ||
    !validWindow(parsed.effectiveFrom, parsed.effectiveUntil) ||
    !parsed.purchaseTransactionTypes.length ||
    !parsed.refundTransactionTypes.length ||
    !parsed.purchaseSuccessfulStatuses.length ||
    !parsed.refundSuccessfulStatuses.length ||
    !parsed.avs ||
    !parsed.cvv ||
    !parsed.refundCorrelation ||
    !parsed.refundCorrelation.providerRefundIdFields.length ||
    !parsed.refundCorrelation.originalTransactionIdFields.length ||
    !parsed.refundCorrelation.merchantReferenceFields.length ||
    overlaps(parsed.purchaseTransactionTypes, parsed.refundTransactionTypes) ||
    overlaps(parsed.avs.matchCodes, parsed.avs.mismatchCodes) ||
    overlaps(parsed.cvv.matchCodes, parsed.cvv.mismatchCodes)
  ) {
    return null;
  }
  return parsed as HelcimProductPaymentsCertificationContractSnapshot;
}

export function helcimContractIsEffective(
  contract: HelcimProductPaymentsCertificationContractSnapshot,
  now = new Date(),
): boolean {
  return (
    new Date(contract.effectiveFrom) <= now &&
    new Date(contract.effectiveUntil) > now
  );
}

export function readCertifiedHelcimEvidenceField(
  value: Record<string, unknown>,
  kind: "avs" | "cvv",
): string | undefined {
  const contract = getConfiguredHelcimProductPaymentsContract();
  const fields =
    contract && helcimContractIsEffective(contract)
      ? contract[kind].fieldNames
      : isLaunchEnvironment()
        ? []
        : kind === "avs"
          ? ["avsResponse", "avsResult", "avs"]
          : ["cvvResponse", "cvvResult", "cvv"];
  return readExactField(value, fields);
}

export function readCertifiedHelcimRefundCorrelationField(
  value: Record<string, unknown>,
  kind:
    | "providerRefundIdFields"
    | "originalTransactionIdFields"
    | "merchantReferenceFields",
): string | undefined {
  const contract = getConfiguredHelcimProductPaymentsContract();
  const fields =
    contract && helcimContractIsEffective(contract)
      ? contract.refundCorrelation[kind]
      : isLaunchEnvironment()
        ? []
        : {
            providerRefundIdFields: ["transactionId", "id"],
            originalTransactionIdFields: [
              "originalTransactionId",
              "originalCardTransactionId",
            ],
            merchantReferenceFields: ["merchantReference", "idempotencyKey"],
          }[kind];
  return readExactField(value, fields);
}

export function getHelcimContractIdentitySnapshot(now = new Date()): {
  version: string;
  evidenceReference: string;
  effectiveFrom: string;
  effectiveUntil: string;
  contractHash: string;
} | null {
  const contract = getConfiguredHelcimProductPaymentsContract();
  if (!contract || !helcimContractIsEffective(contract, now)) return null;
  return {
    version: contract.version,
    evidenceReference: contract.evidenceReference,
    effectiveFrom: contract.effectiveFrom,
    effectiveUntil: contract.effectiveUntil,
    contractHash: createHash("sha256")
      .update(stableJson(contract), "utf8")
      .digest("hex"),
  };
}

export function paymentObligationMatchesConfiguredHelcimContract(
  disclosure: Record<string, unknown> | null,
): boolean {
  const expected = getHelcimContractIdentitySnapshot();
  if (!expected) return !isLaunchEnvironment();
  if (!disclosure || !isRecord(disclosure.helcimContract)) {
    return !isLaunchEnvironment();
  }
  return stableJson(disclosure.helcimContract) === stableJson(expected);
}

function parseEvidenceVocabulary(value: unknown) {
  if (!isRecord(value)) return null;
  const parsed = {
    fieldNames: stringArray(value.fieldNames, false),
    matchCodes: stringArray(value.matchCodes),
    mismatchCodes: stringArray(value.mismatchCodes),
  };
  return parsed.fieldNames.length &&
    parsed.matchCodes.length &&
    parsed.mismatchCodes.length
    ? parsed
    : null;
}

function stringArray(value: unknown, normalize = true): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((entry) => {
      const cleaned = clean(entry) ?? "";
      return normalize ? cleaned.toLowerCase() : cleaned;
    })
    .filter(Boolean);
  return normalized.length === new Set(normalized).size ? normalized : [];
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function overlaps(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function validWindow(from: string | null, until: string | null): boolean {
  if (!from || !until) return false;
  const start = new Date(from);
  const end = new Date(until);
  return (
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    end > start
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readExactField(
  value: Record<string, unknown>,
  paths: string[],
): string | undefined {
  for (const path of paths) {
    const segments = path.split(".");
    if (segments.some((segment) => !segment)) continue;
    let entry: unknown = value;
    for (const segment of segments) {
      if (!isRecord(entry) || !Object.hasOwn(entry, segment)) {
        entry = undefined;
        break;
      }
      entry = entry[segment];
    }
    if (
      (typeof entry === "string" || typeof entry === "number") &&
      String(entry).trim()
    ) {
      return String(entry).trim();
    }
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, JSON.parse(stableJson(nested))]),
    ),
  );
}

function isLaunchEnvironment(): boolean {
  return (
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.NODE_ENV === "production"
  );
}

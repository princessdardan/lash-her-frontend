import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";
import { parseHelcimProductPaymentsContract } from "@/lib/commerce/helcim-certified-contract";
import type {
  FulfillmentProviderCertificationContractSnapshot,
  HelcimProductPaymentsCertificationContractSnapshot,
} from "@/lib/private-db/schema";
import { getChitChatsConfig, type ChitChatsRegion } from "./config";

export interface ShippingQuoteContext {
  calendarVersionId: string;
  fundingAttestationId: string;
  helcimProductPaymentsContract: HelcimProductPaymentsCertificationContractSnapshot;
  intakeLocationAttestationId: string;
  packageProfileApprovals: Array<{
    evidenceReference: string;
    id: string;
    reviewAction: "approve_shipping_package_profile";
    reviewEvidenceHash: string;
    reviewEvidenceVersion: string;
    reviewedAt: string;
    reviewedByAdminUserId: string;
    reviewStepUpAuthenticatedAt: string;
  }>;
  policyVersion: string;
  providerCertificationApprovals: Array<{
    certificationAction: "certify_fulfillment_provider";
    certificationEvidenceHash: string;
    certificationEvidenceVersion: string;
    certificationStepUpAuthenticatedAt: string;
    certifiedAt: string;
    certifiedByAdminUserId: string;
    environment: string;
    evidenceReference: string;
    provider: string;
    scope: string;
    validUntil: string;
    version: string;
  }>;
  region: ChitChatsRegion;
  servicePolicies: Array<{
    claimDeadlineDays: number;
    claimWaitingDays: number;
    destinationCountryCode: "CA" | "US";
    insuranceLimitCents: number;
    postageType: string;
    evidenceReference: string;
    reviewAction: "approve_shipping_service_policy";
    reviewEvidenceHash: string;
    reviewEvidenceVersion: string;
    reviewedAt: string;
    reviewedByAdminUserId: string;
    reviewStepUpAuthenticatedAt: string;
    signatureCapable: boolean;
    trackingRequired: boolean;
  }>;
  shippingPolicySnapshot: {
    afterCutoffHandoffBusinessDays: number;
    autoRefundBusinessDays: number;
    beforeCutoffHandoffBusinessDays: number;
    closureDates: Array<{ date: string; kind: string; label: string }>;
    coverageEndsAt: string;
    coverageStartsAt: string;
    orderCutoff: string;
    signatureThresholdCents: number;
    timezone: string;
  };
  taxPolicyApproval: {
    approvalAction: "approve_product_tax_policy";
    approvalEvidenceHash: string;
    approvalEvidenceVersion: string;
    approvalStepUpAuthenticatedAt: string;
    approvedAt: string;
    approvedByAdminUserId: string;
    coverage: Record<string, boolean>;
    effectiveAt: string;
    evidenceReference: string;
    ownerName: string;
    version: string;
  };
  taxPolicyVersion: string;
  usShippingContract: FulfillmentProviderCertificationContractSnapshot | null;
}

export function issueShippingQuoteToken(scope?: string): string {
  if (scope?.trim()) {
    return createHmac("sha256", getChitChatsConfig().quoteSigningSecret)
      .update(`shipping-quote-token:v2:${scope}`, "utf8")
      .digest("base64url");
  }
  return randomBytes(32).toString("base64url");
}

export function hashShippingQuoteToken(token: string): string {
  return createHmac("sha256", getChitChatsConfig().quoteSigningSecret)
    .update(token, "utf8")
    .digest("hex");
}

export type UsImportTerms = "DDU";

export interface CertifiedUsImportDisclosure {
  usImportTerms: UsImportTerms;
  usImportDisclosureVersion: string;
  usImportDisclosureText: string;
}

export function createShippingFingerprint<T extends object>(
  value: T &
    Partial<CertifiedUsImportDisclosure> & {
      dduNoticeVersion?: string;
    },
): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

export function bindShippingFingerprintToContext(
  fingerprint: string,
  context: ShippingQuoteContext,
): string {
  return createShippingFingerprint({
    fingerprint,
    calendarVersionId: context.calendarVersionId,
    fundingAttestationId: context.fundingAttestationId,
    helcimProductPaymentsContract: context.helcimProductPaymentsContract,
    intakeLocationAttestationId: context.intakeLocationAttestationId,
    packageProfileApprovals: context.packageProfileApprovals,
    policyVersion: context.policyVersion,
    providerCertificationApprovals: context.providerCertificationApprovals,
    region: context.region,
    servicePolicies: context.servicePolicies,
    shippingPolicySnapshot: context.shippingPolicySnapshot,
    taxPolicyApproval: context.taxPolicyApproval,
    taxPolicyVersion: context.taxPolicyVersion,
    usShippingContract: context.usShippingContract,
  });
}

export function shippingQuoteContextsEqual(
  left: ShippingQuoteContext,
  right: ShippingQuoteContext,
): boolean {
  return stableJson(left) === stableJson(right);
}

export function parseShippingQuoteContextSnapshot(
  value: unknown,
): ShippingQuoteContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Record<string, unknown>;
  const snapshot = context.shippingPolicySnapshot;
  if (
    !isNonEmptyString(context.calendarVersionId) ||
    !isNonEmptyString(context.fundingAttestationId) ||
    !parseHelcimProductPaymentsContract(
      context.helcimProductPaymentsContract,
    ) ||
    !isNonEmptyString(context.intakeLocationAttestationId) ||
    !Array.isArray(context.packageProfileApprovals) ||
    !context.packageProfileApprovals.every(isPackageProfileApprovalSnapshot) ||
    !isNonEmptyString(context.policyVersion) ||
    !Array.isArray(context.providerCertificationApprovals) ||
    !context.providerCertificationApprovals.every(
      isProviderCertificationApprovalSnapshot,
    ) ||
    !isNonEmptyString(context.taxPolicyVersion) ||
    !isTaxPolicyApprovalSnapshot(context.taxPolicyApproval) ||
    !isRegion(context.region) ||
    !Array.isArray(context.servicePolicies) ||
    !context.servicePolicies.every(isServicePolicySnapshot) ||
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    return null;
  const policy = snapshot as Record<string, unknown>;
  if (
    !isNonEmptyString(policy.timezone) ||
    !isNonEmptyString(policy.orderCutoff) ||
    !isNonEmptyString(policy.coverageStartsAt) ||
    !isNonEmptyString(policy.coverageEndsAt) ||
    !isPositiveInteger(policy.beforeCutoffHandoffBusinessDays) ||
    !isPositiveInteger(policy.afterCutoffHandoffBusinessDays) ||
    !isPositiveInteger(policy.autoRefundBusinessDays) ||
    !isPositiveInteger(policy.signatureThresholdCents) ||
    !Array.isArray(policy.closureDates) ||
    !policy.closureDates.every(isClosureDate)
  )
    return null;
  return value as ShippingQuoteContext;
}

function isServicePolicySnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.postageType) &&
    isNonEmptyString(row.evidenceReference) &&
    row.reviewAction === "approve_shipping_service_policy" &&
    isEvidenceHash(row.reviewEvidenceHash) &&
    isNonEmptyString(row.reviewEvidenceVersion) &&
    isNonEmptyString(row.reviewedByAdminUserId) &&
    isInstant(row.reviewStepUpAuthenticatedAt) &&
    (row.destinationCountryCode === "CA" ||
      row.destinationCountryCode === "US") &&
    typeof row.trackingRequired === "boolean" &&
    isPositiveInteger(row.insuranceLimitCents) &&
    typeof row.signatureCapable === "boolean" &&
    Number.isInteger(row.claimWaitingDays) &&
    Number(row.claimWaitingDays) >= 0 &&
    isPositiveInteger(row.claimDeadlineDays) &&
    isInstant(row.reviewedAt)
  );
}

function isPackageProfileApprovalSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.id) &&
    isNonEmptyString(row.evidenceReference) &&
    row.reviewAction === "approve_shipping_package_profile" &&
    isEvidenceHash(row.reviewEvidenceHash) &&
    isNonEmptyString(row.reviewEvidenceVersion) &&
    isInstant(row.reviewedAt) &&
    isNonEmptyString(row.reviewedByAdminUserId) &&
    isInstant(row.reviewStepUpAuthenticatedAt)
  );
}

function isTaxPolicyApprovalSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const coverage = row.coverage;
  return (
    isNonEmptyString(row.version) &&
    isNonEmptyString(row.approvedByAdminUserId) &&
    isInstant(row.approvalStepUpAuthenticatedAt) &&
    isInstant(row.approvedAt) &&
    isInstant(row.effectiveAt) &&
    isNonEmptyString(row.evidenceReference) &&
    isEvidenceHash(row.approvalEvidenceHash) &&
    isNonEmptyString(row.approvalEvidenceVersion) &&
    row.approvalAction === "approve_product_tax_policy" &&
    Boolean(coverage) &&
    typeof coverage === "object" &&
    !Array.isArray(coverage) &&
    [
      "merchandise",
      "shipping",
      "supplements",
      "usOrders",
      "componentRefunds",
    ].every((key) => (coverage as Record<string, unknown>)[key] === true)
  );
}

function isProviderCertificationApprovalSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.provider) &&
    isNonEmptyString(row.environment) &&
    isNonEmptyString(row.scope) &&
    isNonEmptyString(row.version) &&
    isNonEmptyString(row.evidenceReference) &&
    isNonEmptyString(row.certifiedByAdminUserId) &&
    isInstant(row.certificationStepUpAuthenticatedAt) &&
    isInstant(row.certifiedAt) &&
    isInstant(row.validUntil) &&
    isEvidenceHash(row.certificationEvidenceHash) &&
    isNonEmptyString(row.certificationEvidenceVersion) &&
    row.certificationAction === "certify_fulfillment_provider"
  );
}

function isEvidenceHash(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isInstant(value: unknown): boolean {
  return isNonEmptyString(value) && Number.isFinite(new Date(value).getTime());
}

function isClosureDate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    isNonEmptyString(row.date) &&
    isNonEmptyString(row.kind) &&
    isNonEmptyString(row.label)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isRegion(value: unknown): value is ChitChatsRegion {
  return [
    "british_columbia",
    "alberta_saskatchewan",
    "ontario_manitoba",
    "quebec",
    "atlantic",
  ].includes(String(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

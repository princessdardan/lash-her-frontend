import { createHash } from "node:crypto";

export function addressSignatureDecisionTerms(input: {
  requestId: string;
  sourceShipmentId: string;
}) {
  return {
    scopeKey: `address-change/${input.requestId}/shipment/${input.sourceShipmentId}/signature`,
    proposedConditions: {
      requestId: input.requestId,
      sourceShipmentId: input.sourceShipmentId,
      signatureRequired: true,
    },
  };
}

export function addressServiceSubstitutionDecisionTerms(input: {
  requestId: string;
  sourceShipmentId: string;
  originalPostageType: string | null;
  substitutePostageType: string;
  substituteAmountCents: number;
}) {
  return {
    scopeKey: `address-change/${input.requestId}/shipment/${input.sourceShipmentId}/service-substitution`,
    proposedConditions: { ...input },
  };
}

export function lossDamageRemedyDecisionTerms(input: {
  caseId: string;
  remedyDeadlineAt: Date;
}) {
  return {
    scopeKey: `loss_damage_remedy/${input.caseId}/${input.remedyDeadlineAt.toISOString()}`,
    proposedConditions: {
      caseId: input.caseId,
      remedyDeadlineAt: input.remedyDeadlineAt.toISOString(),
      allowedRemedies: ["refund", "replacement"],
    },
  };
}

export function hashCustomerDecisionConditions(
  scopeKey: string,
  proposedConditions: Record<string, unknown> | null,
): string {
  return createHash("sha256")
    .update(`${scopeKey}\n${stableJson(proposedConditions)}`)
    .digest("hex");
}

export function stableCustomerDecisionJson(value: unknown): string {
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return JSON.stringify(value ?? null);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, JSON.parse(stableJson(nested))]),
    ),
  );
}

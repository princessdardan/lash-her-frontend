import "server-only";

import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";

export interface AddressApprovalPayload {
  action: "address_approval" | "fraud_clearance" | "record_phone_callback";
  callbackEvidenceReference: string;
  expectedStateVersion: number;
  rationale: string;
  responsibility?: "customer" | "lash_her";
}

export function addressApprovalStepUpScope(
  requestId: string,
  payload: AddressApprovalPayload,
): { action: string; target: string; targetLabel: string } {
  return {
    action: `address:${payload.action}`,
    target: createAdminStepUpTarget({
      action: payload.action,
      callbackEvidenceReference: payload.callbackEvidenceReference,
      expectedStateVersion: payload.expectedStateVersion,
      rationale: payload.rationale,
      requestId,
      responsibility: payload.responsibility ?? null,
    }),
    targetLabel: `Address request ${requestId}: ${payload.action.replaceAll("_", " ")}`,
  };
}

export function addressRevocationStepUpScope(input: {
  evidenceReference: string;
  expectedStateVersion: number;
  orderReference: string;
  rationale: string;
  requestId: string;
}): { action: string; target: string; targetLabel: string } {
  return {
    action: "address:revoke",
    target: createAdminStepUpTarget({ action: "revoke", ...input }),
    targetLabel: `Revoke address request ${input.requestId}`,
  };
}

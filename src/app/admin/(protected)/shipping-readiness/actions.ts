import "server-only";

import { createAdminStepUpTarget } from "@/lib/admin/step-up-proof";
import {
  attestChitChatsIntakeLocation,
  CHITCHATS_INTAKE_ATTESTATION_STATEMENT,
  CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
  revokeChitChatsIntakeLocation,
  type ChitChatsIntakeLocationType,
} from "@/lib/shipping/intake-location";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type IntakeLocationMutationPayload =
  | {
      action: "attest";
      evidenceReference: string;
      expectedCurrentAttestationId: string | null;
      locationAddress: string;
      locationName: string;
      locationType: ChitChatsIntakeLocationType;
      rationale: string;
      statementConfirmed: true;
      statementVersion: string;
    }
  | {
      action: "revoke";
      expectedCurrentAttestationId: string;
      expectedCurrentPolicyVersion: string;
      reason: string;
    };

export interface IntakeLocationStepUpScope {
  action: "intake_location:attest" | "intake_location:revoke";
  target: string;
  targetLabel: string;
}

export function parseIntakeLocationMutationPayload(
  body: Record<string, unknown> | null,
): IntakeLocationMutationPayload {
  if (!body) throw new Error("The intake-location request is invalid");
  if (body.action === "attest") {
    const statementVersion = requiredString(
      body.statementVersion,
      "Statement version",
      160,
    );
    if (statementVersion !== CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION) {
      throw new Error(
        "The attestation statement changed; refresh and review it again",
      );
    }
    if (body.statementConfirmed !== true) {
      throw new Error("The intake-location attestation statement is required");
    }
    return {
      action: "attest",
      evidenceReference: requiredString(
        body.evidenceReference,
        "Evidence reference",
        500,
      ),
      expectedCurrentAttestationId: optionalUuid(
        body.expectedCurrentAttestationId,
      ),
      locationAddress: requiredString(
        body.locationAddress,
        "Location address",
        500,
      ),
      locationName: requiredString(body.locationName, "Location name", 160),
      locationType: locationType(body.locationType),
      rationale: requiredString(body.rationale, "Rationale", 1_000, 10),
      statementConfirmed: true,
      statementVersion,
    };
  }
  if (body.action === "revoke") {
    return {
      action: "revoke",
      expectedCurrentAttestationId: requiredUuid(
        body.expectedCurrentAttestationId,
      ),
      expectedCurrentPolicyVersion: requiredString(
        body.expectedCurrentPolicyVersion,
        "Current policy version",
        160,
      ),
      reason: requiredString(body.reason, "Revocation reason", 1_000, 10),
    };
  }
  throw new Error("The intake-location action is invalid");
}

export function intakeLocationStepUpScope(
  payload: IntakeLocationMutationPayload,
): IntakeLocationStepUpScope {
  if (payload.action === "attest") {
    return {
      action: "intake_location:attest",
      target: createAdminStepUpTarget({
        action: payload.action,
        evidenceReference: payload.evidenceReference,
        expectedCurrentAttestationId: payload.expectedCurrentAttestationId,
        locationAddress: payload.locationAddress,
        locationName: payload.locationName,
        locationType: payload.locationType,
        rationale: payload.rationale,
        statement: CHITCHATS_INTAKE_ATTESTATION_STATEMENT,
        statementConfirmed: payload.statementConfirmed,
        statementVersion: payload.statementVersion,
      }),
      targetLabel: `Chit Chats intake location: ${payload.locationName}`,
    };
  }
  return {
    action: "intake_location:revoke",
    target: createAdminStepUpTarget({
      action: payload.action,
      expectedCurrentAttestationId: payload.expectedCurrentAttestationId,
      expectedCurrentPolicyVersion: payload.expectedCurrentPolicyVersion,
      reason: payload.reason,
    }),
    targetLabel: `Revoke Chit Chats intake location: ${payload.expectedCurrentAttestationId}`,
  };
}

export async function executeIntakeLocationMutation(input: {
  actorAdminUserId: string;
  payload: IntakeLocationMutationPayload;
  stepUpAuthenticatedAt: Date;
}): Promise<{ id: string }> {
  if (input.payload.action === "attest") {
    const record = await attestChitChatsIntakeLocation({
      actorAdminUserId: input.actorAdminUserId,
      evidenceReference: input.payload.evidenceReference,
      expectedCurrentAttestationId: input.payload.expectedCurrentAttestationId,
      locationAddress: input.payload.locationAddress,
      locationName: input.payload.locationName,
      locationType: input.payload.locationType,
      rationale: input.payload.rationale,
      statementConfirmed: input.payload.statementConfirmed,
      stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
    });
    return { id: record.id };
  }
  const record = await revokeChitChatsIntakeLocation({
    actorAdminUserId: input.actorAdminUserId,
    expectedCurrentAttestationId: input.payload.expectedCurrentAttestationId,
    expectedCurrentPolicyVersion: input.payload.expectedCurrentPolicyVersion,
    reason: input.payload.reason,
    stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
  });
  return { id: record.id };
}

function locationType(value: unknown): ChitChatsIntakeLocationType {
  if (value !== "branch" && value !== "drop_spot" && value !== "mail_in_hub") {
    throw new Error("Select a valid Chit Chats intake-location type");
  }
  return value;
}

function optionalUuid(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("The intake-location version is invalid; refresh the page");
  }
  return value;
}

function requiredUuid(value: unknown): string {
  const id = optionalUuid(value);
  if (!id) {
    throw new Error("The intake-location record is missing; refresh the page");
  }
  return id;
}

function requiredString(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 1,
): string {
  if (typeof value !== "string" || value.trim().length < minimum) {
    throw new Error(`${label} must contain at least ${minimum} characters`);
  }
  if (value.trim().length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} characters`);
  }
  return value;
}

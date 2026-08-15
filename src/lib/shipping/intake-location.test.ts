import assert from "node:assert/strict";
import test from "node:test";

import {
  CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
  intakeLocationRecordMatchesConfiguration,
  normalizeChitChatsIntakeLocationAttestation,
  type ChitChatsIntakeLocationReadinessRecord,
} from "./intake-location";

const now = new Date("2026-08-15T16:00:00.000Z");

test("normalizes a complete, explicitly confirmed intake-location attestation", () => {
  const result = normalizeChitChatsIntakeLocationAttestation(
    {
      evidenceReference: "  ops-evidence/chitchats-burlington-2026-08  ",
      locationAddress: "  123 Intake Street, Burlington, ON  ",
      locationName: "  Chit Chats Burlington  ",
      locationType: "branch",
      rationale: "  This is the documented first processing location.  ",
      statementConfirmed: true,
      stepUpAuthenticatedAt: new Date("2026-08-15T15:58:00.000Z"),
    },
    now,
  );

  assert.equal(result.locationName, "Chit Chats Burlington");
  assert.equal(result.locationAddress, "123 Intake Street, Burlington, ON");
  assert.equal(
    result.evidenceReference,
    "ops-evidence/chitchats-burlington-2026-08",
  );
  assert.equal(
    result.statementVersion,
    CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
  );
});

test("rejects an unconfirmed statement and stale step-up authentication", () => {
  const base = {
    evidenceReference: "evidence/reference",
    locationAddress: "123 Intake Street, Burlington, ON",
    locationName: "Chit Chats Burlington",
    locationType: "branch" as const,
    rationale: "This location was verified against provider evidence.",
    statementConfirmed: true,
    stepUpAuthenticatedAt: new Date("2026-08-15T15:58:00.000Z"),
  };

  assert.throws(
    () =>
      normalizeChitChatsIntakeLocationAttestation(
        { ...base, statementConfirmed: false },
        now,
      ),
    /attestation statement is required/,
  );
  assert.throws(
    () =>
      normalizeChitChatsIntakeLocationAttestation(
        {
          ...base,
          stepUpAuthenticatedAt: new Date("2026-08-15T15:54:59.999Z"),
        },
        now,
      ),
    /Recent step-up authentication is required/,
  );
});

test("readiness requires an exact environment, account, region, policy, owner, and validity match", () => {
  const record: ChitChatsIntakeLocationReadinessRecord = {
    attestedAt: new Date("2026-08-15T15:55:00.000Z"),
    attestedByAdminUserId: "owner-1",
    attestedByOwnerName: "Nataliea Lavoie",
    evidenceReference: "ops-evidence/chitchats-burlington-2026-08",
    id: "attestation-1",
    locationAddress: "123 Intake Street, Burlington, ON",
    locationName: "Chit Chats Burlington",
    locationType: "branch",
    policyVersion: "2026-08-14-owner-operated",
    providerClientId: "123456",
    providerEnvironment: "staging",
    region: "ontario_manitoba",
    revokedAt: null,
    statementVersion: CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
    validUntil: new Date("2026-11-13T15:55:00.000Z"),
  };
  const base = {
    configuredOwnerId: "owner-1",
    effectivePolicyVersion: "2026-08-14-owner-operated",
    identity: {
      clientId: "123456",
      environment: "staging" as const,
      region: "ontario_manitoba" as const,
    },
    now,
    record,
  };

  assert.equal(intakeLocationRecordMatchesConfiguration(base), true);
  assert.equal(
    intakeLocationRecordMatchesConfiguration({
      ...base,
      identity: { ...base.identity, clientId: "654321" },
    }),
    false,
  );
  assert.equal(
    intakeLocationRecordMatchesConfiguration({
      ...base,
      identity: { ...base.identity, region: "quebec" },
    }),
    false,
  );
  assert.equal(
    intakeLocationRecordMatchesConfiguration({
      ...base,
      effectivePolicyVersion: "new-policy",
    }),
    false,
  );
  assert.equal(
    intakeLocationRecordMatchesConfiguration({
      ...base,
      configuredOwnerId: "owner-2",
    }),
    false,
  );
  assert.equal(
    intakeLocationRecordMatchesConfiguration({
      ...base,
      now: record.validUntil,
    }),
    false,
  );
});

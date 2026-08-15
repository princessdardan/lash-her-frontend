import "server-only";

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { getPrivateDb } from "@/lib/private-db/client";
import {
  adminAuditLogs,
  chitChatsIntakeLocationAttestations,
  fulfillmentPolicyVersions,
  shippingPolicySettings,
} from "@/lib/private-db/schema";

import {
  getChitChatsOperationalIdentity,
  type ChitChatsOperationalIdentity,
} from "./config";
import { assertConfiguredFulfillmentOwnerInTransaction } from "./configured-owner";
import { assertShippingPolicyConfigurationMutationAllowed } from "./policy";

export const CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION =
  "chitchats-intake-location/v1";
export const CHITCHATS_INTAKE_ATTESTATION_STATEMENT =
  "I attest that this named and addressed physical location is where parcels first enter the Chit Chats network, belongs to the configured Chit Chats region, and is supported by the cited evidence.";
export const CHITCHATS_INTAKE_ATTESTATION_VALIDITY_DAYS = 90;

const FIVE_MINUTES_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export type ChitChatsIntakeLocationType =
  (typeof chitChatsIntakeLocationAttestations.$inferInsert)["locationType"];

const LOCATION_TYPES = ["branch", "drop_spot", "mail_in_hub"] as const;
type PrivateDbTransaction = Parameters<
  Parameters<ReturnType<typeof getPrivateDb>["transaction"]>[0]
>[0];

export interface AttestChitChatsIntakeLocationInput {
  actorAdminUserId: string;
  evidenceReference: string;
  expectedCurrentAttestationId: string | null;
  locationAddress: string;
  locationName: string;
  locationType: ChitChatsIntakeLocationType;
  now?: Date;
  rationale: string;
  statementConfirmed: boolean;
  stepUpAuthenticatedAt: Date;
}

export interface RevokeChitChatsIntakeLocationInput {
  actorAdminUserId: string;
  expectedCurrentAttestationId: string;
  expectedCurrentPolicyVersion: string;
  now?: Date;
  reason: string;
  stepUpAuthenticatedAt: Date;
}

export interface ChitChatsIntakeLocationReadinessRecord {
  attestedAt: Date;
  attestedByAdminUserId: string;
  attestedByOwnerName: string;
  evidenceReference: string;
  id: string;
  locationAddress: string;
  locationName: string;
  locationType: ChitChatsIntakeLocationType;
  policyVersion: string;
  providerClientId: string;
  providerEnvironment: string;
  region: (typeof chitChatsIntakeLocationAttestations.$inferSelect)["region"];
  revokedAt: Date | null;
  statementVersion: string;
  validUntil: Date;
}

export function normalizeChitChatsIntakeLocationAttestation(
  input: Omit<
    AttestChitChatsIntakeLocationInput,
    "actorAdminUserId" | "expectedCurrentAttestationId" | "now"
  >,
  now = new Date(),
) {
  if (!input.statementConfirmed) {
    throw new Error("The intake-location attestation statement is required");
  }
  if (!isLocationType(input.locationType)) {
    throw new Error("The intake-location type is invalid");
  }
  assertRecentStepUp(input.stepUpAuthenticatedAt, now);

  return {
    evidenceReference: requiredText(
      input.evidenceReference,
      "Evidence reference",
      500,
    ),
    locationAddress: requiredText(
      input.locationAddress,
      "Location address",
      500,
    ),
    locationName: requiredText(input.locationName, "Location name", 160),
    locationType: input.locationType,
    rationale: requiredText(input.rationale, "Rationale", 1_000, 10),
    statementVersion: CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
    stepUpAuthenticatedAt: input.stepUpAuthenticatedAt,
  };
}

export async function attestChitChatsIntakeLocation(
  input: AttestChitChatsIntakeLocationInput,
) {
  const now = input.now ?? new Date();
  const normalized = normalizeChitChatsIntakeLocationAttestation(input, now);
  const identity = getChitChatsOperationalIdentity();
  const validUntil = new Date(
    now.getTime() + CHITCHATS_INTAKE_ATTESTATION_VALIDITY_DAYS * DAY_MS,
  );

  return getPrivateDb().transaction(async (tx) => {
    await lockShippingConfiguration(tx);
    assertShippingPolicyConfigurationMutationAllowed();
    const { owner, policyVersion } = await requireCurrentOwnerAndPolicy(
      tx,
      input.actorAdminUserId,
    );

    const current = await getCurrentEnvironmentRecord(tx, identity.environment);
    if ((current?.id ?? null) !== input.expectedCurrentAttestationId) {
      throw new Error(
        "The intake-location record changed; refresh before attesting again",
      );
    }

    if (current) {
      await tx
        .update(chitChatsIntakeLocationAttestations)
        .set({
          revokedAt: now,
          revokedByAdminUserId: owner.id,
          revocationReason:
            "Superseded by a new owner-attested Chit Chats intake location.",
        })
        .where(
          and(
            eq(chitChatsIntakeLocationAttestations.id, current.id),
            isNull(chitChatsIntakeLocationAttestations.revokedAt),
          ),
        );
    }

    const [created] = await tx
      .insert(chitChatsIntakeLocationAttestations)
      .values({
        ...normalized,
        attestedAt: now,
        attestedByAdminUserId: owner.id,
        attestedByOwnerName: owner.displayName,
        policyVersion,
        providerClientId: identity.clientId,
        providerEnvironment: identity.environment,
        region: identity.region,
        validUntil,
      })
      .returning();
    if (!created)
      throw new Error("The intake-location attestation was not saved");
    await tx.insert(adminAuditLogs).values({
      action: "fulfillment.intake_location_attested",
      actorAdminUserId: owner.id,
      actorRole: "owner",
      createdAt: now,
      domain: "fulfillment",
      metadata: {
        locationType: created.locationType,
        providerEnvironment: created.providerEnvironment,
        region: created.region,
        statementVersion: created.statementVersion,
      },
      outcome: "success",
      targetId: created.id,
      targetType: "chitchats_intake_location_attestation",
    });
    return created;
  });
}

export async function revokeChitChatsIntakeLocation(
  input: RevokeChitChatsIntakeLocationInput,
) {
  const now = input.now ?? new Date();
  assertRecentStepUp(input.stepUpAuthenticatedAt, now);
  const reason = requiredText(input.reason, "Revocation reason", 1_000, 10);
  const identity = getChitChatsOperationalIdentity();

  return getPrivateDb().transaction(async (tx) => {
    await lockShippingConfiguration(tx);
    assertShippingPolicyConfigurationMutationAllowed();
    const { owner } = await requireCurrentOwnerAndPolicy(
      tx,
      input.actorAdminUserId,
    );
    const current = await getCurrentEnvironmentRecord(tx, identity.environment);
    if (
      !current ||
      current.id !== input.expectedCurrentAttestationId ||
      current.policyVersion !== input.expectedCurrentPolicyVersion
    ) {
      throw new Error(
        "The intake-location record changed; refresh before revoking it",
      );
    }
    const [revoked] = await tx
      .update(chitChatsIntakeLocationAttestations)
      .set({
        revokedAt: now,
        revokedByAdminUserId: owner.id,
        revocationReason: reason,
      })
      .where(
        and(
          eq(chitChatsIntakeLocationAttestations.id, current.id),
          isNull(chitChatsIntakeLocationAttestations.revokedAt),
        ),
      )
      .returning();
    if (!revoked)
      throw new Error("No active intake-location attestation exists");
    await tx.insert(adminAuditLogs).values({
      action: "fulfillment.intake_location_revoked",
      actorAdminUserId: owner.id,
      actorRole: "owner",
      createdAt: now,
      domain: "fulfillment",
      metadata: {
        providerEnvironment: revoked.providerEnvironment,
        region: revoked.region,
      },
      outcome: "success",
      targetId: revoked.id,
      targetType: "chitchats_intake_location_attestation",
    });
    return revoked;
  });
}

export async function getChitChatsIntakeLocationReadinessRecord(
  identity: ChitChatsOperationalIdentity = getChitChatsOperationalIdentity(),
): Promise<ChitChatsIntakeLocationReadinessRecord | null> {
  const [record] = await getPrivateDb()
    .select({
      attestedAt: chitChatsIntakeLocationAttestations.attestedAt,
      attestedByAdminUserId:
        chitChatsIntakeLocationAttestations.attestedByAdminUserId,
      attestedByOwnerName:
        chitChatsIntakeLocationAttestations.attestedByOwnerName,
      evidenceReference: chitChatsIntakeLocationAttestations.evidenceReference,
      id: chitChatsIntakeLocationAttestations.id,
      locationAddress: chitChatsIntakeLocationAttestations.locationAddress,
      locationName: chitChatsIntakeLocationAttestations.locationName,
      locationType: chitChatsIntakeLocationAttestations.locationType,
      policyVersion: chitChatsIntakeLocationAttestations.policyVersion,
      providerClientId: chitChatsIntakeLocationAttestations.providerClientId,
      providerEnvironment:
        chitChatsIntakeLocationAttestations.providerEnvironment,
      region: chitChatsIntakeLocationAttestations.region,
      revokedAt: chitChatsIntakeLocationAttestations.revokedAt,
      statementVersion: chitChatsIntakeLocationAttestations.statementVersion,
      validUntil: chitChatsIntakeLocationAttestations.validUntil,
    })
    .from(chitChatsIntakeLocationAttestations)
    .where(
      and(
        eq(
          chitChatsIntakeLocationAttestations.providerEnvironment,
          identity.environment,
        ),
        isNull(chitChatsIntakeLocationAttestations.revokedAt),
      ),
    )
    .orderBy(desc(chitChatsIntakeLocationAttestations.attestedAt))
    .limit(1);
  return record ?? null;
}

export function intakeLocationRecordMatchesConfiguration(input: {
  configuredOwnerId: string | null;
  effectivePolicyVersion: string | null;
  identity: ChitChatsOperationalIdentity;
  now: Date;
  record: ChitChatsIntakeLocationReadinessRecord | null;
}): boolean {
  const { configuredOwnerId, effectivePolicyVersion, identity, now, record } =
    input;
  return Boolean(
    record &&
    configuredOwnerId &&
    effectivePolicyVersion &&
    record.attestedByAdminUserId === configuredOwnerId &&
    record.providerEnvironment === identity.environment &&
    record.providerClientId === identity.clientId &&
    record.region === identity.region &&
    record.statementVersion ===
      CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION &&
    record.policyVersion === effectivePolicyVersion &&
    record.attestedAt <= now &&
    record.validUntil > now &&
    !record.revokedAt &&
    record.locationName.trim() &&
    record.locationAddress.trim() &&
    record.evidenceReference.trim(),
  );
}

async function lockShippingConfiguration(tx: PrivateDbTransaction) {
  const [settings] = await tx
    .select({ singletonKey: shippingPolicySettings.singletonKey })
    .from(shippingPolicySettings)
    .where(eq(shippingPolicySettings.singletonKey, "default"))
    .for("update")
    .limit(1);
  if (!settings) throw new Error("Shipping policy settings are not configured");
}

async function requireCurrentOwnerAndPolicy(
  tx: PrivateDbTransaction,
  adminUserId: string,
) {
  const owner = await assertConfiguredFulfillmentOwnerInTransaction(
    tx,
    adminUserId,
  );
  if (!owner.displayName?.trim())
    throw new Error(
      "The active configured Business Owner must attest the intake location",
    );

  const [policy] = await tx
    .select({ version: fulfillmentPolicyVersions.version })
    .from(fulfillmentPolicyVersions)
    .where(
      and(
        eq(fulfillmentPolicyVersions.status, "effective"),
        isNotNull(fulfillmentPolicyVersions.operationsAttestedAt),
      ),
    )
    .orderBy(desc(fulfillmentPolicyVersions.effectiveAt))
    .limit(1);
  if (!policy) {
    throw new Error(
      "An effective owner-attested fulfillment policy is required",
    );
  }
  return {
    owner: { ...owner, displayName: owner.displayName.trim() },
    policyVersion: policy.version,
  };
}

async function getCurrentEnvironmentRecord(
  tx: PrivateDbTransaction,
  environment: ChitChatsOperationalIdentity["environment"],
) {
  const [record] = await tx
    .select({
      id: chitChatsIntakeLocationAttestations.id,
      policyVersion: chitChatsIntakeLocationAttestations.policyVersion,
    })
    .from(chitChatsIntakeLocationAttestations)
    .where(
      and(
        eq(
          chitChatsIntakeLocationAttestations.providerEnvironment,
          environment,
        ),
        isNull(chitChatsIntakeLocationAttestations.revokedAt),
      ),
    )
    .limit(1);
  return record ?? null;
}

function assertRecentStepUp(value: Date, now: Date): void {
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.getTime()) ||
    value > now ||
    now.getTime() - value.getTime() > FIVE_MINUTES_MS
  ) {
    throw new Error("Recent step-up authentication is required");
  }
}

function isLocationType(value: string): value is ChitChatsIntakeLocationType {
  return (LOCATION_TYPES as readonly string[]).includes(value);
}

function requiredText(
  value: string,
  label: string,
  maximum: number,
  minimum = 1,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum) {
    throw new Error(`${label} must contain at least ${minimum} characters`);
  }
  if (normalized.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} characters`);
  }
  return normalized;
}

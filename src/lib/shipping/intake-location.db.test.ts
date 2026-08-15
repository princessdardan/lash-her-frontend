import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run DB-backed Chit Chats intake-location tests";

const scenario = String.raw`
  import assert from "node:assert/strict";
  import { and, eq, like, sql } from "drizzle-orm";
  import { closePrivateDbPool, getPrivateDb } from "./src/lib/private-db/client.ts";
  import {
    adminAuditLogs,
    adminUsers,
    chitChatsIntakeLocationAttestations,
    fulfillmentPolicyVersions,
    shippingPolicyAssignments,
    shippingPolicySettings,
  } from "./src/lib/private-db/schema.ts";
  import {
    attestChitChatsIntakeLocation,
    CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
    revokeChitChatsIntakeLocation,
  } from "./src/lib/shipping/intake-location.ts";

  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.ADMIN_OWNER_EMAILS = "intake-location-owner@example.invalid";
  process.env.CHITCHATS_CLIENT_ID = "intake-location-client";
  process.env.CHITCHATS_ENVIRONMENT = "staging";
  process.env.CHITCHATS_REGION = "ontario_manitoba";
  process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";
  process.env.VERCEL_ENV = "preview";

  const db = getPrivateDb();
  const fixturePrefix = "lh-intake-location-db-test-";
  const ownerEmail = "intake-location-owner@example.invalid";
  const policyVersion = fixturePrefix + "policy-v1";

  async function cleanup() {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(
        "LOCK TABLE chitchats_intake_location_attestations " +
        "IN ACCESS EXCLUSIVE MODE",
      ));
      await tx.execute(sql.raw(
        "ALTER TABLE chitchats_intake_location_attestations " +
        "DISABLE TRIGGER chitchats_intake_location_attestation_immutable",
      ));
      await tx.execute(sql.raw(
        "DELETE FROM admin_audit_logs WHERE target_type = " +
        "'chitchats_intake_location_attestation' AND target_id IN " +
        "(SELECT id::text FROM chitchats_intake_location_attestations " +
        "WHERE policy_version LIKE 'lh-intake-location-db-test-%')",
      ));
      await tx.delete(chitChatsIntakeLocationAttestations).where(
        like(
          chitChatsIntakeLocationAttestations.policyVersion,
          fixturePrefix + "%",
        ),
      );
      await tx.delete(fulfillmentPolicyVersions).where(
        like(fulfillmentPolicyVersions.version, fixturePrefix + "%"),
      );
      await tx.execute(sql.raw(
        "DELETE FROM shipping_policy_assignments WHERE admin_user_id IN " +
        "(SELECT id FROM admin_users WHERE provider_user_id LIKE " +
        "'lh-intake-location-db-test-%')",
      ));
      await tx.delete(adminUsers).where(
        like(adminUsers.providerUserId, fixturePrefix + "%"),
      );
      await tx.execute(sql.raw(
        "ALTER TABLE chitchats_intake_location_attestations " +
        "ENABLE TRIGGER chitchats_intake_location_attestation_immutable",
      ));
    });
  }

  function attestationInput(actorAdminUserId, expectedCurrentAttestationId, suffix) {
    const now = new Date("2026-08-15T15:00:00.000Z");
    return {
      actorAdminUserId,
      evidenceReference: "owner-recorded-evidence/" + suffix,
      expectedCurrentAttestationId,
      locationAddress: suffix + " - 100 Intake Street, Toronto, ON",
      locationName: "Toronto intake " + suffix,
      locationType: "branch",
      now,
      rationale: "Verified physical intake location for test " + suffix + ".",
      statementConfirmed: true,
      stepUpAuthenticatedAt: new Date(now.getTime() - 60_000),
    };
  }

  try {
    await cleanup();

    const [settings] = await db.select({
      singletonKey: shippingPolicySettings.singletonKey,
    }).from(shippingPolicySettings).where(
      eq(shippingPolicySettings.singletonKey, "default"),
    );
    assert.ok(settings, "the migrated test database must contain shipping settings");

    const [owner] = await db.insert(adminUsers).values({
      providerUserId: fixturePrefix + "owner",
      email: ownerEmail,
      emailNormalized: ownerEmail,
      displayName: "Intake Location Owner",
      role: "owner",
      status: "active",
    }).returning({ id: adminUsers.id });
    const [staff] = await db.insert(adminUsers).values({
      providerUserId: fixturePrefix + "staff",
      email: "intake-location-staff@example.invalid",
      emailNormalized: "intake-location-staff@example.invalid",
      displayName: "Intake Location Staff",
      role: "employee",
      status: "active",
    }).returning({ id: adminUsers.id });

    const attestedAt = new Date("2026-08-15T14:00:00.000Z");
    await db.insert(fulfillmentPolicyVersions).values({
      version: policyVersion,
      status: "effective",
      ownerName: "Intake Location Owner",
      policySnapshot: { fixture: true },
      privacyLegalAttestedAt: attestedAt,
      securityAttestedAt: attestedAt,
      operationsAttestedAt: attestedAt,
      attestationEvidenceReference: "owner-policy-evidence",
      attestedByAdminUserId: owner.id,
      effectiveAt: attestedAt,
    });

    const [staffAssignment] = await db.insert(shippingPolicyAssignments).values({
      duty: "business_owner",
      adminUserId: staff.id,
      active: true,
      assignedByAdminUserId: owner.id,
    }).returning({ id: shippingPolicyAssignments.id });

    await assert.rejects(
      attestChitChatsIntakeLocation(
        attestationInput(staff.id, null, "staff-attempt"),
      ),
      /sole configured fulfillment owner must perform/,
    );
    assert.equal(
      (await db.select().from(chitChatsIntakeLocationAttestations)).length,
      0,
      "a non-owner attempt must not persist an attestation",
    );

    await db.update(shippingPolicyAssignments).set({ active: false }).where(
      eq(shippingPolicyAssignments.id, staffAssignment.id),
    );
    await db.insert(shippingPolicyAssignments).values(
      [
        "business_owner",
        "operations_lead",
        "finance_owner",
        "payment_fraud_owner",
        "privacy_owner",
        "security_owner",
      ].map((duty) => ({
        duty: duty as (typeof shippingPolicyAssignments.$inferInsert)["duty"],
        adminUserId: owner.id,
        active: true,
        assignedByAdminUserId: owner.id,
      })),
    );

    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "observe";
    await assert.rejects(
      attestChitChatsIntakeLocation(
        attestationInput(owner.id, null, "observe-attest"),
      ),
      /disabled in observe mode/,
    );
    await assert.rejects(
      revokeChitChatsIntakeLocation({
        actorAdminUserId: owner.id,
        expectedCurrentAttestationId:
          "11111111-1111-4111-8111-111111111111",
        expectedCurrentPolicyVersion: policyVersion,
        now: new Date("2026-08-15T15:00:00.000Z"),
        reason: "Observe mode must not mutate readiness evidence.",
        stepUpAuthenticatedAt: new Date("2026-08-15T14:59:00.000Z"),
      }),
      /disabled in observe mode/,
    );
    assert.equal(
      (await db.select().from(chitChatsIntakeLocationAttestations)).length,
      0,
      "observe mode must not persist an attestation or revocation",
    );
    assert.equal(
      (await db.select().from(adminAuditLogs).where(
        eq(
          adminAuditLogs.targetType,
          "chitchats_intake_location_attestation",
        ),
      )).length,
      0,
      "observe mode must not persist a success audit",
    );
    process.env.SHIPPING_POLICY_ENFORCEMENT_MODE = "off";

    const first = await attestChitChatsIntakeLocation(
      attestationInput(owner.id, null, "first"),
    );
    const [persistedFirst] = await db.select({
      attestedByAdminUserId:
        chitChatsIntakeLocationAttestations.attestedByAdminUserId,
      policyVersion: chitChatsIntakeLocationAttestations.policyVersion,
      providerClientId: chitChatsIntakeLocationAttestations.providerClientId,
      providerEnvironment:
        chitChatsIntakeLocationAttestations.providerEnvironment,
      region: chitChatsIntakeLocationAttestations.region,
      revokedAt: chitChatsIntakeLocationAttestations.revokedAt,
      statementVersion: chitChatsIntakeLocationAttestations.statementVersion,
    }).from(chitChatsIntakeLocationAttestations).where(
      eq(chitChatsIntakeLocationAttestations.id, first.id),
    );
    assert.deepEqual(persistedFirst, {
      attestedByAdminUserId: owner.id,
      policyVersion,
      providerClientId: "intake-location-client",
      providerEnvironment: "staging",
      region: "ontario_manitoba",
      revokedAt: null,
      statementVersion: CHITCHATS_INTAKE_ATTESTATION_STATEMENT_VERSION,
    });

    const second = await attestChitChatsIntakeLocation(
      attestationInput(owner.id, first.id, "second"),
    );
    const afterReplacement = await db.select({
      id: chitChatsIntakeLocationAttestations.id,
      revokedAt: chitChatsIntakeLocationAttestations.revokedAt,
      revokedByAdminUserId:
        chitChatsIntakeLocationAttestations.revokedByAdminUserId,
    }).from(chitChatsIntakeLocationAttestations).where(
      eq(
        chitChatsIntakeLocationAttestations.providerClientId,
        "intake-location-client",
      ),
    );
    assert.equal(afterReplacement.length, 2);
    assert.equal(afterReplacement.filter((record) => !record.revokedAt).length, 1);
    assert.equal(
      afterReplacement.find((record) => record.id === first.id)?.revokedByAdminUserId,
      owner.id,
    );
    assert.equal(
      afterReplacement.find((record) => !record.revokedAt)?.id,
      second.id,
    );

    await assert.rejects(
      attestChitChatsIntakeLocation(
        attestationInput(owner.id, first.id, "stale"),
      ),
      /record changed; refresh/,
    );
    assert.equal(
      (await db.select().from(chitChatsIntakeLocationAttestations).where(
        eq(
          chitChatsIntakeLocationAttestations.providerClientId,
          "intake-location-client",
        ),
      )).length,
      2,
      "a stale expected ID must roll back without adding or revoking a record",
    );

    const concurrentResults = await Promise.allSettled([
      attestChitChatsIntakeLocation(
        attestationInput(owner.id, second.id, "concurrent-a"),
      ),
      attestChitChatsIntakeLocation(
        attestationInput(owner.id, second.id, "concurrent-b"),
      ),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      concurrentResults.filter((result) => result.status === "rejected").length,
      1,
    );
    const rejected = concurrentResults.find((result) => result.status === "rejected");
    assert.match(String(rejected?.reason), /record changed; refresh/);

    const finalRecords = await db.select({
      revokedAt: chitChatsIntakeLocationAttestations.revokedAt,
    }).from(chitChatsIntakeLocationAttestations).where(
      and(
        eq(
          chitChatsIntakeLocationAttestations.providerEnvironment,
          "staging",
        ),
        eq(
          chitChatsIntakeLocationAttestations.providerClientId,
          "intake-location-client",
        ),
      ),
    );
    assert.equal(finalRecords.length, 3);
    assert.equal(finalRecords.filter((record) => !record.revokedAt).length, 1);
    const successAudits = await db.select({
      action: adminAuditLogs.action,
      outcome: adminAuditLogs.outcome,
      targetId: adminAuditLogs.targetId,
    }).from(adminAuditLogs).where(
      and(
        eq(adminAuditLogs.actorAdminUserId, owner.id),
        eq(adminAuditLogs.targetType, "chitchats_intake_location_attestation"),
      ),
    );
    assert.equal(successAudits.length, 3);
    assert.ok(successAudits.every((entry) =>
      entry.action === "fulfillment.intake_location_attested" &&
      entry.outcome === "success" &&
      typeof entry.targetId === "string"
    ));
  } finally {
    await cleanup();
    await closePrivateDbPool();
  }
`;

test(
  "intake-location attestations enforce owner identity and serialize replacement",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", "--eval", scenario],
      { cwd: process.cwd(), env: process.env, stdio: "pipe" },
    );
  },
);

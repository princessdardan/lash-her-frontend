import { execFileSync } from "node:child_process";
import test from "node:test";

const dbTestSkipReason = process.env.TEST_DATABASE_URL
  ? undefined
  : "set TEST_DATABASE_URL to run intake-location immutability tests";

const scenario = `
  import assert from "node:assert/strict";
  import pg from "pg";

  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();

  async function rejectedAtSavepoint(name, query, expectedMessage) {
    await client.query("SAVEPOINT " + name);
    let failure;
    try {
      await client.query(query);
    } catch (error) {
      failure = error;
    }
    await client.query("ROLLBACK TO SAVEPOINT " + name);
    await client.query("RELEASE SAVEPOINT " + name);
    assert.ok(failure, "expected the database mutation to be rejected");
    assert.match(String(failure.message), expectedMessage);
  }

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(1940528481)");
    await client.query(
      "LOCK TABLE chitchats_intake_location_attestations IN SHARE ROW EXCLUSIVE MODE",
    );

    const fixtureId = crypto.randomUUID();
    const owner = await client.query(
      \`INSERT INTO admin_users (
        provider_user_id,
        email,
        email_normalized,
        display_name,
        role,
        status
      ) VALUES ($1, $2, $2, $3, 'owner', 'active')
      RETURNING id\`,
      [
        "lh-intake-immutability-" + fixtureId,
        "intake-immutability-" + fixtureId + "@example.invalid",
        "Intake Immutability Owner",
      ],
    );
    const ownerId = owner.rows[0].id;

    let attestation = await client.query(
      \`SELECT id, attested_at
       FROM chitchats_intake_location_attestations
       WHERE revoked_at IS NULL
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE\`,
    );

    if (attestation.rowCount === 0) {
      const policyVersion = "lh-intake-immutability-policy-" + fixtureId;
      await client.query(
        \`INSERT INTO fulfillment_policy_versions (
          version,
          status,
          owner_name,
          policy_snapshot
        ) VALUES ($1, 'draft', $2, '{}'::jsonb)\`,
        [policyVersion, "Intake Immutability Owner"],
      );
      attestation = await client.query(
        \`INSERT INTO chitchats_intake_location_attestations (
          provider_environment,
          provider_client_id,
          region,
          location_name,
          location_address,
          location_type,
          evidence_reference,
          rationale,
          statement_version,
          policy_version,
          attested_by_admin_user_id,
          attested_by_owner_name,
          step_up_authenticated_at,
          attested_at,
          valid_until
        ) VALUES (
          'staging',
          $1,
          'ontario_manitoba',
          'Toronto intake test',
          '100 Intake Street, Toronto, ON',
          'branch',
          'owner-recorded-evidence/test',
          'Verified physical intake location for immutability testing.',
          'chitchats-intake-location/v1',
          $2,
          $3,
          'Intake Immutability Owner',
          '2026-08-15T14:59:00.000Z',
          '2026-08-15T15:00:00.000Z',
          '2026-09-14T15:00:00.000Z'
        ) RETURNING id, attested_at\`,
        ["intake-immutability-client-" + fixtureId, policyVersion, ownerId],
      );
    }

    const attestationId = attestation.rows[0].id;
    await rejectedAtSavepoint(
      "core_rewrite",
      {
        text: \`UPDATE chitchats_intake_location_attestations
               SET evidence_reference = evidence_reference || '-rewritten'
               WHERE id = $1\`,
        values: [attestationId],
      },
      /attestation evidence is immutable/,
    );
    await rejectedAtSavepoint(
      "delete_attestation",
      {
        text: "DELETE FROM chitchats_intake_location_attestations WHERE id = $1",
        values: [attestationId],
      },
      /attestations cannot be deleted/,
    );

    const revokedAt = new Date(
      attestation.rows[0].attested_at.getTime() + 1_000,
    );
    const firstRevocation = await client.query(
      \`UPDATE chitchats_intake_location_attestations
       SET revoked_at = $2,
           revoked_by_admin_user_id = $3,
           revocation_reason = $4
       WHERE id = $1
       RETURNING revoked_at, revoked_by_admin_user_id, revocation_reason\`,
      [
        attestationId,
        revokedAt,
        ownerId,
        "Owner revoked the intake location after verification changed.",
      ],
    );
    assert.equal(firstRevocation.rowCount, 1);
    assert.equal(
      firstRevocation.rows[0].revoked_at.toISOString(),
      revokedAt.toISOString(),
    );
    assert.equal(firstRevocation.rows[0].revoked_by_admin_user_id, ownerId);

    await rejectedAtSavepoint(
      "second_revocation",
      {
        text: \`UPDATE chitchats_intake_location_attestations
               SET revocation_reason = $2
               WHERE id = $1\`,
        values: [
          attestationId,
          "A later attempt to replace the immutable revocation reason.",
        ],
      },
      /revocation is one-way/,
    );
    await rejectedAtSavepoint(
      "revert_revocation",
      {
        text: \`UPDATE chitchats_intake_location_attestations
               SET revoked_at = NULL,
                   revoked_by_admin_user_id = NULL,
                   revocation_reason = NULL
               WHERE id = $1\`,
        values: [attestationId],
      },
      /revocation is one-way/,
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
`;

test(
  "intake-location evidence is immutable and revocation is one-way",
  { skip: dbTestSkipReason },
  () => {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", scenario],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
  },
);

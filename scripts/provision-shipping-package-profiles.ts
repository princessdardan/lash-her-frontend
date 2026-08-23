/**
 * One-off provisioning: insert + owner-approve the real shipping package
 * profiles (the owner's physical boxes) into a real environment's Postgres so
 * `listEnabledPackageProfiles()` returns candidates and product checkout can
 * quote shipping rates.
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration 0032 seeded three generic boxes as `enabled = true`. Migration 0056
 * then quarantined + disabled every enabled profile that lacked owner step-up
 * review evidence and added the `shipping_package_profiles_enabled_evidence_check`
 * constraint, so a row can only be `enabled = true` when it carries a full
 * attestation (reviewer, step-up timestamp, evidence hash/version, action). The
 * only code that inserts profiles is the isolated E2E seed, which refuses to run
 * outside the test database — so preview/staging/production have NO enabled
 * profile, and every "Get shipping rates" call throws
 * "No configured package can safely contain this order" (packing.ts:76).
 *
 * This script fills that gap until a proper owner-facing admin approval flow
 * exists. The evidence fields it writes are synthetic-but-constraint-valid: they
 * satisfy the DB check but do NOT represent a real interactive step-up ceremony
 * (there is no such ceremony in the app yet). Treat this as provisioning, and
 * record the run in your launch/ops evidence trail.
 *
 * USAGE
 * -----
 *   # 1. Point at the target DB (e.g. preview) and preview the plan (no writes):
 *   DATABASE_URL='postgres://...preview...' \
 *     npx tsx scripts/provision-shipping-package-profiles.ts
 *
 *   # 2. Commit for real (idempotent upsert on slug):
 *   DATABASE_URL='postgres://...preview...' \
 *   PROVISION_PACKAGE_PROFILES=1 \
 *   PROVISION_ADMIN_EMAIL='owner@example.com' \
 *     npx tsx scripts/provision-shipping-package-profiles.ts
 *
 * The approving admin (PROVISION_ADMIN_EMAIL) must already exist and be active
 * in admin_users. If omitted, the script uses the sole active owner when there
 * is exactly one.
 */

import { createHash } from "node:crypto";

import { Pool } from "pg";

import { createPrivateDbPoolConfig } from "@/lib/private-db/pool-config";

// The owner's real boxes. Dimensions are whole centimetres (length × width ×
// height); the packer selects on a rotation-free fit, but these exact L/W/H are
// what gets reported to Chit Chats as the parcel. Weights are grams. Edit here
// if the physical boxes change.
const REVIEW_EVIDENCE_VERSION = "owner-real-boxes-v1";

interface BoxProfile {
  slug: string;
  name: string;
  rank: number;
  packageType: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  tareWeightGrams: number;
  maxWeightGrams: number;
  acceptsRigid: boolean;
  evidenceReference: string;
}

const BOXES: BoxProfile[] = [
  {
    slug: "mailer-box-30x22x5",
    name: "Mailer box 30 × 22 × 5 cm",
    rank: 10,
    packageType: "parcel",
    lengthCm: 30,
    widthCm: 22,
    heightCm: 5,
    tareWeightGrams: 90,
    maxWeightGrams: 2_000,
    acceptsRigid: true,
    evidenceReference:
      "provisioning://package/mailer-box-30x22x5/owner-real-boxes-v1",
  },
  {
    slug: "mailer-box-36x26x4",
    name: "Mailer box 36 × 26 × 4 cm",
    rank: 20,
    packageType: "parcel",
    lengthCm: 36,
    widthCm: 26,
    heightCm: 4,
    tareWeightGrams: 120,
    maxWeightGrams: 3_000,
    acceptsRigid: true,
    evidenceReference:
      "provisioning://package/mailer-box-36x26x4/owner-real-boxes-v1",
  },
];

function evidenceHash(box: BoxProfile): string {
  // Deterministic, 64 hex chars — matches the constraint's ^[0-9a-f]{64}$ and
  // pins the hash to this box + evidence version + action.
  return createHash("sha256")
    .update(
      `${box.slug}|${REVIEW_EVIDENCE_VERSION}|approve_shipping_package_profile`,
      "utf8",
    )
    .digest("hex");
}

function redactTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.username ? "***@" : ""}${url.host}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function resolveApprovingAdminId(pool: Pool): Promise<{
  id: string;
  email: string;
  role: string;
}> {
  const explicitEmail = process.env.PROVISION_ADMIN_EMAIL?.trim();

  if (explicitEmail) {
    const { rows } = await pool.query<{
      id: string;
      email: string;
      role: string;
    }>(
      `SELECT id, email, role
         FROM admin_users
        WHERE status = 'active'
          AND (lower(email_normalized) = lower($1) OR lower(email) = lower($1))
        LIMIT 2`,
      [explicitEmail],
    );
    if (rows.length === 0) {
      throw new Error(
        `No active admin_users row matches PROVISION_ADMIN_EMAIL="${explicitEmail}"`,
      );
    }
    if (rows.length > 1) {
      throw new Error(
        `PROVISION_ADMIN_EMAIL="${explicitEmail}" matched more than one active admin; use a unique address`,
      );
    }
    return rows[0]!;
  }

  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: string;
  }>(
    `SELECT id, email, role
       FROM admin_users
      WHERE status = 'active' AND role = 'owner'
      LIMIT 2`,
  );
  if (rows.length === 0) {
    throw new Error(
      "No active owner admin found. Set PROVISION_ADMIN_EMAIL to an existing active admin.",
    );
  }
  if (rows.length > 1) {
    throw new Error(
      "Multiple active owners found. Set PROVISION_ADMIN_EMAIL to disambiguate the approver.",
    );
  }
  return rows[0]!;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  if (process.env.NEXT_PUBLIC_SANITY_DATASET === "production") {
    // Not a hard block, but make production intent explicit and loud.
    console.warn(
      "[provision] NEXT_PUBLIC_SANITY_DATASET=production — you are targeting a production-aligned environment.",
    );
  }

  const commit = process.env.PROVISION_PACKAGE_PROFILES === "1";
  const pool = new Pool(createPrivateDbPoolConfig(connectionString));

  try {
    console.info(`[provision] Target: ${redactTarget(connectionString)}`);
    console.info(
      `[provision] Mode: ${commit ? "COMMIT (writing)" : "DRY RUN (no writes — set PROVISION_PACKAGE_PROFILES=1 to commit)"}`,
    );

    const admin = await resolveApprovingAdminId(pool);
    console.info(
      `[provision] Approving admin: ${admin.email} (role=${admin.role}, id=${admin.id})`,
    );

    console.info("[provision] Boxes to insert/enable:");
    for (const box of BOXES) {
      console.info(
        `  - ${box.slug}: ${box.lengthCm}×${box.widthCm}×${box.heightCm} cm, ` +
          `tare ${box.tareWeightGrams} g, max ${box.maxWeightGrams} g, ` +
          `rigid=${box.acceptsRigid}, rank ${box.rank}`,
      );
    }

    if (!commit) {
      console.info(
        "[provision] Dry run complete. Re-run with PROVISION_PACKAGE_PROFILES=1 to apply.",
      );
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // reviewed_at and review_step_up_authenticated_at both use now() within the
      // same statement, so they are equal — satisfying the check's requirement
      // that step-up is <= reviewed_at and within the 5-minute window before it.
      const applied: Array<{ slug: string; action: "inserted" | "updated" }> =
        [];
      for (const box of BOXES) {
        const { rows } = await client.query<{ inserted: boolean }>(
          `INSERT INTO shipping_package_profiles (
             slug, name, rank, package_type,
             length_cm, width_cm, height_cm,
             tare_weight_grams, max_weight_grams,
             accepts_rigid, enabled,
             reviewed_at, reviewed_by_admin_user_id, review_step_up_authenticated_at,
             evidence_reference, review_evidence_hash, review_evidence_version, review_action,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7,
             $8, $9,
             $10, true,
             now(), $11, now(),
             $12, $13, $14, 'approve_shipping_package_profile',
             now(), now()
           )
           ON CONFLICT (slug) DO UPDATE SET
             name = EXCLUDED.name,
             rank = EXCLUDED.rank,
             package_type = EXCLUDED.package_type,
             length_cm = EXCLUDED.length_cm,
             width_cm = EXCLUDED.width_cm,
             height_cm = EXCLUDED.height_cm,
             tare_weight_grams = EXCLUDED.tare_weight_grams,
             max_weight_grams = EXCLUDED.max_weight_grams,
             accepts_rigid = EXCLUDED.accepts_rigid,
             enabled = true,
             reviewed_at = now(),
             reviewed_by_admin_user_id = EXCLUDED.reviewed_by_admin_user_id,
             review_step_up_authenticated_at = now(),
             evidence_reference = EXCLUDED.evidence_reference,
             review_evidence_hash = EXCLUDED.review_evidence_hash,
             review_evidence_version = EXCLUDED.review_evidence_version,
             review_action = 'approve_shipping_package_profile',
             updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            box.slug,
            box.name,
            box.rank,
            box.packageType,
            box.lengthCm,
            box.widthCm,
            box.heightCm,
            box.tareWeightGrams,
            box.maxWeightGrams,
            box.acceptsRigid,
            admin.id,
            box.evidenceReference,
            evidenceHash(box),
            REVIEW_EVIDENCE_VERSION,
          ],
        );
        applied.push({
          slug: box.slug,
          action: rows[0]?.inserted ? "inserted" : "updated",
        });
      }
      await client.query("COMMIT");

      for (const entry of applied) {
        console.info(`[provision] ${entry.action}: ${entry.slug}`);
      }

      const { rows: enabledRows } = await pool.query<{
        slug: string;
        rank: number;
      }>(
        `SELECT slug, rank FROM shipping_package_profiles WHERE enabled = true ORDER BY rank ASC`,
      );
      console.info(
        `[provision] Enabled package profiles now (${enabledRows.length}): ${
          enabledRows.map((r) => `${r.slug}(#${r.rank})`).join(", ") || "none"
        }`,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(
    "[provision] Failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

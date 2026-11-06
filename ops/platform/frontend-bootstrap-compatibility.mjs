// Reviewed old-schema compatibility and actual read-only pre-application state.
// This receipt never means application SQL was applied or traffic is admitted.
import { assertAppliedMigrationLineage } from "../../src/lib/private-db/migration-lineage.ts";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { createHash } from "node:crypto";
import {
  parseQualificationTargetProfileRef,
  requireQualificationTargetProfile,
  resolveQualificationTargetProfile,
} from "./qualification-target-profile.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const demand = ok => { if (!ok) throw new Error("FRONTEND_BOOTSTRAP_COMPATIBILITY_REFUSED"); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
const hasProfile = value => value && typeof value === "object" && Object.hasOwn(value, "qualificationTargetProfile");

function profileContext(expectedQualificationTargetProfile) {
  if (expectedQualificationTargetProfile === undefined) return undefined;
  const expected = parseQualificationTargetProfileRef(expectedQualificationTargetProfile);
  const profile = resolveQualificationTargetProfile(expected);
  demand(profile.id === "staging-current" && profile.kind === "existing-staging" &&
    profile.selectionPolicy === "existing-staging-v1" && profile.environment === "staging");
  return expected;
}

export const FRONTEND_BOOTSTRAP_DISABLED_FLAGS = Object.freeze([
  "INTEGRATION_CUSTOMER_ACCESS_ENABLED", "INTEGRATION_COURSE_READS_ENABLED", "INTEGRATION_CHECKOUT_ENABLED",
  "INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED", "INTEGRATION_COMMUNITY_READS_ENABLED", "INTEGRATION_COMMUNITY_WRITES_ENABLED",
  "INTEGRATION_LEARNING_ROUTES_ENABLED", "CUSTOMER_AUTH_ENABLED", "CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED",
  "CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED",
]);

export function prepareFrontendBootstrapCompatibility(input, expectedQualificationTargetProfile = undefined) {
  const expected = profileContext(expectedQualificationTargetProfile);
  const profiled = expected !== undefined;
  if (profiled) {
    demand(input?.version === 2);
    requireQualificationTargetProfile(expected, input);
  } else demand(input?.version === 1 && !hasProfile(input));
  demand(digest(input.schemaCatalogSha256) && digest(input.appliedLineageSha256) &&
    digest(input.validationEvidenceSha256) && digest(input.runtimeProducerSha256) && Number.isSafeInteger(input.appliedCount) && input.appliedCount >= 0 &&
    typeof input.recoveryAfterCompatibleBuild === "boolean");
  return { ...Object.fromEntries(["version", "schemaCatalogSha256", "appliedLineageSha256", "appliedCount",
    "validationEvidenceSha256", "runtimeProducerSha256", "recoveryAfterCompatibleBuild"].map(key => [key, input[key]])),
    ...(profiled ? { qualificationTargetProfile: expected } : {}) };
}

export async function observeFrontendBootstrapSchema(client, plan, migration, verifySession,
  expectedQualificationTargetProfile = undefined) {
  const expected = profileContext(expectedQualificationTargetProfile);
  const profiled = expected !== undefined;
  demand(!hasProfile(migration?.artifact) && !hasProfile(migration?.baseline));
  if (profiled) {
    demand(plan?.version === 2 && migration?.candidate?.version === 3 && migration?.job?.version === 2);
    requireQualificationTargetProfile(expected, plan, migration, migration.candidate,
      migration.candidate.frontendMigration, migration.job, migration.job.target);
  } else demand(plan?.version === 1 && migration?.candidate?.version === 2 && migration?.job?.version === 1 &&
    ![plan, migration, migration?.candidate, migration?.candidate?.frontendMigration,
      migration?.job, migration?.job?.target].some(hasProfile));
  const selected = prepareFrontendBootstrapCompatibility(plan.bootstrapCompatibility, expected);
  demand(typeof verifySession === "function"); await verifySession();
  await client.query("BEGIN READ ONLY");
  let value;
  try {
    const present = (await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present")).rows[0]?.present;
    const rows = present ? (await client.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC")).rows : [];
    assertAppliedMigrationLineage(migration.artifact.expected, rows);
    const lineage = rows.map(row => ({ hash: row.hash, created_at: String(row.created_at) }));
    const schemaCatalogSha256 = hash(await readMigrationCatalog(client)), appliedLineageSha256 = hash(lineage);
    demand(rows.length === selected.appliedCount && schemaCatalogSha256 === selected.schemaCatalogSha256 &&
      appliedLineageSha256 === selected.appliedLineageSha256);
    value = { version: profiled ? 2 : 1, ...(profiled ? { qualificationTargetProfile: expected } : {}),
      service: "frontend", environment: plan.environment, actionId: plan.actionId, sourceCommit: plan.sourceCommit,
      targetSha256: plan.targetSha256, status: "FRONTEND_PREAPPLICATION_SCHEMA_VERIFIED", schemaCatalogSha256, appliedLineageSha256,
      appliedCount: rows.length, validationEvidenceSha256: selected.validationEvidenceSha256,
      applicationSqlApplied: false, migrationAuthorized: false, trafficAuthorized: false };
  } finally { await client.query("ROLLBACK"); }
  await verifySession(); return value;
}

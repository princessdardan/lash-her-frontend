import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { validateFrontendLineageObservationRequest } from "./frontend-lineage-observation.mjs";
import { prepareFrontendMigration } from "./frontend-migration.mjs";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { decodeQualificationTargetJson, requireQualificationTargetProfile,
  STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";
import { phase2ContractManifestBinding, validatePlatformRelease } from "./release.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const refusal = "P2_FRONTEND_REPLACEMENT_PLAN_REFUSED";
const environment = "staging";
const targetFields = ["host", "port", "database", "user", "serverMajor"];
const fullTargetFields = [...targetFields, "runtimeRole"];
const jobFields = ["version", "qualificationTargetProfile", "operator", "releaseId", "environment", "contractPhase",
  "phase2ContractManifestSha256", "sourceCommit", "contractManifestSha256", "migrationImageDigest",
  "sqlArtifactSha256", "schemaBaselineSha256", "recoveryRef", "target"];
const observationChecks = ["verifiedTls", "readOnlyVerified", "migrationLockVerified", "samePhysicalSessionVerified"];
const observationRefusals = ["applicationSqlApplied", "bootstrapAuthorized", "migrationAuthorized", "trafficAuthorized"];
const demand = ok => { if (!ok) throw new Error(refusal); };
const rawHash = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = value => rawHash(JSON.stringify(value));
const matches = (value, expression) => typeof value === "string" && expression.test(value);
const digest = value => matches(value, /^(?!0+$)[a-f0-9]{64}$/u);
const role = value => matches(value, /^[a-z][a-z0-9_]{0,62}$/u);
const oid = value => matches(value, /^[1-9][0-9]{0,9}$/u) && Number(value) <= 4294967295;
const reference = value => matches(value, /^[A-Za-z0-9_./:-]{1,200}$/u);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(field => {
    const property = Object.getOwnPropertyDescriptor(value, field);
    return property?.enumerable && Object.hasOwn(property, "value");
  });
const select = (value, fields) => Object.fromEntries(fields.map(field => [field, value[field]]));
function immutable(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(immutable);
    Object.freeze(value);
  }
  return value;
}

function reviewedJson(path, expectedSha256) {
  demand(typeof path === "string" && resolve(path) === path && digest(expectedSha256));
  frontendPrivateReceiptDirectory(dirname(path));
  const info = lstatSync(path);
  demand(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  const raw = readFrontendReleaseEvidence(dirname(path), basename(path));
  const after = lstatSync(path);
  demand(["dev", "ino", "mode", "uid", "nlink", "size", "mtimeMs", "ctimeMs"].every(key => after[key] === info[key]) &&
    rawHash(raw) === expectedSha256);
  return decodeQualificationTargetJson(raw, "carrier");
}

function verifyNeonResource(provider, directHost) {
  demand(exact(provider, ["kind", "projectId", "branchId", "endpointId", "directHost"]) && provider.kind === "neon" &&
    matches(provider.projectId, /^[a-z0-9][a-z0-9-]{0,95}$/u) &&
    matches(provider.branchId, /^br-[a-z0-9][a-z0-9-]{0,92}$/u) &&
    matches(provider.endpointId, /^ep-[a-z0-9][a-z0-9-]{0,92}$/u) &&
    matches(directHost, /^(?=.{1,253}$)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u) &&
    provider.directHost === directHost && directHost.startsWith(provider.endpointId + ".") &&
    directHost.endsWith(".neon.tech") && !/pooler|pgbouncer/u.test(directHost));
}

function verifyPredecessorLineage(observation, predecessorTarget, artifact) {
  demand(exact(observation, ["version", "qualificationTargetProfile", "sourceCommit", "target", "status", "journalPresent",
    "appliedCount", "lastApplied", "appliedPrefix", "appliedPrefixSha256", "pendingTags", "service", "environment",
    "observedAt", "sqlArtifactSha256", "contractManifestSha256", "contractPhase", "phase2ContractManifestSha256",
    "expectedMigrationCount", "databaseOid", "loginRoleOid", ...observationChecks, ...observationRefusals]));
  const { version, qualificationTargetProfile, sourceCommit, target } = observation;
  validateFrontendLineageObservationRequest({ version, qualificationTargetProfile, sourceCommit, target });
  const rows = artifact.manifest.entries;
  const count = observation.appliedCount, observedAt = Date.parse(observation.observedAt);
  demand(observation.status === "FRONTEND_LINEAGE_PENDING" && observation.journalPresent === true &&
    observation.environment === environment && observation.service === "frontend" &&
    isDeepStrictEqual(target, select(predecessorTarget, targetFields)) &&
    typeof observation.observedAt === "string" && Number.isFinite(observedAt) && observedAt <= Date.now() &&
    new Date(observedAt).toISOString() === observation.observedAt && oid(observation.databaseOid) && oid(observation.loginRoleOid) &&
    observation.sqlArtifactSha256 === artifact.sqlArtifactSha256 &&
    observation.contractManifestSha256 === artifact.contractManifestSha256 && observation.contractPhase === "p2" &&
    typeof observation.phase2ContractManifestSha256 === "string" && observation.phase2ContractManifestSha256.startsWith("sha256:") &&
    digest(observation.phase2ContractManifestSha256.slice(7)) &&
    observation.expectedMigrationCount === rows.length && Number.isSafeInteger(count) && count > 0 && count < rows.length &&
    isDeepStrictEqual(observation.appliedPrefix, rows.slice(0, count)) &&
    observation.appliedPrefixSha256 === hash(observation.appliedPrefix) &&
    isDeepStrictEqual(observation.lastApplied, rows[count - 1]) &&
    isDeepStrictEqual(observation.pendingTags, rows.slice(count).map(({ tag }) => tag)) &&
    observationChecks.every(field => observation[field] === true) &&
    observationRefusals.every(field => observation[field] === false));
}

// The caller supplies the review digest through independent operator custody.
// This plan retains approved identities, but only a later held session can
// verify them. Neither the output nor the review hash grants apply authority.
export function prepareP2FrontendReplacementPlan(options) {
  demand(exact(options, ["bundle", "reviewFile", "reviewSha256", "lineageFile"]));
  const { bundle, reviewFile, reviewSha256, lineageFile } = options;
  const review = reviewedJson(reviewFile, reviewSha256);
  requireQualificationTargetProfile(profile, review);
  demand(exact(review, ["version", "qualificationTargetProfile", "environment", "releaseId", "sourceCommit",
    "candidateSha256", "frontendJobSha256", "schemaBaselineFileSha256", "predecessor", "replacement"]) &&
    review.version === 1 && review.environment === environment);
  const { predecessor, replacement } = review;
  demand(exact(predecessor, ["provider", "target", "lineageSha256", "deploymentId", "recoveryRef"]) &&
    exact(replacement, ["provider", "databaseOid", "migrationRoleOid", "administrativeLogins", "recoveryRef"]) &&
    exact(predecessor.target, fullTargetFields) && matches(predecessor.deploymentId, /^dpl_[A-Za-z0-9]{1,128}$/u) &&
    reference(predecessor.recoveryRef) && reference(replacement.recoveryRef));
  frontendPrivateReceiptDirectory(bundle);
  const candidate = reviewedJson(join(bundle, "release.candidate.json"), review.candidateSha256);
  const job = reviewedJson(join(bundle, "jobs/frontend.json"), review.frontendJobSha256);
  const baseline = reviewedJson(join(bundle, "schema/frontend.json"), review.schemaBaselineFileSha256);
  demand(candidate.version === 3 && candidate.environment === environment && candidate.contractPhase === "p2" &&
    candidate.sourceGraph === undefined && validatePlatformRelease(candidate, new Date(), profile).length === 0 &&
    exact(job, jobFields) && exact(job.target, [...fullTargetFields, "qualificationTargetProfile", "allowEmptyBootstrap", "approvedPendingTags"]) &&
    job.releaseId === review.releaseId && job.sourceCommit === review.sourceCommit && job.recoveryRef === replacement.recoveryRef);
  const { phase2ContractRevisions } = phase2ContractManifestBinding(root, { requireReleased: true });
  demand(candidate.sources.course.commit === phase2ContractRevisions.course &&
    candidate.sources.community.commit === phase2ContractRevisions.community &&
    candidate.sources.community.commit === phase2ContractRevisions.enrollmentEvent);
  const { artifact } = prepareFrontendMigration(candidate, job, baseline, undefined, profile);
  const target = select(job.target, fullTargetFields);
  const predecessorTarget = predecessor.target;
  const tags = artifact.migrations.map(({ tag }) => tag);
  demand(job.target.allowEmptyBootstrap === true && isDeepStrictEqual(job.target.approvedPendingTags, tags) &&
    target.runtimeRole === FRONTEND_PREPARATION_ROLES.runtime &&
    [target.database, target.user, predecessorTarget.database, predecessorTarget.user, predecessorTarget.runtimeRole].every(role) &&
    predecessorTarget.user !== predecessorTarget.runtimeRole);
  verifyNeonResource(predecessor.provider, predecessorTarget.host);
  verifyNeonResource(replacement.provider, target.host);
  demand(predecessor.provider.branchId !== replacement.provider.branchId &&
    predecessor.provider.endpointId !== replacement.provider.endpointId && predecessorTarget.host !== target.host);
  const reservedRoles = [predecessorTarget.runtimeRole, ...Object.values(FRONTEND_PREPARATION_ROLES)];
  const { databaseOid, migrationRoleOid, administrativeLogins } = replacement;
  demand(oid(databaseOid) && oid(migrationRoleOid) && !reservedRoles.includes(target.user) &&
    target.runtimeRole !== predecessorTarget.runtimeRole &&
    Array.isArray(administrativeLogins) && administrativeLogins.length <= 32 &&
    administrativeLogins.every(login => exact(login, ["name", "oid"]) && role(login.name) && oid(login.oid) &&
      login.oid !== migrationRoleOid && login.name !== target.user && !reservedRoles.includes(login.name)) &&
    new Set(administrativeLogins.map(login => login.name)).size === administrativeLogins.length &&
    new Set(administrativeLogins.map(login => login.oid)).size === administrativeLogins.length);
  const observation = reviewedJson(lineageFile, predecessor.lineageSha256);
  verifyPredecessorLineage(observation, predecessorTarget, artifact);

  const targetSha256 = frontendAdmissionTargetSha256(environment, target);
  const probe = { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate, job, baseline, predecessorTarget, targetSha256, databaseOid, migrationRoleOid };
  const plan = { version: 1, qualificationTargetProfile: profile, environment,
    operation: "profiled-frontend-replacement", status: "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED",
    releaseId: job.releaseId, sourceCommit: job.sourceCommit, reviewSha256, targetSha256,
    candidateSha256: review.candidateSha256, frontendJobSha256: review.frontendJobSha256,
    schemaBaselineFileSha256: review.schemaBaselineFileSha256, migrationImageDigest: job.migrationImageDigest,
    sqlArtifactSha256: job.sqlArtifactSha256, schemaBaselineSha256: job.schemaBaselineSha256,
    contractManifestSha256: job.contractManifestSha256, phase2ContractManifestSha256: job.phase2ContractManifestSha256,
    predecessor: { ...predecessor, ...select(observation, ["databaseOid", "loginRoleOid", "sourceCommit", "observedAt",
      "appliedCount", "appliedPrefixSha256", "pendingTags", "phase2ContractManifestSha256"]) },
    replacement: { ...replacement, target, approvedPendingTags: tags },
    replacementObserved: false, bootstrapAuthorized: false, migrationAuthorized: false,
    deploymentAuthorized: false, trafficAuthorized: false, releaseAccepted: false };
  return immutable({ plan, probe, administrativeLogins });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, bundle, reviewFile, reviewSha256, lineageFile] = process.argv.slice(2);
    demand(process.versions.node.split(".")[0] === "24" && process.argv.length === 7 && mode === "--plan");
    console.log(JSON.stringify(prepareP2FrontendReplacementPlan({ bundle, reviewFile, reviewSha256, lineageFile }).plan));
  } catch { console.error(refusal); process.exitCode = 1; }
}

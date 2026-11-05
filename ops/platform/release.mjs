import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORIES = {
  frontend: "https://github.com/princessdardan/lash-her-frontend.git",
  course: "https://github.com/princessdardan/lash-her-course-api.git",
  community: "https://github.com/princessdardan/lash-her-community-api.git",
};
const ARTIFACTS = ["courseRuntime", "courseMigration", "communityRuntime", "communityMigration", "gateway", "frontendMigration"];

export function validatePlatformRelease(value, now = new Date()) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  const digest = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) && !/^sha256:0+$/u.test(value);
  const commit = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) && !/^0+$/u.test(value);
  if (!value || typeof value !== "object") return ["Release manifest required"];
  require(value.version === 2, "Unsupported release version");
  require(["staging", "production"].includes(value.environment), "Explicit environment required");
  require(typeof value.releaseId === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.releaseId), "Invalid release identifier");
  for (const [name, repository] of Object.entries(REPOSITORIES)) {
    require(value.sources?.[name]?.repository === repository && commit(value.sources?.[name]?.commit), `Exact ${name} source pin required`);
    require(value.sources?.[name]?.requiredChecks === "passed", `${name} required checks must pass`);
  }
  require(digest(value.contractManifestSha256), "Contract artifact hash required");
  if (value.contractPhase !== undefined || value.phase2ContractManifestSha256 !== undefined) {
    require(value.contractPhase === "p2" && digest(value.phase2ContractManifestSha256) &&
      value.frontendMigration?.contractPhase === "p2" && value.frontendMigration.phase2ContractManifestSha256 === value.phase2ContractManifestSha256,
    "Phase 2 contract artifact binding required");
  }
  require(value.sourceApproval?.mode === "single-operator-dispatch" && value.sourceApproval?.operatorGithubUserId === "8996309" &&
    typeof value.sourceApproval?.runId === "string" && /^[1-9][0-9]{0,19}$/u.test(value.sourceApproval.runId) &&
    Number.isSafeInteger(value.sourceApproval?.runAttempt) && value.sourceApproval.runAttempt > 0 &&
    Number.isFinite(Date.parse(value.sourceApproval?.verifiedAt)), "Operator dispatch and CI evidence required");
  for (const name of ARTIFACTS) {
    const artifact = value.artifacts?.[name];
    require(typeof artifact?.image === "string" && /^(?:ghcr\.io\/princessdardan\/[a-z0-9-]+|prom\/(?:prometheus|node-exporter))@sha256:[0-9a-f]{64}$/u.test(artifact.image) && !/@sha256:0+$/u.test(artifact.image), `${name} immutable image required`);
    require(digest(artifact?.sbomSha256) && digest(artifact?.provenanceSha256), `${name} SBOM and verified provenance required`);
    require(artifact?.scan === "passed", `${name} dependency/image scan must pass`);
  }
  require(value.artifacts?.courseRuntime?.image !== value.artifacts?.courseMigration?.image, "Course runtime and migration artifacts must differ");
  require(value.artifacts?.communityRuntime?.image !== value.artifacts?.communityMigration?.image, "Community runtime and migration artifacts must differ");
  require(value.approval?.state === "approved" && value.approval?.operator === "Dardan" &&
    value.approval.environment === value.environment && value.approval.releaseId === value.releaseId &&
    Number.isFinite(Date.parse(value.approval.approvedAt)) && Date.parse(value.approval.approvedAt) <= now.getTime(),
    "Operator approval for this release and environment required");
  if (value.environment === "production") {
    const staging = value.staging;
    require(staging?.state === "passed" && typeof staging.releaseId === "string" && staging.releaseId.length > 0 &&
      Number.isFinite(Date.parse(staging.verifiedAt)) && Date.parse(staging.verifiedAt) <= now.getTime() &&
      typeof staging.receiptRef === "string" && staging.receiptRef.length > 0 &&
      staging.contractManifestSha256 === value.contractManifestSha256 &&
      staging.contractPhase === value.contractPhase && staging.phase2ContractManifestSha256 === value.phase2ContractManifestSha256 &&
      Object.keys(REPOSITORIES).every((name) => staging.sources?.[name]?.commit === value.sources?.[name]?.commit) &&
      ARTIFACTS.every((name) => staging.artifacts?.[name]?.image === value.artifacts?.[name]?.image),
      "Production requires the exact staging-tested source and artifact digests");
  }
  require(value.migrations?.course?.state === "verified" && value.migrations?.community?.state === "verified", "Locked migration/lineage receipts required");
  require(value.migrations?.frontend?.state === "verified", "Frontend migration/lineage receipt required");
  require(value.recovery?.state === "verified", "Compatible recovery/rollback evidence required");
  // Dardan's November 1 scope decision removes billing/spending evidence from
  // release acceptance. Affordability metadata is advisory, not authorization.
  require(value.workload?.environment === "production" && typeof value.workload?.projectId === "string" && /^prj_[A-Za-z0-9]+$/u.test(value.workload.projectId), "Exact workload project/target required");
  require(value.scheduler?.state === "verified" && value.scheduler?.cancellation === "verified", "Qualified scheduler and strict cancellation required");
  // Operational monitoring/alerts are deferred by the operator's October 29
  // scope decision. They do not gate this plan's release manifest.
  return failures;
}

export function contractManifestHash() {
  return `sha256:${createHash("sha256").update(readFileSync(new URL("../../contracts/api-integration/v1/manifest.json", import.meta.url))).digest("hex")}`;
}

// This additive identity never changes the frozen v1 contract hash semantics.
export function phase2ContractManifestBinding(sourceRoot = fileURLToPath(new URL("../..", import.meta.url)), { requireReleased = false } = {}) {
  const directory = join(sourceRoot, "contracts/api-integration/p2-candidate");
  const bytes = readFileSync(join(directory, "manifest.json")), manifest = JSON.parse(bytes);
  const digest = value => createHash("sha256").update(value).digest("hex");
  const demand = ok => { if (!ok) throw new Error("Phase 2 contract source binding required"); };
  demand(manifest.version === 1 && ["candidate", "released"].includes(manifest.status) && (!requireReleased || manifest.status === "released") &&
    JSON.stringify(Object.keys(manifest.artifacts ?? {}).sort()) === JSON.stringify(["community", "course", "enrollmentEvent"]));
  const revisions = {};
  for (const [name, repository, file, source] of [
    ["course", "lash-her-course-api", "course-api.json", "openapi/course-api.json"],
    ["community", "lash-her-community-api", "community-api.json", "openapi/community-api.json"],
    ["enrollmentEvent", "lash-her-community-api", "enrollment-event.schema.json", "contracts/course-enrollment/v1/enrollment-event.schema.json"],
  ]) {
    const artifact = manifest.artifacts?.[name];
    demand(artifact?.repository === repository && artifact.file === file && artifact.sourcePath === source &&
      /^[a-f0-9]{40}$/u.test(artifact.revision ?? "") && !/^0+$/u.test(artifact.revision) &&
      digest(readFileSync(join(directory, file))) === artifact.sha256);
    revisions[name] = artifact.revision;
  }
  demand(digest(readFileSync(join(directory, "boundary-contracts.json"))) === manifest.boundarySha256);
  if (manifest.status === "released" || manifest.readmeSha256 !== undefined) demand(digest(readFileSync(join(directory, "README.md"))) === manifest.readmeSha256);
  return { contractPhase: "p2", phase2ContractManifestSha256: `sha256:${digest(bytes)}`, phase2ContractRevisions: revisions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node ops/platform/release.mjs <manifest.json>");
  const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const failures = validatePlatformRelease(manifest);
  if (manifest.contractManifestSha256 !== contractManifestHash()) failures.push("Pinned contract manifest does not match source");
  if (manifest.contractPhase === "p2" && manifest.phase2ContractManifestSha256 !== phase2ContractManifestBinding().phase2ContractManifestSha256)
    failures.push("Pinned phase 2 contract manifest does not match source");
  // Only fixed diagnostics are printed; manifest inputs can contain private data.
  if (failures.length) { process.stderr.write(`${failures.join("\n")}\n`); process.exitCode = 1; }
  else process.stdout.write("Platform manifest structure passed; actual release receipt/provenance verification remains required\n");
}

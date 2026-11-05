import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORIES, sourceContextFromEnvironment } from "./release-inputs.mjs";
import { SOURCE_APPROVAL_MODE, SOURCE_OPERATOR_ID, SOURCE_REPOSITORY_IDS, assertSourceContext, sourceBranchFor } from "./source-policy.mjs";
import { verifySourceCheckouts } from "./source-checkout.mjs";
import { localImageId } from "./local-images.mjs";
import { privateTlsPolicies } from "./configuration.mjs";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { verifyRecordedRuntime } from "../gateway/runtime/verify.mjs";

export const ARTIFACT_COMPONENTS = Object.freeze([
  { key: "gateway", env: "GATEWAY", source: "frontend", image: "lash-her-platform-gateway", local: "gateway" },
  { key: "frontendMigration", env: "FRONTEND_MIGRATION", source: "frontend", image: "lash-her-platform-frontend-migration", local: "frontend-migration" },
  { key: "courseRuntime", env: "COURSE_RUNTIME", source: "course", image: "lash-her-platform-course-runtime", local: "course-runtime" },
  { key: "courseMigration", env: "COURSE_MIGRATION", source: "course", image: "lash-her-platform-course-migration", local: "course-migration" },
  { key: "communityRuntime", env: "COMMUNITY_RUNTIME", source: "community", image: "lash-her-platform-community-runtime", local: "community-runtime" },
  { key: "communityMigration", env: "COMMUNITY_MIGRATION", source: "community", image: "lash-her-platform-community-migration", local: "community-migration" },
]);
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function verifyFrontendSchemaSummary(summary, artifact, sourceCommit) {
  const required = ["fresh-apply", "already-current", "data-bearing-upgrade", "lock-contention", "pending-chain-refusal",
    "lineage-refusal", "schema-refusal", "runtime-privilege-refusal", "tls-certificate-refusal", "exact-artifact-production-promotion"];
  if (summary?.status !== "FRONTEND_MIGRATION_OWNED_POSTGRES_PASS" || summary.postgresMajor !== 18 || summary.providerTouched !== false ||
      !/^[a-f0-9]{40}$/u.test(sourceCommit ?? "") || summary.sourceCommit !== sourceCommit || summary.packagedCliVerified !== true ||
      summary.sqlArtifactSha256 !== artifact.sqlArtifactSha256 || summary.contractManifestSha256 !== artifact.contractManifestSha256 ||
      !/^[a-f0-9]{64}$/u.test(summary.schemaBaselineSha256 ?? "") || /^0+$/u.test(summary.schemaBaselineSha256) ||
      !Array.isArray(summary.checks) || !required.every((name) => summary.checks.includes(name))) throw new Error("Exact frontend CI schema summary required");
  return summary.schemaBaselineSha256;
}

export function assertBuilderSource(provenance, repository, commit) {
  const entries = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.materials)) entries.push(...value.materials);
    if (value.configSource) entries.push(value.configSource);
    for (const child of Object.values(value)) visit(child);
  }
  visit(provenance);
  if (!entries.some((entry) => {
    if (entry?.digest?.sha1 !== commit || typeof entry.uri !== "string") return false;
    try {
      const url = new URL(entry.uri.replace(/^git\+/u, ""));
      return url.protocol === "https:" && url.host === "github.com" && !url.username && !url.password &&
        [new URL(repository).pathname, new URL(repository).pathname.replace(/\.git$/u, "")].includes(url.pathname);
    } catch { return false; }
  })) throw new Error("Builder provenance source mismatch");
}

export function assertSbom(value) {
  let found = false;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.spdxVersion === "string" && value.spdxVersion.startsWith("SPDX-") && Array.isArray(value.packages) && value.packages.length) found = true;
    for (const child of Object.values(value)) visit(child);
  }
  visit(value);
  if (!found) throw new Error("Nonempty SPDX SBOM required");
}

function command(program, args) {
  return execFileSync(program, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function assertCandidateSourceApproval(proof, context) {
  assertSourceContext(context);
  const approval = proof?.sourceApproval;
  if (proof?.version !== 3 || proof.workflowSha !== context.workflowSha || proof.workflowRef !== context.workflowRef ||
      proof.contractManifestSha256 !== context.contractManifestSha256 ||
      approval?.mode !== SOURCE_APPROVAL_MODE || approval.operatorGithubUserId !== SOURCE_OPERATOR_ID ||
      approval.runId !== context.runId || String(approval.runAttempt) !== context.runAttempt ||
      approval.verifiedAt !== proof.checkedAt || !Number.isFinite(Date.parse(proof.checkedAt))) {
    throw new Error("Operator-dispatched candidate source receipt required");
  }
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    const source = proof.sources?.[name];
    if (source?.repository !== `https://github.com/${repository}.git` || source.repositoryId !== SOURCE_REPOSITORY_IDS[name] ||
        source.commit !== context.revisions[name] || source.branch !== sourceBranchFor(name, context.branch) || source.requiredChecks !== "passed" ||
        !/^[1-9][0-9]{0,19}$/u.test(source.ciRunId ?? "") || !Number.isSafeInteger(source.ciAttempt) || source.ciAttempt < 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(source.ciWorkflowSha256 ?? "") || /^sha256:0+$/u.test(source.ciWorkflowSha256) ||
        typeof source.branchProtected !== "boolean") throw new Error("Candidate source or CI pin mismatch");
  }
  return approval;
}

function candidateSourceContext(proof, environment) {
  return sourceContextFromEnvironment({ ...environment, SOURCE_BRANCH: proof.workflowRef?.replace(/^refs\/heads\//u, ""),
    FRONTEND_REVISION: proof.sources?.frontend?.commit, COURSE_REVISION: proof.sources?.course?.commit,
    COMMUNITY_REVISION: proof.sources?.community?.commit });
}

// This produces a signed-build candidate, never an approved runtime release.
export function collectArtifactCandidate(directory, sourceRoot, environment = process.env) {
  const proof = JSON.parse(readFileSync(join(directory, "source-checks.json"), "utf8"));
  if (environment.GITHUB_REPOSITORY !== SOURCE_REPOSITORIES.frontend || environment.GITHUB_SHA !== proof.workflowSha ||
      environment.GITHUB_REF !== proof.workflowRef || !["refs/heads/staging", "refs/heads/main"].includes(proof.workflowRef) ||
      !/^\d+$/u.test(environment.GITHUB_RUN_ID ?? "") || !/^\d+$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("Verified coordinator context required");
  verifySourceCheckouts(sourceRoot, proof.sources);
  const sourceApproval = assertCandidateSourceApproval(proof, candidateSourceContext(proof, environment));
  const candidate = JSON.parse(readFileSync(new URL("./release.candidate.json", import.meta.url), "utf8"));
  candidate.releaseId = `p1-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`;
  candidate.approval.releaseId = candidate.releaseId;
  candidate.sources = proof.sources;
  candidate.sourceApproval = sourceApproval;
  candidate.contractManifestSha256 = hash(readFileSync(join(sourceRoot, "lash-her-frontend/contracts/api-integration/v1/manifest.json")));
  candidate.runtime = { composeSha256: hash(readFileSync(join(sourceRoot, "lash-her-frontend/ops/platform/compose.yaml"))),
    privateTlsPolicies: privateTlsPolicies() };
  const frontend = frontendMigrationArtifact(join(sourceRoot, "lash-her-frontend"));
  const frontendEvidence = join(directory, "frontend-schema-evidence"); mkdirSync(frontendEvidence, { mode: 0o700 });
  command("gh", ["run", "download", proof.sources.frontend.ciRunId, "--repo", SOURCE_REPOSITORIES.frontend,
    "--name", "frontend-operator-schema-summary", "--dir", frontendEvidence]);
  const frontendSummary = readFileSync(join(frontendEvidence, "frontend-schema-summary.json"));
  if (frontendSummary.length > 2_000_000) throw new Error("Frontend CI summary exceeds bound");
  const schemaHash = verifyFrontendSchemaSummary(JSON.parse(frontendSummary), frontend, proof.sources.frontend.commit);
  candidate.frontendMigration = { sourceCommit: proof.sources.frontend.commit, sqlArtifactSha256: frontend.sqlArtifactSha256,
    contractManifestSha256: frontend.contractManifestSha256, schemaBaselines: { 18: schemaHash }, ciSummarySha256: hash(frontendSummary) };
  candidate.buildWorkflow = { repository: SOURCE_REPOSITORIES.frontend, commit: proof.workflowSha, ref: proof.workflowRef,
    runId: environment.GITHUB_RUN_ID, attempt: environment.GITHUB_RUN_ATTEMPT };
  for (const component of ARTIFACT_COMPONENTS) {
    const digest = environment[`${component.env}_DIGEST`];
    if (!/^sha256:[0-9a-f]{64}$/u.test(digest ?? "") || /^sha256:0+$/u.test(digest)) throw new Error("Immutable artifact digest required");
    const image = `ghcr.io/princessdardan/${component.image}@${digest}`;
    const scan = JSON.parse(readFileSync(join(directory, `${component.local}-scan.json`), "utf8"));
    if (scan.ArtifactName !== image || scan.Metadata?.ImageConfig?.architecture !== "amd64" || !Array.isArray(scan.Results) || scan.Results.length === 0 || scan.Results.some((item) => item.Vulnerabilities?.some((v) => ["HIGH", "CRITICAL"].includes(v.Severity)))) throw new Error("Artifact scan required");
    if (["gateway", "frontendMigration"].includes(component.key)) {
      verifyRecordedRuntime(directory, component.local, image, join(sourceRoot, "lash-her-frontend"));
    } else if (scan.Results.some(item => item.ExperimentalModifiedFindings?.length)) {
      throw new Error("Unsupported artifact scan filtering");
    }
    const bundlePath = environment[`${component.env}_BUNDLE`];
    if (!bundlePath || !environment.RUNNER_TEMP || !resolve(bundlePath).startsWith(`${resolve(environment.RUNNER_TEMP)}/`)) throw new Error("Runner-owned attestation bundle required");
    const verifier = ["attestation", "verify", `oci://${image}`, "--repo", SOURCE_REPOSITORIES.frontend,
      "--signer-workflow", `${SOURCE_REPOSITORIES.frontend}/.github/workflows/platform-artifacts.yml`,
      "--signer-digest", proof.workflowSha, "--source-digest", proof.workflowSha, "--source-ref", proof.workflowRef,
      "--deny-self-hosted-runners", "--format", "json"];
    const verification = command("gh", [...verifier, "--bundle-from-oci"]);
    const verified = JSON.parse(verification);
    if (!Array.isArray(verified) || verified.length === 0) throw new Error("Verified attestation required");
    const localVerification = command("gh", [...verifier, "--bundle", bundlePath]);
    const verifiedLocal = JSON.parse(localVerification);
    if (!Array.isArray(verifiedLocal) || verifiedLocal.length === 0) throw new Error("Preserved attestation must also verify");
    const provenance = command("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .Provenance}}"]);
    const sbom = command("docker", ["buildx", "imagetools", "inspect", image, "--format", "{{json .SBOM}}"]);
    assertBuilderSource(JSON.parse(provenance), proof.sources[component.source].repository, proof.sources[component.source].commit);
    assertSbom(JSON.parse(sbom));
    const bundle = readFileSync(bundlePath);
    for (const [suffix, value] of [["verification.json", verification], ["bundle-verification.json", localVerification], ["buildkit-provenance.json", provenance], ["sbom.json", sbom], ["bundle.json", bundle]]) {
      writeFileSync(join(directory, `${component.local}-${suffix}`), value, { mode: 0o600, flag: "wx" });
    }
    candidate.artifacts[component.key] = { image, scan: "passed", sbomSha256: hash(sbom), provenanceSha256: hash(bundle),
      builderProvenanceSha256: hash(provenance), verificationSha256: hash(verification), platform: "linux/amd64" };
    // The test harness consumes these exact pulled bytes under local aliases.
    command("docker", ["pull", image]);
    command("docker", ["tag", image, `lash-her-${component.local}:p1-local`]);
    candidate.artifacts[component.key].localImageId = localImageId(command, image);
  }
  copyFileSync(join(directory, "source-checks.json"), join(directory, "verified-source-checks.json"));
  writeFileSync(join(directory, "release.candidate.json"), JSON.stringify(candidate, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return candidate;
}

export function qualifyHarness(candidate, report, reportBytes = JSON.stringify(report), frontendReport = undefined) {
  const required = ["frontend-sdk-oidc-catalog-tls", "signed-project-and-public-route-boundaries", "authenticated-idempotent-enrollment",
    "private-peer-spoofing-and-direct-backend-denial", "signed-mux-only-exception", "publisher-projection-and-worker-loop",
    "actual-community-authority-client", "worker-restart-requested", "worker-recovered-after-restart",
    "public-tls-missing-workload-denied", "public-metrics-hidden", "private-course-tls-catalog",
    "private-application-credential-required", "private-community-peer-denied", "maintenance-holds-application-writes"];
  if (!Array.isArray(report?.records) || !required.every((name) => report.records.some((item) => item.name === name && item.passed === true)) ||
      !report.records.every((item) => item.passed === true) || !ARTIFACT_COMPONENTS.filter((component) => component.key !== "frontendMigration").every((component) =>
        /^sha256:[0-9a-f]{64}$/u.test(candidate?.artifacts?.[component.key]?.localImageId ?? "") &&
        candidate.artifacts[component.key].localImageId === report.images?.[component.local])) throw new Error("Exact candidate harness evidence required");
  const schema = verifyFrontendSchemaSummary(frontendReport, candidate.frontendMigration, candidate.sources?.frontend?.commit);
  if (frontendReport.migrationImageDigest !== candidate.artifacts?.frontendMigration?.image?.split("@")[1] ||
      schema !== candidate.frontendMigration?.schemaBaselines?.[18]) throw new Error("Exact candidate frontend migration rehearsal required");
  return { ...candidate, integration: { state: "passed", reportSha256: hash(reportBytes),
    frontendMigrationRehearsalSha256: hash(JSON.stringify(frontendReport)),
    workloadProof: "signed-fixture", realVercelOidcVerified: false } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--harness") {
      if (process.argv.length !== 5) throw new Error("Usage");
      const directory = resolve(process.argv[3]);
      const candidate = JSON.parse(readFileSync(join(directory, "release.candidate.json"), "utf8"));
      verifySourceCheckouts(resolve(process.argv[4]), candidate.sources);
      const finalProof = JSON.parse(readFileSync(join(directory, "source-checks.final.json"), "utf8"));
      const approval = assertCandidateSourceApproval(finalProof, candidateSourceContext(finalProof, process.env));
      if (candidate.sourceApproval?.runId !== approval.runId || candidate.sourceApproval?.runAttempt !== approval.runAttempt ||
          JSON.stringify(candidate.sources) !== JSON.stringify(finalProof.sources)) throw new Error("Candidate source changed after harness");
      const reportBytes = readFileSync(join(directory, "container-harness.json"));
      const report = JSON.parse(reportBytes.toString("utf8"));
      const frontendReport = JSON.parse(readFileSync(join(directory, "frontend-migration-rehearsal.json"), "utf8"));
      writeFileSync(join(directory, "release.candidate.json"), JSON.stringify(qualifyHarness({ ...candidate, sourceApproval: approval }, report, reportBytes, frontendReport), null, 2) + "\n", { mode: 0o600 });
    } else {
      if (process.argv.length !== 4) throw new Error("Usage");
      collectArtifactCandidate(resolve(process.argv[2]), resolve(process.argv[3]));
    }
    process.stdout.write("Scanned, source-bound artifact candidate collected; deployment approval remains pending\n");
  } catch { process.stderr.write("Artifact candidate verification refused\n"); process.exitCode = 1; }
}

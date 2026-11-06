import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { p2IdentityFixtureFailureReceipt, parseP2DockerContextEndpoint,
  parseP2ForwardRecoveryPostgres18Receipt, parseP2IdentityProbeTap, parseP2LifecyclePersistencePostgres18Receipt,
  parseP2LifecycleReceiversPostgres18Receipt, buildP2InterruptedRestorationExpected, parseP2InterruptedRestorationPostgres18Receipt, parseP2InterruptedNegativesPostgres18Receipt,
  parseP2RecoveryPostgres18Receipt, prepareP2IdentityProbeFixtures,
  validateP2IdentityFixtureManifest, verifyP2FrontendSourceProof } from "./prepare-p2-identity-probe-fixtures.mjs";
import { P2_LIFECYCLE_OWNED_SOURCE_CLOSURE, P2_INTERRUPTED_OWNED_SOURCE_FILES, P2_KNOWN_ACK_OWNED_SOURCE_FILES,
  verifyP2LifecycleOwnedSourceManifest } from "./p2-lifecycle-owned-source-manifest.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const revisions = { course: "a447bfde20299e12afab68a3331b3792ddd07598", community: "939de65dd52f0b1a43993a25c7c428dce6e2bb43" };
const contents = { course: Buffer.from('{"openapi":"3.1.0","info":{"title":"course"}}\n'), community: Buffer.from('{"openapi":"3.1.0","info":{"title":"community"}}\n'),
  enrollmentEvent: Buffer.from('{"$schema":"https://json-schema.org/draft/2020-12/schema"}\n') };
const sourceReadToken = "fixture-source-token-value-not-secret";

function withSourceReadToken(value, operation) {
  const present = Object.hasOwn(process.env, "PLATFORM_SOURCE_READ_TOKEN");
  const previous = process.env.PLATFORM_SOURCE_READ_TOKEN;
  if (value === undefined) delete process.env.PLATFORM_SOURCE_READ_TOKEN;
  else process.env.PLATFORM_SOURCE_READ_TOKEN = value;
  try { return operation(); }
  finally {
    if (present) process.env.PLATFORM_SOURCE_READ_TOKEN = previous;
    else delete process.env.PLATFORM_SOURCE_READ_TOKEN;
  }
}

function withRunnerTemp(value, operation) {
  const present = Object.hasOwn(process.env, "RUNNER_TEMP");
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = value;
  try { return operation(); }
  finally {
    if (present) process.env.RUNNER_TEMP = previous;
    else delete process.env.RUNNER_TEMP;
  }
}

test("frontend source proof accepts only the two fixed actions/checkout HTTPS remote spellings", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "p2-frontend-source-proof-")));
  chmodSync(directory, 0o700);
  const environment = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const actualRun = (file, args, options) => spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: "utf8",
    timeout: options.timeout, stdio: ["ignore", "pipe", "pipe"] });
  const gitActual = args => execFileSync("git", args, { cwd: directory, env: environment, encoding: "utf8" }).trim();
  try {
    gitActual(["init", "--quiet", "."]);
    writeFileSync(join(directory, "README.md"), "owned source proof\n");
    gitActual(["add", "README.md"]);
    gitActual(["-c", "user.name=Owned Fixture", "-c", "user.email=owned@example.invalid", "commit", "--quiet", "-m", "owned"]);
    gitActual(["remote", "add", "origin", "https://github.com/princessdardan/lash-her-frontend"]);
    const revision = gitActual(["rev-parse", "HEAD"]), tree = gitActual(["rev-parse", "HEAD^{tree}"]);
    assert.match(revision, /^[a-f0-9]{40}$/u);
    assert.deepEqual(verifyP2FrontendSourceProof(actualRun, directory, revision, environment),
      { repository: "https://github.com/princessdardan/lash-her-frontend.git", gitTree: tree });
    gitActual(["remote", "set-url", "origin", "https://github.com/princessdardan/lash-her-frontend.git"]);
    assert.equal(verifyP2FrontendSourceProof(actualRun, directory, revision, environment).gitTree, tree);
    for (const remote of [
      "https://github.com/other/lash-her-frontend.git",
      "https://github.com/princessdardan/lash-her-frontend.git?ref=owned",
      "https://owned@github.com/princessdardan/lash-her-frontend.git",
      "https://github.com/princessdardan/lash-her-frontend/",
      "git@github.com:princessdardan/lash-her-frontend.git",
    ]) {
      gitActual(["remote", "set-url", "origin", remote]);
      assert.throws(() => verifyP2FrontendSourceProof(actualRun, directory, revision, environment),
        /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u, remote);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function fixtureManifest() {
  return { version: 1, status: "released", frontendBaseRevision: "a".repeat(40), boundarySha256: "b".repeat(64), readmeSha256: "c".repeat(64), artifacts: {
    course: { repository: "lash-her-course-api", revision: revisions.course, sourcePath: "openapi/course-api.json", file: "course-api.json", sha256: sha(contents.course) },
    community: { repository: "lash-her-community-api", revision: revisions.community, sourcePath: "openapi/community-api.json", file: "community-api.json", sha256: sha(contents.community) },
    enrollmentEvent: { repository: "lash-her-community-api", revision: revisions.community, sourcePath: "contracts/course-enrollment/v1/enrollment-event.schema.json",
      file: "enrollment-event.schema.json", sha256: sha(contents.enrollmentEvent) },
  } };
}

function tap(changes = {}) {
  const fields = { tests: 19, pass: 19, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...changes };
  return `TAP version 13\n1..${fields.tests}\n${Object.entries(fields).map(([name, value]) => `# ${name} ${value}`).join("\n")}\n`;
}

function recoveryReceipt(changes = {}) {
  const apiFaults = ["runtime-inbound", "migration-inbound", "runtime-outbound", "sequence-update", "table-trigger", "table-references",
    "default-unexpected-grantee", "default-sequence-update", "global-default", "table-grant-option", "default-grant-option"];
  const privilegeFaults = ["frontend-runtime-inbound", "frontend-runtime-outbound", "frontend-runtime-rogue-admin", "frontend-owner-inbound",
    "frontend-owner-outbound", "frontend-sequence-update", "frontend-default-unexpected-grantee", "frontend-global-default",
    "frontend-table-grant-option", "frontend-default-grant-option", "frontend-table-references", "frontend-table-trigger",
    "frontend-operator-superuser", "frontend-runtime-role-settings", "frontend-runtime-rogue-ownership",
    "frontend-runtime-database-settings", "frontend-runtime-public-schema-access",
    ...["course", "community"].flatMap(service => apiFaults.map(fault => `${service}-${fault}`))].sort();
  return JSON.stringify({ status: "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS", serverMajor: 18, frontendMigrations: 83,
    courseMigrations: 22, communityMigrations: 11, checks: 55, skipped: 0, fixtureOnly: true, providerTouched: false,
    privilegeFaults, frontendInitialPrivilegeRefusals: 17, frontendContinuousPrivilegeRefusals: 17, apiPrivilegeRefusals: 22,
    legacyApiVerifierRefusals: 2, frontendCreatorPolicy: "actual-non-superuser-automatic-admin-plus-explicit-owner-set",
    frontendCreatorMemberships: 3, frontendOperatorSearchPathPinned: true,
    environmentIsolation: { nodeOptionsPositiveControlExecuted: true, poisonedParentEnvironment: true,
      ambientNodeOptionsExecuted: false, ambientConfigVariablesAbsent: true, childEnvironmentAllowlistEnforced: true },
    noSqlReplay: true, originalFrontendTerminalRecreated: false,
    ...changes }) + "\n";
}

function forwardRecoveryReceipt(changes = {}) {
  return JSON.stringify({ status: "OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS", serverMajor: 18, frontendMigrations: 83,
    courseMigrations: 22, communityMigrations: 11,
    checks: ["actual-fe-physical-session", "both-api-current-readonly", "actual-tls-build-probe-promote", "same-source-candidate-new-action",
      "real-opaque-scope-shared-observer", "selected-workload-bytes", "cloned-plain-scope-refused", "wrong-client-verifier-refused",
      "wrong-plan-candidate-target-directory-refused", "wrong-inventory-action-refused", "shared-mutation-operations-refused",
      "receipt-drift-refused", "expired-session-refused", "open-admission-mutation-refused", "opened-admission-get-retained",
      "original-terminal-retained-not-current", "original-receipts-preserved", "actual-runtime-credential-tls-physical-binding",
      "bad-runtime-credential-and-foreign-physical-refused"],
    mutationRefusals: 1, noSqlReplay: true, journalDigestsUnchanged: true, originalFrontendTerminalRecreated: false,
    runtimeCredentialRefusals: 9, foreignRuntimeTlsAuthenticated: true, runtimeCredentialFaultProviderCalls: 0,
    skipped: 0, fixtureOnly: true, providerTouched: false, actualRuntimeContainers: false,
    environmentIsolation: { nodeOptionsPositiveControlExecuted: true, poisonedParentEnvironment: true,
      ambientNodeOptionsExecuted: false, ambientConfigVariablesAbsent: true, childEnvironmentAllowlistEnforced: true },
    ...changes }) + "\n";
}

function lifecyclePersistenceReceipt(manifestBytes, changes = {}) {
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceSha256 = Object.fromEntries(["p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs",
    "p2-lifecycle-owned-source-manifest.mjs", "harness/owned-p2-lifecycle-persistence.mjs", "test-p2-lifecycle-persistence-local.mjs"]
    .map(name => [name, manifest.sources.frontend.files[`ops/platform/${name}`]]));
  return JSON.stringify({ version: 1, status: "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES18_PASS", postgresMajor: 18,
    frontendMigrations: 83, courseMigrations: 22, communityMigrations: 11,
    sourceCommits: Object.fromEntries(Object.entries(manifest.sources).map(([service, source]) => [service, source.revision])),
    checks: ["actual-three-domain-export-ready-observed", "actual-24-hour-schema-bound-export-scrub-observed",
      "actual-delete-field-removal-and-retention-observed", "wrong-original-email-refused", "missing-receiver-ack-refused",
      "identified-attempt-refused", "retained-community-export-refused", "common-output-private-values-absent",
      "requested-command-version-refused", "unlisted-account-attempt-refused", "expired-ready-export-refused",
      "missing-export-history-refused", "cross-bound-prior-refused"],
    skipped: 0, readOnly: true, fixtureOnly: true, providerTouched: false, liveCertification: false,
    sourceMode: "parent-issued-manifest-and-mounted-readback", sourceManifestSha256: sha(manifestBytes), sourceSha256, ...changes }) + "\n";
}

function lifecycleReceiversReceipt(manifestBytes, changes = {}) {
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceSha256 = Object.fromEntries(["p2-lifecycle-state-witness.mjs", "p2-lifecycle-persistence-probe.mjs",
    "p2-lifecycle-receiver-post.mjs", "p2-lifecycle-owned-source-manifest.mjs", "p2-lifecycle-receiver-negatives.mjs",
    "harness/owned-p2-lifecycle-receivers.mjs", "test-p2-lifecycle-receivers-local.mjs"]
    .map(name => [name, manifest.sources.frontend.files[`ops/platform/${name}`]]));
  return JSON.stringify({ version: 1, status: "P2_LIFECYCLE_RECEIVER_OWNED_POSTGRES18_PASS", postgresMajor: 18,
    frontendMigrations: 83, courseMigrations: 22, communityMigrations: 11,
    sourceCommits: Object.fromEntries(Object.entries(manifest.sources).map(([service, source]) => [service, source.revision])),
    checks: ["actual-source-both-receivers-accept-canonical-suspend-over-verified-tls",
      ...["course", "community"].flatMap(service => ["exact-replay", "changed-replay", "stale-restore", "future-gap"]
        .map(caseName => `${service}-${caseName}-actual-status-and-three-domain-unchanged`)),
      "actual-durable-quotas-write-with-account-domain-digests-unchanged",
      "actual-unauthorized-responses-cannot-qualify-negative-case",
      "actual-terminal-delete-refuses-restore-and-preserves-exact-old-replay"],
    httpCaseCount: 8, skipped: 0, domainStatePreserving: true, globallyReadOnly: false, quotaWritesObserved: true,
    deployedFutureGapQualified: false, hostDockerPathQualified: false, fixtureOnly: true, providerTouched: false,
    liveCertification: false, sourceMode: "parent-issued-manifest-and-mounted-readback",
    sourceManifestSha256: sha(manifestBytes), sourceSha256, ...changes }) + "\n";
}

// Actual owned PG18 positive from C d5ee9bee, SHA256
// 758c9690999f214ae438db105e72dcaa9ff0bbf80b93fdbbe23b3d4dec295eec.
// This retained database/fixture receipt makes no Linux Docker or live release claim.
const retainedInterruptedReceipt = {"version":1,"status":"P2_KNOWN_ACK_WHOLE_ROUTE_PASS","actualAppCron":true,"actualDispatcher":true,"actualTlsGateway":true,"actualTlsReceivers":true,"actualCanonicalApiReceivers":true,"actualThreeDatabaseDomainProof":true,"actualTlsPostgres":true,"actualProvider":false,"modeledOidc":true,"firstHttpStatus":503,"firstFrontendLedgerState":"uncertain","firstFrontendUncertain":1,"firstGatewayUncertain":1,"firstDeliveries":[{"receiver":"community","status":"acknowledged","attempts":1,"lease_id":null,"lease_until":null},{"receiver":"course","status":"pending","attempts":1,"lease_id":null,"lease_until":null}],"replayHttpStatus":200,"finalFrontendUncertain":1,"finalGatewayUncertain":1,"finalDeliveries":[{"receiver":"community","status":"acknowledged","attempts":1,"lease_id":null,"lease_until":null},{"receiver":"course","status":"acknowledged","attempts":2,"lease_id":null,"lease_until":null}],"sourceTraceMatchesOperation":true,"settledFrontendUncertain":0,"specificFrontendOperationReconciled":true,"gatewayCounterReset":false,"domainProofSha256":"25ac365409cb5749aa719167fd5b4e9f2229dceb489fa000e968c90e125c55aa","canonicalFaultRefusals":2,"immutableReceiptRewriteRefusals":2,"sourceDomainReducer":{"status":"P2_KNOWN_ACK_SOURCE_DOMAIN_REDUCER_PASS","faultRefusals":11,"backendFaultRefusals":21,"plainReceiptAuthorityRefused":true,"authorityIssued":false},"sourceSettlementReducer":{"status":"P2_KNOWN_ACK_SPECIFIC_SETTLEMENT_REDUCER_PASS","extraCompletedOperationRefused":true,"authorityIssued":false},"backendEligibility":{"actualReadOnlyProjections":true,"sourceSchedulerBaseline":true,"sourceRetentionBaseline":true,"faultRefusals":21,"faultNames":["missing-scheduler-receipts","community-retention-schedule-horizon","missing-course-control","projection-completeness-bound","future-course-outbox","course-outbox-lease","completed-course-effect-projection","course-snapshot-work","course-snapshot-expiry-horizon","course-retention-horizon","course-media-horizon","course-export-expiry-horizon","community-export-expiry-horizon","future-community-repair","completed-community-effect-projection","community-reconciliation-work","community-reconciliation-schedule-horizon","unrelated-course-lifecycle-command","unrelated-community-lifecycle-command","unrelated-course-mutable-lifecycle-state","unrelated-community-mutable-lifecycle-state"],"entireParentHorizonSeconds":900,"liveWorkerProcesses":false},"journalSha256Before":{"frontend":"79216f67827004f1cb69a623110a07d11568c84c73b61e2e7d56d078c1a48dab","course":"e8a23391c277425f8a18b2e05381dfce12baf5139036d92a3f3e7602ef84d899","community":"b6487653c641c14c3f237d30f7d8c50c21738e0c7c769b89afacdd44ed575e9a"},"journalSha256After":{"frontend":"79216f67827004f1cb69a623110a07d11568c84c73b61e2e7d56d078c1a48dab","course":"e8a23391c277425f8a18b2e05381dfce12baf5139036d92a3f3e7602ef84d899","community":"b6487653c641c14c3f237d30f7d8c50c21738e0c7c769b89afacdd44ed575e9a"},"allThreeJournalsUnchanged":true,"noSqlReplay":true,"noRoleChange":true,"noRuntimeRestart":true,"fixtureOnly":true,"restoration":{"status":"P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS","serverMajor":18,"migrations":{"frontend":83,"course":22,"community":11},"actualThreeDatabases":true,"actualTlsScram":true,"oldProcessExited":true,"oldBackendEnded":true,"newFrontendBackend":true,"newHostProcess":true,"actualHostFlock":true,"newSourceCapability":true,"oldOneRetained":true,"newZeroVerifiedInProjectedRuntime":true,"allTenSourceStages":true,"allThreeJournalsUnchanged":true,"sqlReplayed":false,"frontendReadinessVerified":false,"trafficAuthorized":false,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"requestCount":6286,"originalCausalReceiptSha256":{"recovery-intent.json":"922c29f078984430837dbad929d4d2f97a7ff67bf3523075b85957c645781847","baseline.json":"c37d0d030688b78b91a2833fe7ad65be3698f91c659d5242b0e68e09f65d2256","request-details.json":"2da96bba01e232bcbbd956586aa4879d1c4a52f728e156155367ea7387e1f319","domain.json":"300e91def08eb96d78bd932572b9f27774fcf52cc445850e60f5f0fa24ffe13f","settlement.json":"83a4b5d6e81f10377656c15f58aa11d6415f7fc3b10e8b8766113f4339afd48a","replacement-authorization.json":"1ac058e3cd8678afc4b5610f13b5d6a77ea6f423c5809676342a61a53ac7c9b3"},"terminalReceiptSha256":"4f43fc7e1cdff184cc341f611140e01676a8dec51ba138632c8936f1b72654c5","terminalReceipt":{"status":"P2_KNOWN_ACK_INTERRUPTED_RUNTIME_RESTORED_FENCED","environment":"staging","releaseId":"owned-known-ack","recoveryActionId":"owned-interrupted-restoration-c","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","apiDatabases":{"course":{"version":1,"status":"P2_RECOVERY_API_DATABASE_CURRENT","service":"lash-her-course-api","environment":"staging","releaseId":"owned-known-ack","sourceCommit":"a447bfde20299e12afab68a3331b3792ddd07598","migrationImageDigest":"sha256:3333333333333333333333333333333333333333333333333333333333333333","runtimeImageDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444","schemaBaselineSha256":"1a176b23c239e94dd7f3de49073c4c01a4c0560ebf9db37ec954c6d2f457e553","contractSha256":"7777777777777777777777777777777777777777777777777777777777777777","contractPhase":"p2","phase2ContractManifestSha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","recoveryActionId":"owned-interrupted-restoration-c","journalSha256":"e8a23391c277425f8a18b2e05381dfce12baf5139036d92a3f3e7602ef84d899","artifactSha256":"9dda27357f6bf42bd8232f91c027e8d9ec67b7f8b977bd88ea58a3f1960b4749","pendingTags":[],"readOnlyVerified":true,"schemaVerified":true,"runtimeRoleVerified":true,"sqlReplayed":false},"community":{"version":1,"status":"P2_RECOVERY_API_DATABASE_CURRENT","service":"lash-her-community-api","environment":"staging","releaseId":"owned-known-ack","sourceCommit":"939de65dd52f0b1a43993a25c7c428dce6e2bb43","migrationImageDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555","runtimeImageDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666","schemaBaselineSha256":"38f62c85f007cb57f66fec6243cd66fdf6134dd0a8a1d0e9801bdd1e3758da99","contractSha256":"7777777777777777777777777777777777777777777777777777777777777777","contractPhase":"p2","phase2ContractManifestSha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","recoveryActionId":"owned-interrupted-restoration-c","journalSha256":"b6487653c641c14c3f237d30f7d8c50c21738e0c7c769b89afacdd44ed575e9a","artifactSha256":"58d3f193626720d700da9b07babd32792731e5ed670789ea043a2d094050e851","pendingTags":[],"readOnlyVerified":true,"schemaVerified":true,"runtimeRoleVerified":true,"sqlReplayed":false}},"containers":[{"service":"community-api","containerId":"00000000000000000000000000000000000000000000000000000000000007d0","image":"ghcr.io/princessdardan/owned-communityruntime@sha256:6666666666666666666666666666666666666666666666666666666666666666","health":"healthy"},{"service":"course-api","containerId":"00000000000000000000000000000000000000000000000000000000000007d1","image":"ghcr.io/princessdardan/owned-courseruntime@sha256:4444444444444444444444444444444444444444444444444444444444444444","health":"healthy"},{"service":"community-tls","containerId":"00000000000000000000000000000000000000000000000000000000000007d2","image":"ghcr.io/princessdardan/owned-gateway@sha256:1111111111111111111111111111111111111111111111111111111111111111","health":"none"},{"service":"course-tls","containerId":"00000000000000000000000000000000000000000000000000000000000007d3","image":"ghcr.io/princessdardan/owned-gateway@sha256:1111111111111111111111111111111111111111111111111111111111111111","health":"none"},{"service":"course-snapshot","containerId":"00000000000000000000000000000000000000000000000000000000000007d4","image":"ghcr.io/princessdardan/owned-courseruntime@sha256:4444444444444444444444444444444444444444444444444444444444444444","health":"healthy"},{"service":"community-worker","containerId":"00000000000000000000000000000000000000000000000000000000000007d5","image":"ghcr.io/princessdardan/owned-communityruntime@sha256:6666666666666666666666666666666666666666666666666666666666666666","health":"healthy"},{"service":"course-media","containerId":"00000000000000000000000000000000000000000000000000000000000007d6","image":"ghcr.io/princessdardan/owned-courseruntime@sha256:4444444444444444444444444444444444444444444444444444444444444444","health":"healthy"},{"service":"course-export-cleanup","containerId":"00000000000000000000000000000000000000000000000000000000000007d7","image":"ghcr.io/princessdardan/owned-courseruntime@sha256:4444444444444444444444444444444444444444444444444444444444444444","health":"healthy"},{"service":"course-publisher","containerId":"00000000000000000000000000000000000000000000000000000000000007d8","image":"ghcr.io/princessdardan/owned-courseruntime@sha256:4444444444444444444444444444444444444444444444444444444444444444","health":"healthy"},{"service":"gateway","containerId":"00000000000000000000000000000000000000000000000000000000000007d9","image":"ghcr.io/princessdardan/owned-gateway@sha256:1111111111111111111111111111111111111111111111111111111111111111","health":"healthy"}],"boundaryChecks":["private-application-credential-required","private-community-peer-denied","private-course-tls-catalog","public-metrics-hidden","public-tls-missing-workload-denied"],"sqlReplayed":false,"rolePreparationRepeated":false,"trafficAuthorized":false,"contractPhase":"p2","phase2ContractManifestSha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","restorationActionId":"owned-interrupted-restoration-c","originalCertificationActionId":"owned-b-certification","originalRecoveryActionId":"owned-b-replacement","oldGateway":{"admission":{"active":{"newWork":0,"recovery":0},"newWork":false,"recovery":false,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uncertain":{"newWork":0,"recovery":1}},"binding":{"candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","configurationDirectory":"/private/tmp/p2-known-ack-owned-tUfXSf/c-operator/root/original-runtime/configuration","gatewayConfigurationSha256":"d4aa15cfd32d069ef2f56e4fd10990ef011b6e4c9d5164b820104d8c1a3788dd","gatewayImage":"ghcr.io/princessdardan/owned-gateway@sha256:1111111111111111111111111111111111111111111111111111111111111111","hostMachineId":"11111111111111111111111111111111","releaseId":"owned-known-ack","runtimeConfigurationSha256":"3672805edb06a4c6a886c684568fccf934f43e57a0e0e79fdb5f306cbc000856"},"process":{"containerId":"000000000000000000000000000000000000000000000000000000000000000a","imageId":"sha256:1111111111111111111111111111111111111111111111111111111111111111","pid":88949,"restartCount":0,"running":true,"startedAt":"2026-11-06T01:00:00.000000000Z"},"status":"PRIOR_GATEWAY_OBSERVED"},"newGateway":{"status":"PRIOR_GATEWAY_OBSERVED","binding":{"releaseId":"owned-known-ack","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","hostMachineId":"11111111111111111111111111111111","gatewayImage":"ghcr.io/princessdardan/owned-gateway@sha256:1111111111111111111111111111111111111111111111111111111111111111","runtimeConfigurationSha256":"3672805edb06a4c6a886c684568fccf934f43e57a0e0e79fdb5f306cbc000856","gatewayConfigurationSha256":"d4aa15cfd32d069ef2f56e4fd10990ef011b6e4c9d5164b820104d8c1a3788dd","configurationDirectory":"/private/tmp/p2-known-ack-owned-tUfXSf/c-operator/root/runtime-recovery-owned-interrupted-restoration-c/configuration"},"process":{"containerId":"00000000000000000000000000000000000000000000000000000000000007d9","imageId":"sha256:1111111111111111111111111111111111111111111111111111111111111111","running":true,"pid":2009,"startedAt":"2026-11-06T01:00:00.000000000Z","restartCount":0},"admission":{"newWork":false,"recovery":false,"active":{"newWork":0,"recovery":0},"uncertain":{"newWork":0,"recovery":0},"sha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}},"apiDatabasesAfter":{"course":{"version":1,"status":"P2_RECOVERY_API_DATABASE_CURRENT","service":"lash-her-course-api","environment":"staging","releaseId":"owned-known-ack","sourceCommit":"a447bfde20299e12afab68a3331b3792ddd07598","migrationImageDigest":"sha256:3333333333333333333333333333333333333333333333333333333333333333","runtimeImageDigest":"sha256:4444444444444444444444444444444444444444444444444444444444444444","schemaBaselineSha256":"1a176b23c239e94dd7f3de49073c4c01a4c0560ebf9db37ec954c6d2f457e553","contractSha256":"7777777777777777777777777777777777777777777777777777777777777777","contractPhase":"p2","phase2ContractManifestSha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","recoveryActionId":"owned-interrupted-restoration-c","journalSha256":"e8a23391c277425f8a18b2e05381dfce12baf5139036d92a3f3e7602ef84d899","artifactSha256":"9dda27357f6bf42bd8232f91c027e8d9ec67b7f8b977bd88ea58a3f1960b4749","pendingTags":[],"readOnlyVerified":true,"schemaVerified":true,"runtimeRoleVerified":true,"sqlReplayed":false},"community":{"version":1,"status":"P2_RECOVERY_API_DATABASE_CURRENT","service":"lash-her-community-api","environment":"staging","releaseId":"owned-known-ack","sourceCommit":"939de65dd52f0b1a43993a25c7c428dce6e2bb43","migrationImageDigest":"sha256:5555555555555555555555555555555555555555555555555555555555555555","runtimeImageDigest":"sha256:6666666666666666666666666666666666666666666666666666666666666666","schemaBaselineSha256":"38f62c85f007cb57f66fec6243cd66fdf6134dd0a8a1d0e9801bdd1e3758da99","contractSha256":"7777777777777777777777777777777777777777777777777777777777777777","contractPhase":"p2","phase2ContractManifestSha256":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","candidateSha256":"dca3a9a3b852e3d65a183d1a6c7fc6f2c9e51d87335882bd8db84989d9bdbe76","recoveryActionId":"owned-interrupted-restoration-c","journalSha256":"b6487653c641c14c3f237d30f7d8c50c21738e0c7c769b89afacdd44ed575e9a","artifactSha256":"58d3f193626720d700da9b07babd32792731e5ed670789ea043a2d094050e851","pendingTags":[],"readOnlyVerified":true,"schemaVerified":true,"runtimeRoleVerified":true,"sqlReplayed":false}},"originalGatewayUncertaintyPreserved":true,"ordinaryClosedZeroGate":false,"runtimeReplacements":1,"nativeDisabled":true,"frontendReadinessVerified":false,"frontendWorkloadProbePerformed":false,"originalTerminalRecreated":false,"frontendJournalSha256":"79216f67827004f1cb69a623110a07d11568c84c73b61e2e7d56d078c1a48dab","originalCausalReceiptSha256":{"recovery-intent.json":"922c29f078984430837dbad929d4d2f97a7ff67bf3523075b85957c645781847","baseline.json":"c37d0d030688b78b91a2833fe7ad65be3698f91c659d5242b0e68e09f65d2256","request-details.json":"2da96bba01e232bcbbd956586aa4879d1c4a52f728e156155367ea7387e1f319","domain.json":"300e91def08eb96d78bd932572b9f27774fcf52cc445850e60f5f0fa24ffe13f","settlement.json":"83a4b5d6e81f10377656c15f58aa11d6415f7fc3b10e8b8766113f4339afd48a","replacement-authorization.json":"1ac058e3cd8678afc4b5610f13b5d6a77ea6f423c5809676342a61a53ac7c9b3"}},"elapsedSeconds":146,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},"postgresMajor":18,"migrations":{"frontend":83,"course":22,"community":11},"frontendSourceCommit":"d5ee9bee1d3ef6ba23774bb41883eb3c8fb605c7","apiSourceCommits":{"course":"a447bfde20299e12afab68a3331b3792ddd07598","community":"939de65dd52f0b1a43993a25c7c428dce6e2bb43"},"apiSourceArchives":{"course":{"sha256":"84ff026ee80024fc0890e2ade42a692c5cf2072010aa428b6472e34d46702d51","lockSha256":"0153a941a3e767889cc356b1d3cc72823b03a7d46f97fd07f66b7e53f3e8c8fa"},"community":{"sha256":"616d8f504481ab24d4335bce3ebdd42b9ff2bc75f2ec47321b48d56d42ea14d1","lockSha256":"03e332482b3f4d4f1a572a8ba00d79a0e7d9a27497e67973103fbdc2833e4bfe"}},"fixtureSourceSha256":{"p2-known-ack-loss-probe.mjs":"1b685b6c2ea7c40bb129f92d05fb88a3a81eceb2a90f3fec90d9239a451c7991","host/p2_known_ack_loss.py":"445fe8aba68bb4e708e4777c936466f6c5fd54b5500f7160664cf43cd1ddf3db","harness/owned-p2-known-ack-loss.mjs":"eb1149fd634e263d04c421ccf92fd3ec9362432eaf11a14db080d771e8c0d8fe","harness/owned-phase2-lifecycle-receiver.mjs":"65e9e483cb4eba3b1804ac4725d15e0ffea13fa6703a7af877f9882129fc3c44"},"sqlArtifactSha256":"28c060a68f5651ceddf3bc8d16c70778d11c613657e93f5cfc9f43fa6d1ad9ef","actualVercelNativeEvidence":false,"providerTouched":false};
// Actual C d5ee9bee PostgreSQL 18 seven-case fixed --negative-cases command.
// Raw SHA256 5fedd2f860724846ca2235faf19e9b69c1472c3fa329ff9393481957465629d8; no Docker/live claim.
const retainedInterruptedNegatives = {"version":1,"status":"P2_INTERRUPTED_NEGATIVES_OWNED_PASS","serverMajor":18,"cases":[{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"original-bytes","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":false,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":false,"cleanedNamespaces":[],"nativeDisabled":null,"oldOneRetained":true,"runtimeStopped":null,"upCommands":0,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":17,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"original-config-drift","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":false,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":false,"cleanedNamespaces":[],"nativeDisabled":null,"oldOneRetained":true,"runtimeStopped":null,"upCommands":0,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":34,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"missing-lineage","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":false,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":false,"cleanedNamespaces":[],"nativeDisabled":null,"oldOneRetained":true,"runtimeStopped":null,"upCommands":0,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":51.4,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"pending-lineage","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":false,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":false,"cleanedNamespaces":[],"nativeDisabled":null,"oldOneRetained":true,"runtimeStopped":null,"upCommands":0,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":68.8,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"backend-effect","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":true,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":false,"cleanedNamespaces":["certification","recovery"],"nativeDisabled":true,"oldOneRetained":true,"runtimeStopped":true,"upCommands":0,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":87.2,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"active-backend-loss","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":true,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":false,"authorityIssued":true,"cleanedNamespaces":["certification","recovery"],"nativeDisabled":true,"oldOneRetained":true,"runtimeStopped":true,"upCommands":1,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":131,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}},{"status":"P2_INTERRUPTED_NEGATIVE_OWNED_PASS","case":"active-guard-loss","actualThreeDatabases":true,"actualTlsScram":true,"newHostProcess":true,"newFrontendBackend":true,"actualHostFlock":true,"Bterminal":false,"Cterminal":false,"actualGuardWriterExited":true,"authorityIssued":true,"cleanedNamespaces":["certification","recovery"],"nativeDisabled":true,"oldOneRetained":true,"runtimeStopped":true,"upCommands":1,"allThreeJournalsUnchanged":true,"providerTouched":false,"actualDocker":false,"runtimeTransportProjected":true,"frontendReadinessVerified":false,"trafficAuthorized":false,"elapsedSeconds":173.7,"ownedSourceSha256":{"ops/platform/p2-known-ack-interrupted-restoration.mjs":"001de53a81d592b8b814a74d6f16aca3075ecf071509a6b5d5117c257062f802","ops/platform/host/p2_known_ack_interrupted_restoration.py":"a0801a1ea55cba4a9d792f7804bf73b7a954bcfff0c9288dc17f473f61e42c90","ops/platform/host/p2_release_broker.py":"e38083aee97c89ffe24ed207d0dde3a7e094662629d68b852b87bbdc2d7cab6d","ops/platform/host/p2_release_supervisor.py":"349ddaaf2eb1206b864daf147fd21283f52813ec678b17f0ed05e38ade18151a","ops/gateway/server.mjs":"3ea145d46ca3a6705f28e8fe7212f6678da87cfd203838b5b975deaee4b4169d","ops/gateway/p2-certification-fault.mjs":"bd1d0e69d897df1d2360111863750b7c7823bb0b04a13aeb9e295191341b7c52","ops/gateway/package.json":"753a5bbda9e38709e3bfc7105b2e3f5bffdf0c52cb391eadbf26b41bab3c0805","ops/gateway/package-lock.json":"def7176c2a73e5686d87ae37c4fb299c5dd99835233a29ed6740e2215a27b5d0","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs":"2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-process.mjs":"8f67f020f4e01005ebfd4bb9e8718d80f8ac82dbc52672098fa1ff92584710a7","docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/owned-engine.py":"a582e062865f96191a2171ce110301b361bf96cc1268d68302d4749555a68314"},"gatewayDependency":{"package":"jose","version":"6.2.3","resolution":"ops/gateway/node_modules/jose","packageSha256":"cbd17f658085419b9ee540e78e40cbe4d4f7916a51578af1d650c84d49525fdf"}}],"elapsedSeconds":173.7};
function interruptedNegativeOutput(expected) {
  const value = structuredClone(retainedInterruptedNegatives);
  for (const row of value.cases) { row.ownedSourceSha256 = structuredClone(expected.ownedSourceSha256); row.gatewayDependency = structuredClone(expected.gatewayDependency); }
  return JSON.stringify(value) + "\n";
}
function interruptedExpected(root, workspace) {
  return buildP2InterruptedRestorationExpected(root, { revision: "d".repeat(40) }, Object.fromEntries(["course", "community"].map(service =>
    [service, { revision: revisions[service], packageLockSha256: sha(readFileSync(join(workspace, `lash-her-${service}-api/package-lock.json`))) }])));
}
function interruptedReceipt(expected) {
  const value = structuredClone(retainedInterruptedReceipt), restored = value.restoration, terminal = restored.terminalReceipt;
  value.frontendSourceCommit = expected.frontendSourceCommit; value.apiSourceCommits = structuredClone(expected.apiSourceCommits);
  for (const service of ["course", "community"]) value.apiSourceArchives[service].lockSha256 = expected.apiSourceLocks[service];
  value.fixtureSourceSha256 = structuredClone(expected.fixtureSourceSha256);
  restored.ownedSourceSha256 = structuredClone(expected.ownedSourceSha256); restored.gatewayDependency = structuredClone(expected.gatewayDependency);
  const candidateSha256 = sha(JSON.stringify(expected.candidate) + "\n"); terminal.candidateSha256 = candidateSha256;
  for (const service of ["course", "community"]) terminal.apiDatabases[service].candidateSha256 = candidateSha256;
  terminal.apiDatabasesAfter = structuredClone(terminal.apiDatabases);
  terminal.oldGateway.binding.candidateSha256 = terminal.newGateway.binding.candidateSha256 = candidateSha256;
  restored.terminalReceiptSha256 = sha(JSON.stringify(terminal) + "\n");
  return value;
}
function interruptedOutput(root, workspace) { return JSON.stringify(interruptedReceipt(interruptedExpected(root, workspace))) + "\n"; }

function populateSourceClosure(root, service) {
  const closure = service === "frontend" ? P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.frontend : P2_LIFECYCLE_OWNED_SOURCE_CLOSURE.api;
  for (const directory of closure.directories) {
    mkdirSync(join(root, directory), { recursive: true });
    const marker = join(root, directory, "README.md");
    if (!existsSync(marker)) writeFileSync(marker, `${service} ${directory}\n`);
  }
  for (const name of closure.files) {
    const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `${service} ${name}\n`);
  }
  mkdirSync(join(root, "node_modules"), { recursive: true });
}

// Recreate only the files selected by the real readonly descriptors. This tests
// child source-manifest verification against the mounted filesystem projection,
// rather than incorrectly verifying the parent's complete source tree.
function verifyProjectedLifecycleMounts(manifestBytes, args) {
  const projection = realpathSync(mkdtempSync(join(tmpdir(), "p2-lifecycle-mount-projection-")));
  try {
    for (const [index, argument] of args.entries()) {
      if (args[index - 1] !== "--mount") continue;
      const fields = Object.fromEntries(argument.split(",").filter(value => value.includes("=")).map(value => value.split("=")));
      assert.equal(argument.endsWith(",readonly"), true);
      assert.equal(fields.type, "bind");
      assert.match(fields.dst, /^\/(?:source|exact-sources)\//u);
      const target = join(projection, fields.dst.slice(1));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(fields.src, target, { recursive: true, dereference: false });
    }
    return verifyP2LifecycleOwnedSourceManifest(manifestBytes, { frontend: join(projection, "source"),
      course: join(projection, "exact-sources/lash-her-course-api"), community: join(projection, "exact-sources/lash-her-community-api") });
  } finally { rmSync(projection, { recursive: true, force: true }); }
}

function harness(testOutput = tap(), ignoredFrontendOutputs = [], trackedDependencyRoots = ["ops/gateway", "tools/api-contract-toolchain"], settings = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-prep-root-")));
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-prep-work-")));
  chmodSync(root, 0o700); chmodSync(workspace, 0o700);
  for (const directory of ["contracts/api-integration/p2-candidate", "contracts/api-integration/v1", "ops/platform", "ops/gateway", "drizzle",
    "node_modules", "src", "scripts", ".git"]) mkdirSync(join(root, directory), { recursive: true });
  populateSourceClosure(root, "frontend");
  for (const name of [...P2_INTERRUPTED_OWNED_SOURCE_FILES, ...P2_KNOWN_ACK_OWNED_SOURCE_FILES.map(name => `ops/platform/${name}`),
    "ops/platform/compose.yaml"]) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, `fixed interrupted fixture ${name}\n`);
  }
  writeFileSync(join(root, "contracts/api-integration/p2-candidate/manifest.json"), JSON.stringify(fixtureManifest()));
  writeFileSync(join(root, "ops/platform/test-p2-recovery-owned.py"), "# owned fixture\n");
  writeFileSync(join(root, "ops/platform/test-p2-recovery-owned.mjs"), "// owned fixture\n");
  writeFileSync(join(root, "ops/gateway/routes.json"), "{}\n");
  writeFileSync(join(root, "ops/gateway/package.json"), JSON.stringify({ name: "lash-her-gateway", dependencies: { jose: "6.2.3" } }));
  writeFileSync(join(root, "ops/gateway/package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/jose": { version: "6.2.3" } } }));
  mkdirSync(join(root, "ops/gateway/node_modules/jose"), { recursive: true });
  writeFileSync(join(root, "ops/gateway/node_modules/jose/package.json"), JSON.stringify({ name: "jose", version: "6.2.3" }));
  writeFileSync(join(root, "ops/gateway/node_modules/jose/index.js"), "// owned dependency-resolution fixture\n");

  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  const calls = [];
  let capturedInterruptedExpected;
  const dockerModes = [];
  const dockerSocketPath = join(workspace, "docker.sock");
  const dockerSocketStat = path => {
    if (path !== dockerSocketPath || settings.dockerSocketMissing === true) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid() };
  };
  const run = (file, args, options) => {
    calls.push({ file, args: [...args], cwd: options.cwd, env: { ...options.env }, input: options.input });
    const ok = stdout => ({ status: 0, signal: null, stdout, stderr: "" });
    if (file === "npm" && args[0] === "--version") return ok("11.7.0\n");
    if (file === "npm") return ok("");
    if (file === "docker") {
      if (args[0] === "context") return ok(settings.dockerContextOutput ?? JSON.stringify(`unix://${dockerSocketPath}`) + "\n");
      dockerModes.push({ workspace: lstatSync(workspace).mode & 0o777,
        course: lstatSync(join(workspace, "lash-her-course-api")).mode & 0o777,
        community: lstatSync(join(workspace, "lash-her-community-api")).mode & 0o777 });
      if (args.includes("--postgres18-manifest")) {
        const courseSource = join(workspace, "lash-her-course-api/src/README.md");
        if (settings.persistenceSourceMutation === "hash") writeFileSync(courseSource, "drift\n");
        if (settings.persistenceSourceMutation === "extra") writeFileSync(join(workspace, "lash-her-course-api/src/owned-extra.ts"), "extra\n");
        if (settings.persistenceSourceMutation === "missing") rmSync(courseSource);
        try {
          verifyProjectedLifecycleMounts(options.input, args);
        } catch {
          return { status: 1, signal: null, stdout: "private-source-refusal", stderr: "private-source-refusal" };
        }
        const receivers = args.includes("ops/platform/test-p2-lifecycle-receivers-local.mjs"), prefix = receivers ? "receivers" : "persistence";
        return settings[`${prefix}Result`] ?? { status: settings[`${prefix}Status`] ?? 0, signal: settings[`${prefix}Signal`] ?? null,
          stdout: settings[`${prefix}Output`] ?? (receivers ? lifecycleReceiversReceipt(options.input) : lifecyclePersistenceReceipt(options.input)),
          stderr: settings[`${prefix}Stderr`] ?? "" };
      }
      if (args.includes("docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs")) {
        capturedInterruptedExpected = interruptedExpected(root, workspace);
        const negative = args.at(-1) === "--negative-cases", prefix = negative ? "interruptedNegative" : "interrupted";
        const stdout = settings[`${prefix}Output`] ?? (negative ? interruptedNegativeOutput(capturedInterruptedExpected) : interruptedOutput(root, workspace));
        if (settings[`${prefix}SourceMutation`]) writeFileSync(join(root, "ops/gateway/package-lock.json"), "changed after C\n");
        return settings[`${prefix}Result`] ?? { status: settings[`${prefix}Status`] ?? 0, signal: settings[`${prefix}Signal`] ?? null,
          stdout, stderr: settings[`${prefix}Stderr`] ?? "" };
      }
      const forward = args.at(-1) === "--forward-brand", prefix = forward ? "forwardRecovery" : "recovery";
      return settings[`${prefix}Result`] ?? { status: settings[`${prefix}Status`] ?? 0, signal: settings[`${prefix}Signal`] ?? null,
        stdout: settings[`${prefix}Output`] ?? (forward ? forwardRecoveryReceipt() : recoveryReceipt()), stderr: settings[`${prefix}Stderr`] ?? "" };
    }
    if (file !== "git") {
      assert.deepEqual(args, ["--test", "--test-reporter=tap", "ops/platform/p2-identity-negative-probe.test.mjs"]);
      return ok(testOutput);
    }
    if (options.cwd === root && args.includes("--ignored")) return ok(ignoredFrontendOutputs.join("\0") + (ignoredFrontendOutputs.length ? "\0" : ""));
    if (options.cwd === root && args.includes("--error-unmatch")) {
      const tracked = trackedDependencyRoots.some(path => args.at(-1) === `${path}/package-lock.json`);
      return tracked ? ok(args.at(-1) + "\n") : { status: 1, signal: null, stdout: "", stderr: "not tracked" };
    }
    if (args[0] === "checkout") assert.fail("checkout must retain the fixed -c prefix");
    if (args.includes("checkout")) {
      const service = options.cwd.endsWith("lash-her-course-api") ? "course" : "community";
      mkdirSync(join(options.cwd, ".git"), { recursive: true });
      populateSourceClosure(options.cwd, service);
      if (settings.apiSourceAlias === service) {
        rmSync(join(options.cwd, "dist"), { recursive: true, force: true });
        symlinkSync(join(root, "src"), join(options.cwd, "dist"), "dir");
      }
      const url = service === "course" ? "https://github.com/princessdardan/lash-her-course-api.git" :
        "https://github.com/princessdardan/lash-her-community-api.git";
      writeFileSync(join(options.cwd, ".git/config"), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n${settings.apiGitConfigSuffix ?? ""}`);
      writeFileSync(join(options.cwd, "package.json"), JSON.stringify({ name: `lash-her-${service}-api`, scripts: { "build:production": "tsc -p tsconfig.build.json" } }));
      writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
      if (service === "course") {
        mkdirSync(join(options.cwd, "openapi"), { recursive: true }); writeFileSync(join(options.cwd, "openapi/course-api.json"), contents.course);
      } else {
        mkdirSync(join(options.cwd, "openapi"), { recursive: true }); mkdirSync(join(options.cwd, "contracts/course-enrollment/v1"), { recursive: true });
        writeFileSync(join(options.cwd, "openapi/community-api.json"), contents.community);
        writeFileSync(join(options.cwd, "contracts/course-enrollment/v1/enrollment-event.schema.json"), contents.enrollmentEvent);
      }
      return ok("");
    }
    if (args.join(" ") === "rev-parse HEAD") {
      if (options.cwd === root) return ok("d".repeat(40) + "\n");
      return ok((options.cwd.endsWith("lash-her-course-api") ? revisions.course : revisions.community) + "\n");
    }
    if (args.join(" ") === "rev-parse HEAD^{tree}") return ok((options.cwd === root ? "c" : options.cwd.endsWith("lash-her-course-api") ? "e" : "f").repeat(40) + "\n");
    if (args.join(" ") === "remote get-url origin") return ok(options.cwd === root ? "https://github.com/princessdardan/lash-her-frontend.git\n" :
      options.cwd.endsWith("lash-her-course-api") ? "https://github.com/princessdardan/lash-her-course-api.git\n" :
        "https://github.com/princessdardan/lash-her-community-api.git\n");
    return ok("");
  };
  return { root, workspace, calls, dockerModes, dockerSocketPath, dockerSocketStat, run,
    interruptedExpected: () => structuredClone(capturedInterruptedExpected),
    cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); } };
}

test("prepares exact manifest sources with fixed clean builds and requires all 19 actual tests", () => {
  const value = harness(tap(), ["ops/gateway/node_modules/typescript/lib/typescript.js",
    "tools/api-contract-toolchain/node_modules/ajv/dist/ajv.js", "ops/platform/host/__pycache__/probe.cpython-312.pyc"]);
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      run: value.run, makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_PROBE_FIXTURES_PASS");
    assert.equal(result.fixtureOnly, true); assert.equal(result.providerTouched, false); assert.equal(result.skipped, 0);
    assert.equal(result.databaseConnected, false); assert.equal(result.sqlExecuted, false); assert.equal(result.ownedDisposableDatabase, false);
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    assert.deepEqual(result.tests, { tests: 19, pass: 19, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
    assert.equal(result.sources.course.revision, revisions.course); assert.equal(result.sources.community.revision, revisions.community);
    assert.equal(result.scriptsIgnoredDuringInstall, true); assert.equal(result.databaseConnected, false); assert.equal(existsSync(value.workspace), false);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
    const fetches = value.calls.filter(call => call.file === "git" && call.args[0] === "fetch");
    assert.deepEqual(fetches.map(call => call.args), [["fetch", "--no-tags", "--depth=1", "origin", revisions.course], ["fetch", "--no-tags", "--depth=1", "origin", revisions.community]]);
    for (const fetch of fetches) {
      assert.equal(fetch.env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
      assert.equal(fetch.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${sourceReadToken}`).toString("base64")}`);
      assert.equal(JSON.stringify(fetch.args).includes(sourceReadToken), false);
    }
    assert.deepEqual(value.calls.filter(call => call.file === "git" && call.args[0] === "remote" && call.args[1] === "add").map(call => call.args),
      [["remote", "add", "origin", "https://github.com/princessdardan/lash-her-course-api.git"],
        ["remote", "add", "origin", "https://github.com/princessdardan/lash-her-community-api.git"]]);
    const installs = value.calls.filter(call => call.file === "npm" && call.args[0] === "ci");
    assert.equal(installs.length, 2);
    for (const install of installs) assert.deepEqual(install.args, ["ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"]);
    const builds = value.calls.filter(call => call.file === "npm" && call.args[0] === "run");
    assert.equal(builds.length, 2);
    for (const build of builds) { assert.deepEqual(build.args, ["run", "build:production"]); assert.equal(build.env.NODE_ENV, "production"); }
    const probe = value.calls.find(call => call.file !== "git" && call.file !== "npm");
    assert.equal(probe.env.NODE_ENV, "test");
    assert.equal(probe.env.P2_IDENTITY_COURSE_RUNTIME_DIR.endsWith("/lash-her-course-api"), true);
    assert.equal(probe.env.P2_IDENTITY_COMMUNITY_RUNTIME_DIR.endsWith("/lash-her-community-api"), true);
    for (const call of value.calls.filter(call => !(call.file === "git" && call.args[0] === "fetch"))) {
      assert.equal(Object.hasOwn(call.env, "GIT_CONFIG_VALUE_0"), false);
      assert.equal(call.env.npm_config_userconfig.endsWith("/npm-userconfig"), true);
      assert.equal(call.env.npm_config_globalconfig.endsWith("/npm-globalconfig"), true);
    }
    for (const call of value.calls) for (const forbidden of ["DATABASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CRON_SECRET", "VERCEL_TOKEN", "NODE_OPTIONS"])
      assert.equal(Object.hasOwn(call.env, forbidden), false, `${forbidden} must not enter ${call.file}`);
  } finally { value.cleanup(); }
});

test("recovery mode runs current and forward PostgreSQL 18 fixtures after all identity checks in separate containers", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat, makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_AND_RECOVERY_FIXTURES_PASS");
    assert.equal(result.fixtureOnly, true); assert.equal(result.providerTouched, false); assert.equal(result.skipped, 0);
    assert.equal(result.databaseConnected, true); assert.equal(result.sqlExecuted, true); assert.equal(result.ownedDisposableDatabase, true);
    assert.equal(result.recovery.status, "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS");
    assert.equal(result.recovery.serverMajor, 18); assert.equal(result.recovery.frontendMigrations, 83);
    assert.equal(result.recovery.courseMigrations, 22); assert.equal(result.recovery.communityMigrations, 11);
    assert.equal(result.recovery.checks, 55); assert.equal(result.recovery.skipped, 0); assert.equal(result.recovery.privilegeFaults.length, 39);
    assert.equal(result.recovery.frontendInitialPrivilegeRefusals, 17); assert.equal(result.recovery.frontendContinuousPrivilegeRefusals, 17);
    assert.equal(result.recovery.apiPrivilegeRefusals, 22); assert.equal(result.recovery.legacyApiVerifierRefusals, 2);
    assert.equal(result.recovery.frontendOperatorSearchPathPinned, true);
    assert.equal(result.recovery.environmentIsolation.childEnvironmentAllowlistEnforced, true);
    assert.equal(result.forwardRecovery.status, "OWNED_P2_RECOVERY_FORWARD_CHECKS_PASS");
    assert.equal(result.forwardRecovery.serverMajor, 18); assert.equal(result.forwardRecovery.frontendMigrations, 83);
    assert.equal(result.forwardRecovery.courseMigrations, 22); assert.equal(result.forwardRecovery.communityMigrations, 11);
    assert.equal(result.forwardRecovery.checks.length, 19); assert.equal(result.forwardRecovery.mutationRefusals, 1);
    assert.equal(result.forwardRecovery.runtimeCredentialRefusals, 9); assert.equal(result.forwardRecovery.foreignRuntimeTlsAuthenticated, true);
    assert.equal(result.forwardRecovery.runtimeCredentialFaultProviderCalls, 0);
    assert.equal(result.forwardRecovery.skipped, 0); assert.equal(result.forwardRecovery.actualRuntimeContainers, false);
    assert.equal(result.forwardRecovery.journalDigestsUnchanged, true); assert.equal(result.forwardRecovery.noSqlReplay, true);
    assert.deepEqual(result.forwardRecovery.apiSourcePins.course, { revision: revisions.course, gitTree: "e".repeat(40),
      packageSha256: result.sources.course.packageSha256, packageLockSha256: result.sources.course.packageLockSha256,
      artifactSha256: { course: sha(contents.course) } });
    assert.deepEqual(result.forwardRecovery.apiSourcePins.community, { revision: revisions.community, gitTree: "f".repeat(40),
      packageSha256: result.sources.community.packageSha256, packageLockSha256: result.sources.community.packageLockSha256,
      artifactSha256: { community: sha(contents.community), enrollmentEvent: sha(contents.enrollmentEvent) } });
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    const contextIndex = value.calls.findIndex(call => call.file === "docker" && call.args[0] === "context");
    const dockerCalls = value.calls.filter(call => call.file === "docker" && call.args[0] === "--host");
    const dockerIndex = value.calls.indexOf(dockerCalls[0]), forwardIndex = value.calls.indexOf(dockerCalls[1]);
    const identityIndex = value.calls.findIndex(call => call.file !== "docker" && call.file !== "git" && call.file !== "npm");
    assert.equal(dockerCalls.length, 2);assert.equal(identityIndex >= 0 && contextIndex > identityIndex && dockerIndex > contextIndex && forwardIndex > dockerIndex, true);
    const context = value.calls[contextIndex];
    assert.deepEqual(context.args, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
    assert.deepEqual(Object.keys(context.env).sort(), ["HOME", "LANG", "LC_ALL", "PATH"]);
    const docker = dockerCalls[0], forwardDocker = dockerCalls[1];
    assert.deepEqual(docker.args.slice(0, 3), ["--host", `unix://${value.dockerSocketPath}`, "run"]);
    for (const argument of ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--memory=1g", "--pids-limit=256", "--shm-size=256m", "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_RECOVERY_OWNED_TEST=true",
      "--env=NODE_BIN=/usr/local/bin/node", "--env=COURSE_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-course-api",
      "--env=COMMUNITY_RECOVERY_SOURCE_ROOT=/exact-sources/lash-her-community-api", "--entrypoint=python3",
      "lash-her-frontend-migration:postgres18-test", "ops/platform/test-p2-recovery-owned.py"]) assert.equal(docker.args.includes(argument), true, argument);
    assert.equal(docker.args.includes("--forward-brand"), false);assert.equal(forwardDocker.args.at(-1), "--forward-brand");
    assert.deepEqual(forwardDocker.args.slice(0,-1),docker.args);
    const mounts = docker.args.filter((argument, index) => docker.args[index - 1] === "--mount");
    assert.equal(mounts.length, 12); assert.equal(mounts.every(value => value.endsWith(",readonly")), true);
    assert.equal(mounts.some(value => value.includes("dst=/exact-sources/lash-her-course-api")), true);
    assert.equal(mounts.some(value => value.includes("dst=/exact-sources/lash-her-community-api")), true);
    assert.equal(mounts.some(value => value.includes(`src=${value.workspace},`)), false);
    assert.deepEqual(Object.keys(docker.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    assert.deepEqual(forwardDocker.env,docker.env);
    assert.deepEqual(value.dockerModes, [{ workspace: 0o700, course: 0o755, community: 0o755 },
      { workspace: 0o700, course: 0o755, community: 0o755 }]);
  } finally { value.cleanup(); }
});

test("lifecycle mode sends one internally built exact source manifest to an isolated PostgreSQL 18 fixture", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
      makeTemporaryDirectory: () => value.workspace }));
    assert.equal(result.status, "P2_IDENTITY_RECOVERY_AND_LIFECYCLE_FIXTURES_PASS");
    assert.equal(result.skipped, 0); assert.equal(result.databaseConnected, true); assert.equal(result.sqlExecuted, true);
    assert.equal(result.lifecyclePersistence.status, "P2_LIFECYCLE_PERSISTENCE_OWNED_POSTGRES18_PASS");
    assert.equal(result.lifecyclePersistence.postgresMajor, 18); assert.equal(result.lifecyclePersistence.frontendMigrations, 83);
    assert.equal(result.lifecyclePersistence.courseMigrations, 22); assert.equal(result.lifecyclePersistence.communityMigrations, 11);
    assert.equal(result.lifecyclePersistence.checks.length, 13); assert.equal(result.lifecyclePersistence.skipped, 0);
    assert.equal(result.lifecyclePersistence.sourceMode, "parent-issued-manifest-and-mounted-readback");
    assert.match(result.lifecyclePersistence.parentProofSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.lifecyclePersistence.sourceManifestSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(result.lifecyclePersistence.sourceCommits,
      { community: revisions.community, course: revisions.course, frontend: "d".repeat(40) });
    assert.equal(Object.keys(result.lifecyclePersistence.sourceSha256).length, 5);
    assert.equal(result.lifecycleReceivers.status, "P2_LIFECYCLE_RECEIVER_OWNED_POSTGRES18_PASS");
    assert.equal(result.lifecycleReceivers.postgresMajor, 18); assert.equal(result.lifecycleReceivers.frontendMigrations, 83);
    assert.equal(result.lifecycleReceivers.courseMigrations, 22); assert.equal(result.lifecycleReceivers.communityMigrations, 11);
    assert.equal(result.lifecycleReceivers.checks.length, 12); assert.equal(result.lifecycleReceivers.httpCaseCount, 8);
    assert.equal(result.lifecycleReceivers.skipped, 0); assert.equal(result.lifecycleReceivers.domainStatePreserving, true);
    assert.equal(result.lifecycleReceivers.globallyReadOnly, false); assert.equal(result.lifecycleReceivers.quotaWritesObserved, true);
    assert.equal(result.lifecycleReceivers.deployedFutureGapQualified, false); assert.equal(result.lifecycleReceivers.hostDockerPathQualified, false);
    assert.equal(result.lifecycleReceivers.sourceMode, "parent-issued-manifest-and-mounted-readback");
    assert.equal(result.lifecycleReceivers.sourceManifestSha256, result.lifecyclePersistence.sourceManifestSha256);
    assert.equal(result.lifecycleReceivers.parentProofSha256, result.lifecyclePersistence.parentProofSha256);
    assert.equal(Object.keys(result.lifecycleReceivers.sourceSha256).length, 7);
    const dockerCalls = value.calls.filter(call => call.file === "docker" && call.args[0] === "--host");
    assert.equal(dockerCalls.length, 6);
    assert.equal(dockerCalls[0].args.includes("-i"), false); assert.equal(dockerCalls[1].args.includes("-i"), false);
    const persistence = dockerCalls[2];
    assert.equal(Buffer.isBuffer(persistence.input), true);
    assert.equal(sha(persistence.input), result.lifecyclePersistence.sourceManifestSha256);
    const manifest = JSON.parse(persistence.input.toString("utf8"));
    assert.equal(manifest.parentProofSha256, result.lifecyclePersistence.parentProofSha256);
    assert.deepEqual(Object.keys(manifest.sources).sort(), ["community", "course", "frontend"]);
    assert.equal(manifest.sources.course.revision, revisions.course); assert.equal(manifest.sources.community.revision, revisions.community);
    assert.equal(manifest.identityManifestSha256, result.manifestSha256);
    for (const service of ["frontend", "course", "community"]) {
      const names = Object.keys(manifest.sources[service].files);
      assert.deepEqual(names, [...names].sort()); assert.equal(names.length > 5, true);
    }
    for (const argument of ["-i", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18",
      "--env=P2_LIFECYCLE_PERSISTENCE_OWNED_TEST=true", "--entrypoint=/usr/local/bin/node", "--import", "tsx",
      "ops/platform/test-p2-lifecycle-persistence-local.mjs", "--postgres18-manifest"])
      assert.equal(persistence.args.includes(argument), true, argument);
    assert.deepEqual(persistence.args.slice(-4), ["--import", "tsx", "ops/platform/test-p2-lifecycle-persistence-local.mjs", "--postgres18-manifest"]);
    const mounts = persistence.args.filter((argument, index) => persistence.args[index - 1] === "--mount");
    assert.equal(mounts.length, 25); assert.equal(mounts.every(value => value.endsWith(",readonly")), true);
    assert.equal(mounts.some(mount => mount.includes("dst=/source/package-lock.json")), true);
    assert.equal(mounts.some(mount => mount.includes("dst=/exact-sources/lash-her-course-api/package-lock.json")), true);
    assert.equal(mounts.some(mount => mount.includes("dst=/exact-sources/lash-her-community-api/package-lock.json")), true);
    assert.equal(mounts.some(mount => mount.includes("/.git") || /dst=\/exact-sources\/lash-her-(?:course|community)-api,readonly$/u.test(mount)), false);
    assert.deepEqual(Object.keys(persistence.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    const receivers = dockerCalls[3];
    assert.equal(Buffer.isBuffer(receivers.input), true); assert.equal(sha(receivers.input), result.lifecycleReceivers.sourceManifestSha256);
    for (const argument of ["-i", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18",
      "--env=P2_LIFECYCLE_RECEIVER_OWNED_TEST=true", "--entrypoint=/usr/local/bin/node", "--import", "tsx",
      "ops/platform/test-p2-lifecycle-receivers-local.mjs", "--postgres18-manifest"])
      assert.equal(receivers.args.includes(argument), true, argument);
    assert.deepEqual(receivers.args.slice(-4), ["--import", "tsx", "ops/platform/test-p2-lifecycle-receivers-local.mjs", "--postgres18-manifest"]);
    const receiverMounts = receivers.args.filter((argument, index) => receivers.args[index - 1] === "--mount");
    assert.equal(receiverMounts.length, 25); assert.equal(receiverMounts.every(mount => mount.endsWith(",readonly")), true);
    assert.deepEqual(Object.keys(receivers.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    const interrupted = dockerCalls[4], summary = result.interruptedRestoration;
    assert.deepEqual(interrupted.args.slice(-3), ["--import", "tsx", "docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs"]);
    assert.equal(interrupted.input, undefined);
    assert.deepEqual(interrupted.args.filter(arg => arg.startsWith("--env=")), [
      "--env=PG_BIN=/usr/lib/postgresql/18/bin", "--env=OWNED_POSTGRES_MAJOR=18", "--env=P2_INTERRUPTED_OWNED_TEST=true",
      "--env=P2_KNOWN_ACK_COURSE_SOURCE_ROOT=/exact-sources/lash-her-course-api",
      "--env=P2_KNOWN_ACK_COMMUNITY_SOURCE_ROOT=/exact-sources/lash-her-community-api",
    ]);
    const interruptedMounts = interrupted.args.filter((_arg, index) => interrupted.args[index - 1] === "--mount");
    for (const target of ["/source/.git", "/source/ops", "/source/tsconfig.json", "/exact-sources/lash-her-course-api", "/exact-sources/lash-her-community-api",
      ...P2_INTERRUPTED_OWNED_SOURCE_FILES.filter(name => name.startsWith("docs/")).map(name => `/source/${name}`)])
      assert.equal(interruptedMounts.some(mount => mount.endsWith(`,dst=${target},readonly`)), true, target);
    assert.equal(interruptedMounts.length, 16); assert.equal(interruptedMounts.every(mount => mount.endsWith(",readonly")), true);
    for (const target of ["/source/ops/platform", "/source/ops/gateway"])
      assert.equal(interruptedMounts.some(mount => mount.endsWith(`,dst=${target},readonly`)), false);
    assert.deepEqual(Object.keys(interrupted.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    assert.equal(summary.status, "P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS"); assert.equal(summary.serverMajor, 18);
    assert.deepEqual(summary.oldGatewayUncertainty, { newWork: 0, recovery: 1 }); assert.equal(summary.frontendUncertaintyAfterSettlement, 0);
    assert.deepEqual(summary.newGatewayUncertainty, { newWork: 0, recovery: 0 }); assert.equal(summary.runtimeServices, 10);
    for (const key of ["actualHostDocker", "providerTouched", "actualRootOperatorInstall", "nodeCommittedSourceCallbackVerified", "trafficAuthorized", "frontendReadinessVerified"])
      assert.equal(summary[key], false, key);
    for (const key of ["runtimeTransportProjected", "nativeMetadataProjected", "modeledOidc", "apiCurrentBeforeAfterVerified", "allThreeJournalsUnchanged"])
      assert.equal(summary[key], true, key);
    assert.equal(Object.keys(summary.ownedSourceSha256).length, 11); assert.equal(Object.keys(summary.fixtureSourceSha256).length, 4);
    assert.equal(summary.gatewayDependency.version, "6.2.3"); assert.equal(summary.gatewayDependency.resolution, "ops/gateway/node_modules/jose");
    assert.equal(summary.skipped, 0); assert.equal(summary.fixtureOnly, true);
    assert.equal(summary.frontendSourceProof.revision, summary.frontendSourceCommit);
    assert.equal(summary.frontendSourceProof.packageLockSha256, sha(readFileSync(join(value.root, "package-lock.json"))));
    assert.equal(Object.hasOwn(summary, "noRuntimeRestart"), false); assert.equal(summary.knownAckPrefix.noRuntimeRestart, true);
    assert.equal(JSON.stringify(summary).includes("/private/tmp/"), false); assert.equal(JSON.stringify(summary).includes(value.workspace), false);
    const negative = dockerCalls[5], negativeSummary = result.interruptedRestorationNegatives;
    assert.deepEqual(negative.args.slice(-4), [...interrupted.args.slice(-3), "--negative-cases"]);
    assert.deepEqual(negative.args.slice(0, -1), interrupted.args); assert.equal(negative.input, undefined);
    assert.deepEqual(negative.env, interrupted.env);
    assert.equal(negativeSummary.status, "P2_INTERRUPTED_NEGATIVES_OWNED_PASS"); assert.equal(negativeSummary.serverMajor, 18);
    assert.equal(negativeSummary.cases.length, 7); assert.equal(negativeSummary.skipped, 0);
    assert.equal(negativeSummary.parentSourceProvenance, "parent-before-and-after-verified-readonly-mounts");
    assert.equal(negativeSummary.childOwnedSourceReadback, true);
    assert.deepEqual(negativeSummary.fixtureSourceSha256, summary.fixtureSourceSha256);
    assert.deepEqual(negativeSummary.apiSourcePins, summary.apiSourcePins);
    assert.deepEqual(negativeSummary.frontendSourceProof, summary.frontendSourceProof);
    for (const row of negativeSummary.cases) { assert.equal(Object.hasOwn(row, "ownedSourceSha256"), false); assert.equal(Object.hasOwn(row, "apiSourcePins"), false); }
    for (const key of ["actualHostDocker", "providerTouched", "actualRootOperatorInstall", "nodeCommittedSourceCallbackVerified"])
      assert.equal(negativeSummary[key], false);
    assert.equal(JSON.stringify(result).includes(sourceReadToken), false);
    assert.equal(value.calls.filter(call => call.file === "git" && call.args.join(" ") === "remote get-url origin").length >= 12, true);
  } finally { value.cleanup(); }
});

function runLifecycle(value) {
  return withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
    recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
    makeTemporaryDirectory: () => value.workspace }));
}

test("legacy lifecycle manifests verify against only their actual mounts while C keeps its separate fixed readset", () => {
  const value = harness(), originalRun = value.run;
  let verified = 0;
  try {
    value.run = (file, args, options) => {
      if (file === "docker" && args.includes("--postgres18-manifest")) {
        verifyProjectedLifecycleMounts(options.input, args);
        const changed = JSON.parse(options.input.toString("utf8"));
        const cHelper = P2_INTERRUPTED_OWNED_SOURCE_FILES.find(name => name.startsWith("docs/"));
        assert.equal(Object.hasOwn(changed.sources.frontend.files, cHelper), false);
        changed.sources.frontend.files[cHelper] = sha(readFileSync(join(value.root, cHelper)));
        assert.throws(() => verifyProjectedLifecycleMounts(Buffer.from(JSON.stringify(changed)), args));
        const withoutPlatform = args.filter((argument, index) =>
          !(argument === "--mount" && args[index + 1].includes("dst=/source/ops/platform,")) &&
          !(args[index - 1] === "--mount" && argument.includes("dst=/source/ops/platform,")));
        assert.throws(() => verifyProjectedLifecycleMounts(options.input, withoutPlatform));
        verified++;
      }
      return originalRun(file, args, options);
    };
    runLifecycle(value); assert.equal(verified, 2);
  } finally { value.cleanup(); }
});

test("actual C entry rejects unknown arguments and missing ownership before dependency or PostgreSQL work", () => {
  const entry = fileURLToPath(new URL("../../docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs", import.meta.url));
  for (const [args, owned, code] of [
    [["--PRIVATE_CALLER_MODE"], true, "P2_INTERRUPTED_OWNED_ARGUMENTS_REFUSED"],
    [["--negative-cases", "PRIVATE_EXTRA_ARGUMENT"], true, "P2_INTERRUPTED_OWNED_ARGUMENTS_REFUSED"],
    [["--negative-cases"], false, "P2_INTERRUPTED_OWNED_SCOPE_REQUIRED"],
    [[], false, "P2_INTERRUPTED_OWNED_SCOPE_REQUIRED"],
  ]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64_000,
      env: { PATH: process.env.PATH, PG_BIN: "/must-not-execute", OWNED_POSTGRES_MAJOR: "18", ...(owned ? { P2_INTERRUPTED_OWNED_TEST: "true" } : {}) } });
    assert.ifError(child.error); assert.equal(child.status, 1); assert.equal(child.signal, null); assert.equal(child.stdout, "");
    assert.deepEqual(JSON.parse(child.stderr), { version: 1, status: "P2_INTERRUPTED_OWNED_REFUSED", code });
    assert.doesNotMatch(child.stderr, /PRIVATE_CALLER_MODE|PRIVATE_EXTRA_ARGUMENT|must-not-execute/u);
  }
});

test("actual final PG18 C receipt qualifies only against its source pins and independent B prefix", () => {
  const value = harness();
  try {
    runLifecycle(value);
    const expected = value.interruptedExpected(), retained = structuredClone(retainedInterruptedReceipt);
    expected.frontendSourceCommit = retained.frontendSourceCommit;
    expected.apiSourceLocks = Object.fromEntries(Object.entries(retained.apiSourceArchives).map(([service, archive]) => [service, archive.lockSha256]));
    expected.ownedSourceSha256 = retained.restoration.ownedSourceSha256; expected.fixtureSourceSha256 = retained.fixtureSourceSha256;
    expected.gatewayDependency = retained.restoration.gatewayDependency;
    expected.candidate.sources.frontend.commit = retained.frontendSourceCommit;
    expected.candidate.runtime.composeSha256 = "sha256:" + sha(readFileSync(new URL("./compose.yaml", import.meta.url)));
    const raw = JSON.stringify(retained, null, 2) + "\n";
    assert.equal(sha(raw), "758c9690999f214ae438db105e72dcaa9ff0bbf80b93fdbbe23b3d4dec295eec");
    assert.equal(parseP2InterruptedRestorationPostgres18Receipt(raw, expected).restoration.status, "P2_INTERRUPTED_NEW_PROCESS_OWNED_PASS");
    const missingPrefix = structuredClone(retained); delete missingPrefix.restoration.originalCausalReceiptSha256;
    assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(missingPrefix), expected));
    assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(raw, value.interruptedExpected()));
  } finally { value.cleanup(); }
});

test("C parser refuses partial B proof, source substitution, skips and projected-runtime overclaims", () => {
  const value = harness();
  try {
    runLifecycle(value); const expected = value.interruptedExpected(), valid = interruptedReceipt(expected);
    const reject = mutate => { const changed = structuredClone(valid); mutate(changed); assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(changed), expected)); };
    for (const mutate of [
      item => { delete item.restoration; }, item => { item.skipped = 1; }, item => { item.extra = "PRIVATE_EXTRA"; },
      item => { item.postgresMajor = 16; }, item => { item.migrations.frontend = 82; }, item => { item.firstHttpStatus = 200; },
      item => { item.firstFrontendUncertain = 0; }, item => { item.finalGatewayUncertain = 0; }, item => { item.settledFrontendUncertain = 1; },
      item => { item.gatewayCounterReset = true; }, item => { item.finalDeliveries[1].attempts = 1; }, item => { item.finalDeliveries[0].lease_id = "inflight"; },
      item => { item.backendEligibility.faultNames.pop(); }, item => { item.backendEligibility.liveWorkerProcesses = true; },
      item => { item.sourceDomainReducer.faultRefusals = 0; }, item => { item.sourceSettlementReducer.authorityIssued = true; },
      item => { item.frontendSourceCommit = "f".repeat(40); }, item => { item.apiSourceCommits.course = "f".repeat(40); },
      item => { item.apiSourceArchives.course.lockSha256 = "f".repeat(64); }, item => { delete item.fixtureSourceSha256["p2-known-ack-loss-probe.mjs"]; },
      item => { item.fixtureSourceSha256["host/p2_known_ack_loss.py"] = "f".repeat(64); },
      item => { item.restoration.ownedSourceSha256["ops/gateway/server.mjs"] = "f".repeat(64); },
      item => { item.restoration.gatewayDependency.version = "6.2.15"; }, item => { item.restoration.gatewayDependency.resolution = "node_modules/jose"; },
      item => { item.restoration.gatewayDependency.packageSha256 = "f".repeat(64); },
      ...["oldProcessExited", "oldBackendEnded", "newFrontendBackend", "newHostProcess", "newSourceCapability", "oldOneRetained", "allTenSourceStages", "allThreeJournalsUnchanged"].map(key => item => { item.restoration[key] = false; }),
      ...["actualDocker", "providerTouched", "frontendReadinessVerified", "trafficAuthorized", "sqlReplayed"].map(key => item => { item.restoration[key] = true; }),
      item => { item.restoration.runtimeTransportProjected = false; }, item => { item.restoration.extra = true; },
    ]) reject(mutate);
    for (const output of ["", "{}", "[]", "not-json", JSON.stringify(valid) + "\n{}", " ".repeat(1_000_001)])
      assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(output, expected));
  } finally { value.cleanup(); }
});

test("C terminal is independently closed and joined to all three journals, current APIs and fenced old/new gateways", () => {
  const value = harness();
  try {
    runLifecycle(value); const expected = value.interruptedExpected(), valid = interruptedReceipt(expected);
    for (const mutate of [
      terminal => { terminal.extra = true; }, terminal => { terminal.candidateSha256 = "f".repeat(64); },
      terminal => { terminal.ordinaryClosedZeroGate = true; }, terminal => { terminal.runtimeReplacements = 2; },
      terminal => { terminal.nativeDisabled = false; }, terminal => { terminal.sqlReplayed = true; },
      terminal => { terminal.frontendJournalSha256 = "f".repeat(64); }, terminal => { terminal.boundaryChecks.pop(); },
      terminal => { terminal.apiDatabasesAfter.community.pendingTags = ["unapplied"]; },
      terminal => { terminal.apiDatabases.course.readOnlyVerified = false; terminal.apiDatabasesAfter = structuredClone(terminal.apiDatabases); },
      terminal => { terminal.apiDatabases.course.sourceCommit = "f".repeat(40); terminal.apiDatabasesAfter = structuredClone(terminal.apiDatabases); },
      terminal => { terminal.apiDatabases.community.journalSha256 = "f".repeat(64); terminal.apiDatabasesAfter = structuredClone(terminal.apiDatabases); },
      terminal => { terminal.oldGateway.admission.uncertain.recovery = 0; }, terminal => { terminal.newGateway.admission.uncertain.recovery = 1; },
      terminal => { terminal.newGateway.admission.newWork = true; }, terminal => { terminal.newGateway.admission.active.recovery = 1; },
      terminal => { terminal.newGateway.process.containerId = terminal.oldGateway.process.containerId; },
      terminal => { terminal.newGateway.binding.runtimeConfigurationSha256 = "f".repeat(64); },
      terminal => { terminal.containers.pop(); }, terminal => { terminal.containers[0].image = terminal.containers[1].image; },
      terminal => { terminal.containers[2].health = "healthy"; }, terminal => { terminal.containers[1].containerId = terminal.containers[0].containerId; },
      terminal => { terminal.originalCausalReceiptSha256.extra = "f".repeat(64); },
    ]) {
      const changed = structuredClone(valid); mutate(changed.restoration.terminalReceipt);
      changed.restoration.terminalReceiptSha256 = sha(JSON.stringify(changed.restoration.terminalReceipt) + "\n");
      assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(changed), expected));
    }
    const changed = structuredClone(valid); changed.restoration.terminalReceiptSha256 = "f".repeat(64);
    assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(changed), expected));
    for (const name of Object.keys(valid.restoration.originalCausalReceiptSha256)) {
      const terminalSplice = structuredClone(valid); terminalSplice.restoration.terminalReceipt.originalCausalReceiptSha256[name] = "f".repeat(64);
      terminalSplice.restoration.terminalReceiptSha256 = sha(JSON.stringify(terminalSplice.restoration.terminalReceipt) + "\n");
      assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(terminalSplice), expected), name);
      const prefixSplice = structuredClone(valid); prefixSplice.restoration.originalCausalReceiptSha256[name] = "f".repeat(64);
      assert.throws(() => parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(prefixSplice), expected), name);
    }
    assert.notEqual(valid.domainProofSha256, valid.restoration.originalCausalReceiptSha256["settlement.json"]);
    assert.equal(parseP2InterruptedRestorationPostgres18Receipt(JSON.stringify(valid), expected).status, "P2_KNOWN_ACK_WHOLE_ROUTE_PASS");
  } finally { value.cleanup(); }
});

test("fixed C negatives require every named refusal and actual active-loss containment condition", () => {
  const value = harness();
  try {
    runLifecycle(value); const expected = value.interruptedExpected(), valid = JSON.parse(interruptedNegativeOutput(expected));
    assert.equal(parseP2InterruptedNegativesPostgres18Receipt(JSON.stringify(valid), expected).cases.length, 7);
    const recordedExpected = { ...expected, ownedSourceSha256: retainedInterruptedNegatives.cases[0].ownedSourceSha256,
      gatewayDependency: retainedInterruptedNegatives.cases[0].gatewayDependency };
    const recordedRaw = JSON.stringify(retainedInterruptedNegatives, null, 2) + "\n";
    assert.equal(sha(recordedRaw), "5fedd2f860724846ca2235faf19e9b69c1472c3fa329ff9393481957465629d8");
    assert.equal(parseP2InterruptedNegativesPostgres18Receipt(recordedRaw, recordedExpected).cases.length, 7);
    const row = (item, name) => item.cases.find(value => value.case === name);
    for (const mutate of [
      item => { item.serverMajor = 16; }, item => { item.extra = true; }, item => { item.skipped = 1; },
      item => { item.cases.pop(); }, item => { item.cases.reverse(); }, item => { item.cases[1] = structuredClone(item.cases[0]); },
      item => { row(item, "original-bytes").case = "caller-selected-case"; }, item => { row(item, "original-bytes").extra = true; },
      item => { item.cases.splice(1, 1); }, item => { row(item, "original-config-drift").upCommands = 1; },
      item => { row(item, "original-config-drift").authorityIssued = true; },
      item => { row(item, "original-bytes").newFrontendBackend = true; }, item => { row(item, "original-bytes").nativeDisabled = true; },
      item => { row(item, "missing-lineage").upCommands = 1; }, item => { row(item, "pending-lineage").authorityIssued = true; },
      item => { row(item, "backend-effect").newFrontendBackend = false; }, item => { row(item, "backend-effect").nativeDisabled = false; },
      item => { row(item, "backend-effect").runtimeStopped = null; }, item => { row(item, "backend-effect").cleanedNamespaces = ["recovery"]; },
      item => { row(item, "active-backend-loss").upCommands = 0; }, item => { row(item, "active-backend-loss").upCommands = 2; },
      item => { row(item, "active-backend-loss").authorityIssued = false; }, item => { row(item, "active-backend-loss").actualGuardWriterExited = true; },
      item => { row(item, "active-guard-loss").actualGuardWriterExited = false; }, item => { row(item, "active-guard-loss").Bterminal = true; },
      item => { row(item, "active-guard-loss").Cterminal = true; }, item => { row(item, "active-guard-loss").oldOneRetained = false; },
      item => { row(item, "active-guard-loss").allThreeJournalsUnchanged = false; }, item => { row(item, "active-guard-loss").actualDocker = true; },
      item => { row(item, "active-guard-loss").providerTouched = true; }, item => { row(item, "active-guard-loss").trafficAuthorized = true; },
      item => { row(item, "active-guard-loss").ownedSourceSha256["ops/gateway/server.mjs"] = "f".repeat(64); },
      item => { row(item, "active-guard-loss").gatewayDependency.version = "6.2.15"; }, item => { row(item, "active-guard-loss").elapsedSeconds = item.elapsedSeconds + 1; },
      item => { row(item, "active-backend-loss").elapsedSeconds = row(item, "backend-effect").elapsedSeconds; },
    ]) {
      const changed = structuredClone(valid); mutate(changed);
      assert.throws(() => parseP2InterruptedNegativesPostgres18Receipt(JSON.stringify(changed), expected));
    }
    for (const output of ["", "{}", "[]", JSON.stringify(valid) + "\n{}", " ".repeat(1_000_001)])
      assert.throws(() => parseP2InterruptedNegativesPostgres18Receipt(output, expected));
  } finally { value.cleanup(); }
});

test("negative C failures and post-run source drift refuse before checkout cleanup completes", () => {
  for (const [settings, failure] of [
    [{ interruptedNegativeStatus: 1 }, "child-exit"], [{ interruptedNegativeStatus: 125 }, "docker-transport"],
    [{ interruptedNegativeOutput: "{}" }, "receipt-invalid"],
  ]) {
    const value = harness(tap(), [], undefined, settings), runner = realpathSync(mkdtempSync(join(tmpdir(), "p2-c-negative-failure-")));
    try {
      let observed;
      withRunnerTemp(runner, () => { try { runLifecycle(value); } catch (error) { observed = p2IdentityFixtureFailureReceipt(error); } });
      assert.equal(observed.stage, "interrupted-negatives"); assert.equal(observed.recoveryQualification, "interrupted-negatives");
      assert.equal(observed.recoveryFailure, failure); assert.equal(existsSync(value.workspace), false);
      assert.ok(existsSync(join(runner, "p2-owned-fixture-failure/interrupted-negatives", "d".repeat(40) + ".json")));
    } finally { value.cleanup(); rmSync(runner, { recursive: true, force: true }); }
  }
  const value = harness(tap(), [], undefined, { interruptedNegativeSourceMutation: true });
  try { assert.throws(() => runLifecycle(value)); assert.equal(existsSync(value.workspace), false); }
  finally { value.cleanup(); }
});

test("C dependency eligibility rejects root fallback, wrong gateway version and changed source before cleanup", () => {
  for (const mutate of [
    value => { rmSync(join(value.root, "ops/gateway/node_modules"), { recursive: true }); mkdirSync(join(value.root, "node_modules/jose"), { recursive: true }); writeFileSync(join(value.root, "node_modules/jose/package.json"), '{"name":"jose","version":"6.2.15"}'); },
    value => { writeFileSync(join(value.root, "ops/gateway/node_modules/jose/package.json"), '{"name":"jose","version":"6.2.15"}'); },
    value => { writeFileSync(join(value.root, "ops/gateway/package-lock.json"), '{"lockfileVersion":3,"packages":{"node_modules/jose":{"version":"6.2.15"}}}'); },
    value => { rmSync(join(value.root, P2_INTERRUPTED_OWNED_SOURCE_FILES[0])); },
  ]) {
    const value = harness();
    try { mutate(value); assert.throws(() => runLifecycle(value)); assert.equal(existsSync(value.workspace), false); }
    finally { value.cleanup(); }
  }
  const changed = harness(tap(), [], undefined, { interruptedSourceMutation: true });
  try { assert.throws(() => runLifecycle(changed)); assert.equal(existsSync(changed.workspace), false); }
  finally { changed.cleanup(); }
});

test("C nonzero, transport and malformed receipts refuse and retain only bounded private diagnostics", () => {
  for (const [settings, failure] of [
    [{ interruptedStatus: 1 }, "child-exit"], [{ interruptedStatus: 125 }, "docker-transport"],
    [{ interruptedSignal: "SIGTERM" }, "child-exit"], [{ interruptedOutput: "" }, "receipt-invalid"],
    [{ interruptedOutput: "{}" }, "receipt-invalid"], [{ interruptedOutput: JSON.stringify({ ...retainedInterruptedReceipt, restoration: undefined }) }, "receipt-invalid"],
  ]) {
    const value = harness(tap(), [], undefined, settings), runner = realpathSync(mkdtempSync(join(tmpdir(), "p2-c-failure-runner-")));
    try {
      let observed;
      withRunnerTemp(runner, () => { try { runLifecycle(value); } catch (error) { observed = p2IdentityFixtureFailureReceipt(error); } });
      assert.equal(observed.phase, "lifecycle-postgres18"); assert.equal(observed.stage, "interrupted-restoration");
      assert.equal(observed.recoveryQualification, "interrupted-restoration"); assert.equal(observed.recoveryFailure, failure);
      assert.equal(JSON.stringify(observed).includes(sourceReadToken), false); assert.equal(existsSync(value.workspace), false);
      const directory = join(runner, "p2-owned-fixture-failure/interrupted-restoration"), name = "d".repeat(40);
      assert.equal(lstatSync(directory).mode & 0o777, 0o700);
      for (const suffix of ["json", "stdout.log", "stderr.log"]) assert.equal(lstatSync(join(directory, `${name}.${suffix}`)).mode & 0o777, 0o600);
      const metadata = JSON.parse(readFileSync(join(directory, `${name}.json`)));
      assert.equal(metadata.qualification, "interrupted-restoration"); assert.equal(metadata.sourceCommit, name); assert.equal(metadata.failure, failure);
    } finally { value.cleanup(); rmSync(runner, { recursive: true, force: true }); }
  }
  const stdout = "OWNED_PRIVATE_DIAGNOSTIC".repeat(200_000), value = harness(tap(), [], undefined,
    { interruptedStatus: 1, interruptedOutput: stdout, interruptedStderr: "OWNED_PRIVATE_STDERR" }),
    runner = realpathSync(mkdtempSync(join(tmpdir(), "p2-c-bounded-failure-")));
  try {
    withRunnerTemp(runner, () => assert.throws(() => runLifecycle(value)));
    const base = join(runner, "p2-owned-fixture-failure/interrupted-restoration", "d".repeat(40)), metadata = JSON.parse(readFileSync(base + ".json"));
    assert.equal(lstatSync(base + ".stdout.log").size, 4 * 1024 * 1024); assert.equal(metadata.stdoutTruncated, true);
    assert.equal(metadata.stderrTruncated, false); assert.equal(metadata.stderrBytes, 20);
  } finally { value.cleanup(); rmSync(runner, { recursive: true, force: true }); }
});

test("operator CI installs exact gateway dependencies and retains the fifth-stage aggregate on success and failure", () => {
  const job = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs["frontend-operator-migrations"];
  const gateway = job.steps.findIndex(step => step.run === "npm ci --ignore-scripts --prefix ops/gateway"),
    fixture = job.steps.findIndex(step => step.run?.includes("prepare-p2-identity-probe-fixtures.mjs"));
  assert.ok(gateway >= 0 && gateway < fixture); assert.equal(job["timeout-minutes"], 20);
  assert.match(job.steps[fixture].run, /--recovery-postgres18 --lifecycle-postgres18\s+> "\$RUNNER_TEMP\/p2-identity-recovery-lifecycle-postgres18.json"/u);
  const success = job.steps.find(step => step.with?.name === "frontend-operator-schema-summary"),
    failure = job.steps.find(step => step.name === "Retain private owned fixture failure diagnostics");
  for (const step of [success, failure]) assert.ok(step.with.path.trim().split(/\r?\n/u).includes("${{ runner.temp }}/p2-identity-recovery-lifecycle-postgres18.json"));
  assert.equal(success.with["retention-days"], 10); assert.equal(failure.with["retention-days"], 3);
});

test("lifecycle receipt parser refuses missing, extra, drifted, skipped and partial source evidence", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
      makeTemporaryDirectory: () => value.workspace }));
    const input = value.calls.find(call => call.file === "docker" && call.args.includes("--postgres18-manifest")).input;
    const expected = { sourceCommits: result.lifecyclePersistence.sourceCommits, sourceSha256: result.lifecyclePersistence.sourceSha256,
      sourceManifestSha256: result.lifecyclePersistence.sourceManifestSha256 };
    const valid = JSON.parse(lifecyclePersistenceReceipt(input));
    assert.equal(parseP2LifecyclePersistencePostgres18Receipt(JSON.stringify(valid), expected).skipped, 0);
    const changes = [receipt => { receipt.postgresMajor = 16; }, receipt => { receipt.skipped = 1; },
      receipt => { receipt.checks = receipt.checks.slice(0, -1); }, receipt => { receipt.sourceManifestSha256 = "1".repeat(64); },
      receipt => { receipt.sourceCommits.course = "1".repeat(40); }, receipt => { delete receipt.sourceSha256["p2-lifecycle-state-witness.mjs"]; },
      receipt => { receipt.unreviewed = true; }];
    for (const change of changes) {
      const receipt = structuredClone(valid); change(receipt);
      assert.throws(() => parseP2LifecyclePersistencePostgres18Receipt(JSON.stringify(receipt), expected),
        /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    }
  } finally { value.cleanup(); }
});

test("receiver receipt parser requires PostgreSQL 18, all twelve checks, eight HTTP cases, and exact mounted source evidence", () => {
  const value = harness();
  try {
    const result = withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
      makeTemporaryDirectory: () => value.workspace }));
    const receiverCall = value.calls.find(call => call.file === "docker" && call.args.includes("ops/platform/test-p2-lifecycle-receivers-local.mjs"));
    const expected = { sourceCommits: result.lifecycleReceivers.sourceCommits, sourceSha256: result.lifecycleReceivers.sourceSha256,
      sourceManifestSha256: result.lifecycleReceivers.sourceManifestSha256 };
    const valid = JSON.parse(lifecycleReceiversReceipt(receiverCall.input));
    assert.equal(parseP2LifecycleReceiversPostgres18Receipt(JSON.stringify(valid), expected).httpCaseCount, 8);
    const changes = [receipt => { receipt.postgresMajor = 16; }, receipt => { receipt.skipped = 1; },
      receipt => { receipt.checks = receipt.checks.slice(0, -1); }, receipt => { receipt.httpCaseCount = 7; },
      receipt => { receipt.globallyReadOnly = true; }, receipt => { receipt.deployedFutureGapQualified = true; },
      receipt => { receipt.sourceManifestSha256 = "1".repeat(64); }, receipt => { receipt.sourceCommits.community = "1".repeat(40); },
      receipt => { delete receipt.sourceSha256["p2-lifecycle-receiver-post.mjs"]; }, receipt => { receipt.unreviewed = true; }];
    for (const change of changes) {
      const receipt = structuredClone(valid); change(receipt);
      assert.throws(() => parseP2LifecycleReceiversPostgres18Receipt(JSON.stringify(receipt), expected),
        /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    }
  } finally { value.cleanup(); }
});

test("lifecycle mode refuses source aliases and mounted hash, extra, or missing drift with fixed diagnostics", () => {
  for (const settings of [{ apiSourceAlias: "course" }, { persistenceSourceMutation: "hash" },
    { persistenceSourceMutation: "extra" }, { persistenceSourceMutation: "missing" }]) {
    const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], settings);
    try {
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
        makeTemporaryDirectory: () => value.workspace })), error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
      assert.equal(JSON.stringify(receipt).includes("private-"), false);
      if (settings.persistenceSourceMutation) {
        assert.equal(receipt.phase, "lifecycle-postgres18"); assert.equal(receipt.stage, "lifecycle");
        assert.equal(receipt.recoveryQualification, "persistence"); assert.equal(receipt.recoveryFailure, "child-exit");
      } else {
        assert.equal(receipt.phase, "exact-source-proof"); assert.equal(value.calls.some(call => call.args?.includes("--postgres18-manifest")), false);
      }
    } finally { value.cleanup(); }
  }
});

test("lifecycle mode cannot be selected without current and forward recovery", () => {
  const value = harness();
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      lifecyclePostgres18: true, run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.length, 0);
  } finally { value.cleanup(); }
});

test("lifecycle child failures expose only fixed persistence diagnostics", () => {
  for (const scenario of [
    { settings: { persistenceStatus: 125, persistenceOutput: "private-output", persistenceStderr: "private-error" }, failure: "docker-transport" },
    { settings: { persistenceStatus: 1, persistenceOutput: "private-output", persistenceStderr: "private-error" }, failure: "child-exit" },
    { settings: { persistenceOutput: "{\"status\":\"private-invalid\"}\n" }, failure: "receipt-invalid" },
  ]) {
    const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], scenario.settings);
    try {
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        recoveryPostgres18: true, lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
        makeTemporaryDirectory: () => value.workspace })), error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
      assert.equal(receipt.phase, "lifecycle-postgres18"); assert.equal(receipt.stage, "lifecycle");
      assert.equal(receipt.recoveryQualification, "persistence"); assert.equal(receipt.recoveryFailure, scenario.failure);
      assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, true);
      assert.equal(JSON.stringify(receipt).includes("private-"), false);
    } finally { value.cleanup(); }
  }
});

test("receiver child failures expose only fixed receiver diagnostics and retain private output", () => {
  const runnerTemporary = realpathSync(mkdtempSync(join(tmpdir(), "p2-owned-receiver-runner-temp-")));
  chmodSync(runnerTemporary, 0o700);
  for (const scenario of [
    { settings: { receiversStatus: 125, receiversOutput: "private-receiver-output", receiversStderr: "private-receiver-error" }, failure: "docker-transport" },
    { settings: { receiversStatus: 1, receiversOutput: "private-receiver-output", receiversStderr: "private-receiver-error" }, failure: "child-exit" },
    { settings: { receiversOutput: "{\"status\":\"private-receiver-invalid\"}\n" }, failure: "receipt-invalid" },
  ]) {
    const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], scenario.settings);
    try {
      let receipt;
      assert.throws(() => withRunnerTemp(runnerTemporary, () => withSourceReadToken(sourceReadToken, () =>
        prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0", recoveryPostgres18: true,
          lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
          makeTemporaryDirectory: () => value.workspace }))), error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
      assert.equal(receipt.phase, "lifecycle-postgres18"); assert.equal(receipt.stage, "receivers");
      assert.equal(receipt.recoveryQualification, "receivers"); assert.equal(receipt.recoveryFailure, scenario.failure);
      assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, true);
      assert.equal(JSON.stringify(receipt).includes("private-receiver"), false);
      const path = join(runnerTemporary, "p2-owned-fixture-failure", "receivers", `${"d".repeat(40)}.json`);
      assert.equal(JSON.parse(readFileSync(path, "utf8")).qualification, "receivers");
      rmSync(join(runnerTemporary, "p2-owned-fixture-failure"), { recursive: true, force: true });
    } finally { value.cleanup(); }
  }
  rmSync(runnerTemporary, { recursive: true, force: true });
});

test("Docker child failure output is retained privately outside disposable checkout with commit binding", () => {
  const runnerTemporary = realpathSync(mkdtempSync(join(tmpdir(), "p2-owned-runner-temp-")));
  chmodSync(runnerTemporary, 0o700);
  const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"],
    { forwardRecoveryStatus: 1, forwardRecoveryOutput: "owned-forward-private-stdout\n", forwardRecoveryStderr: "owned-forward-private-stderr\n" });
  try {
    let publicReceipt;
    assert.throws(() => withRunnerTemp(runnerTemporary, () => withSourceReadToken(sourceReadToken, () =>
      prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0", recoveryPostgres18: true,
        lifecyclePostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat,
        makeTemporaryDirectory: () => value.workspace }))), error => { publicReceipt = p2IdentityFixtureFailureReceipt(error); return true; });
    assert.equal(existsSync(value.workspace), false);
    assert.equal(JSON.stringify(publicReceipt).includes("owned-forward-private"), false);
    assert.equal(publicReceipt.phase, "recovery-postgres18"); assert.equal(publicReceipt.recoveryQualification, "forward");
    const commit = "d".repeat(40), root = join(runnerTemporary, "p2-owned-fixture-failure"), directory = join(root, "forward");
    assert.equal(lstatSync(root).mode & 0o777, 0o700); assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    const stdoutPath = join(directory, `${commit}.stdout.log`), stderrPath = join(directory, `${commit}.stderr.log`);
    const metadataPath = join(directory, `${commit}.json`);
    assert.equal(readFileSync(stdoutPath, "utf8"), "owned-forward-private-stdout\n");
    assert.equal(readFileSync(stderrPath, "utf8"), "owned-forward-private-stderr\n");
    for (const path of [stdoutPath, stderrPath, metadataPath]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(metadataPath, "utf8")), { version: 1, status: "P2_OWNED_FIXTURE_PRIVATE_FAILURE",
      qualification: "forward", sourceCommit: commit, failure: "child-exit", exitStatus: 1, signal: null, spawnError: false,
      stdoutBytes: 29, stderrBytes: 29, stdoutTruncated: false, stderrTruncated: false });
  } finally { value.cleanup(); rmSync(runnerTemporary, { recursive: true, force: true }); }
});

test("CI uploads only the fixed private failure directory and wrapper receipt for three days", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /Retain private owned fixture failure diagnostics\n\s+if: failure\(\)\n\s+uses: actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f/u);
  const step = parse(workflow).jobs["frontend-operator-migrations"].steps.find(step => step.name === "Retain private owned fixture failure diagnostics");
  assert.equal(step.if, "failure()");
  assert.equal(step.with.name, "p2-owned-fixture-failure-${{ github.event.pull_request.head.sha || github.sha }}");
  assert.deepEqual(step.with.path.trim().split(/\r?\n/u), ["${{ runner.temp }}/p2-owned-fixture-failure/", "${{ runner.temp }}/p2-platform-postgres18.json",
    "${{ runner.temp }}/p2-identity-recovery-lifecycle-postgres18.json"]);
  assert.equal(step.with["if-no-files-found"], "ignore");assert.equal(step.with["retention-days"], 3);
  assert.deepEqual(Object.keys(step.with).sort(), ["name", "path", "if-no-files-found", "retention-days"].sort());
});

test("Docker context accepts only an existing local Unix socket", () => {
  const socket = "/tmp/lash-her-owned-docker.sock";
  const ownedSocket = path => {
    assert.equal(path, socket);
    return { isSocket: () => true, isSymbolicLink: () => false, uid: process.getuid() };
  };
  assert.equal(parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), ownedSocket), `unix://${socket}`);
  for (const endpoint of ["tcp://127.0.0.1:2375", "ssh://operator@example.test", "unix://operator:secret@/tmp/docker.sock",
    "unix:///tmp/docker.sock?option=true", "unix://relative.sock", "not-json"]) {
    assert.throws(() => parseP2DockerContextEndpoint(endpoint === "not-json" ? endpoint : JSON.stringify(endpoint), ownedSocket),
      /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED|SyntaxError/u, endpoint);
  }
  assert.throws(() => parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }), /missing/u);
  for (const info of [
    { isSocket: () => false, isSymbolicLink: () => false },
    { isSocket: () => true, isSymbolicLink: () => true },
  ]) assert.throws(() => parseP2DockerContextEndpoint(JSON.stringify(`unix://${socket}`), () => info),
    /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("recovery failures expose only fixed Docker transport and child exit diagnostics", () => {
  for (const scenario of [
    { settings: { dockerContextOutput: JSON.stringify("tcp://127.0.0.1:2375") }, expected: "docker-transport", attempted: false },
    { settings: { dockerSocketMissing: true }, expected: "docker-transport", attempted: false },
    { settings: { recoveryStatus: 125, recoveryOutput: "private-output", recoveryStderr: "private-error" }, expected: "docker-transport", attempted: true },
    { settings: { recoveryStatus: 1, recoveryOutput: "private-output", recoveryStderr: "private-error" }, expected: "child-exit", attempted: true },
  ]) {
    const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], scenario.settings);
    try {
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        recoveryPostgres18: true, run: value.run, dockerSocketStat: value.dockerSocketStat, makeTemporaryDirectory: () => value.workspace })),
      error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
      assert.equal(receipt.phase, "recovery-postgres18"); assert.equal(receipt.stage, "recovery");
      assert.equal(receipt.recoveryQualification, "current");
      assert.equal(receipt.recoveryFailure, scenario.expected);
      assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, scenario.attempted);
      assert.equal(JSON.stringify(receipt).includes("private-"), false);
    } finally { value.cleanup(); }
  }
});

test("recovery mode refuses persisted API Git authentication before permission changes or Docker", () => {
  const value = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"],
    { apiGitConfigSuffix: `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic ${sourceReadToken}\n` });
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
  } finally { value.cleanup(); }
});

test("recovery mode refuses a frontend mount that resolves outside the exact source", () => {
  const value = harness();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "p2-identity-private-outside-")));
  try {
    rmSync(join(value.root, "node_modules"), { recursive: true });
    symlinkSync(outside, join(value.root, "node_modules"), "dir");
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.some(call => call.file === "docker"), false);
  } finally { value.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("refuses ignored source, environment configuration, and unreviewed dependency roots", () => {
  for (const ignored of ["src/auth/foreign.ts", ".env.staging", "ops/foreign/node_modules/runtime/index.js", "tsconfig.hidden.json"]) {
    const value = harness(tap(), [ignored]);
    try {
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u, ignored);
      assert.equal(value.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
    } finally { value.cleanup(); }
  }
  const missingLock = harness(tap(), ["ops/gateway/node_modules/runtime/index.js"], []);
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: missingLock.root, nodeVersion: "24.18.0",
      run: missingLock.run, makeTemporaryDirectory: () => missingLock.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(missingLock.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
  } finally { missingLock.cleanup(); }
});

test("refuses a noncanonical repository, mismatched event revision, or artifact digest", () => {
  for (const mutate of [value => { value.artifacts.course.repository = "foreign-course"; }, value => { value.artifacts.enrollmentEvent.revision = "9".repeat(40); },
    value => { value.artifacts.community.sha256 = "0".repeat(64); }]) {
    const value = fixtureManifest(); mutate(value);
    assert.throws(() => validateP2IdentityFixtureManifest(Buffer.from(JSON.stringify(value))), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
  }
});

test("refuses skipped, failed, partial, or duplicated TAP summaries", () => {
  for (const output of [tap({ pass: 18, skipped: 1 }), tap({ pass: 18, fail: 1 }), tap({ tests: 18, pass: 18 }), tap() + "# pass 19\n"])
    assert.throws(() => parseP2IdentityProbeTap(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("recovery receipt refuses wrong major, migration counts, skips, replay, or extra output", () => {
  for (const output of [recoveryReceipt({ serverMajor: 16 }), recoveryReceipt({ frontendMigrations: 82 }),
    recoveryReceipt({ courseMigrations: 21 }), recoveryReceipt({ communityMigrations: 10 }), recoveryReceipt({ skipped: 1 }),
    recoveryReceipt({ checks: 14 }), recoveryReceipt({ checks: 50 }), recoveryReceipt({ privilegeFaults: [] }),
    recoveryReceipt({ frontendInitialPrivilegeRefusals: 16 }), recoveryReceipt({ frontendContinuousPrivilegeRefusals: 16 }),
    recoveryReceipt({ apiPrivilegeRefusals: 21 }),
    recoveryReceipt({ legacyApiVerifierRefusals: 1 }), recoveryReceipt({ frontendCreatorMemberships: 2 }),
    recoveryReceipt({ frontendOperatorSearchPathPinned: false }),
    recoveryReceipt({ environmentIsolation: { nodeOptionsPositiveControlExecuted: true } }), recoveryReceipt({ noSqlReplay: false }),
    recoveryReceipt({ originalFrontendTerminalRecreated: true }), recoveryReceipt() + "private-output\n"])
    assert.throws(() => parseP2RecoveryPostgres18Receipt(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("forward recovery receipt refuses wrong mode, PG16, echoed current proof, missing checks, skips, and runtime claims", () => {
  const checks = JSON.parse(forwardRecoveryReceipt()).checks;
  for (const output of [recoveryReceipt(), forwardRecoveryReceipt({ status: "OWNED_P2_RECOVERY_DATABASE_CHECKS_PASS" }),
    forwardRecoveryReceipt({ serverMajor: 16 }), forwardRecoveryReceipt({ frontendMigrations: 82 }),
    forwardRecoveryReceipt({ courseMigrations: 21 }), forwardRecoveryReceipt({ communityMigrations: 10 }),
    forwardRecoveryReceipt({ checks: checks.slice(0,-1) }), forwardRecoveryReceipt({ checks: [...checks,checks[0]] }),
    forwardRecoveryReceipt({ mutationRefusals: 0 }), forwardRecoveryReceipt({ skipped: 1 }),
    forwardRecoveryReceipt({ runtimeCredentialRefusals: 0 }), forwardRecoveryReceipt({ runtimeCredentialRefusals: undefined }),
    forwardRecoveryReceipt({ foreignRuntimeTlsAuthenticated: false }), forwardRecoveryReceipt({ runtimeCredentialFaultProviderCalls: 1 }),
    forwardRecoveryReceipt({ noSqlReplay: false }), forwardRecoveryReceipt({ journalDigestsUnchanged: false }),
    forwardRecoveryReceipt({ originalFrontendTerminalRecreated: true }), forwardRecoveryReceipt({ actualRuntimeContainers: true }),
    forwardRecoveryReceipt({ environmentIsolation: { childEnvironmentAllowlistEnforced: true } }),
    forwardRecoveryReceipt({ unreviewedExtra: true }), forwardRecoveryReceipt() + "private-output\n"])
    assert.throws(() => parseP2ForwardRecoveryPostgres18Receipt(output), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
});

test("forward parser matches the retained actual nineteen-case producer receipt", () => {
  const original = JSON.parse(readFileSync(new URL("../../docs/api-integration/baselines/2026-11-06-p2-forward-review-corrections/owned-forward-postgres16.json", import.meta.url), "utf8"));
  assert.equal(original.serverMajor, 16);
  assert.throws(() => parseP2ForwardRecoveryPostgres18Receipt(JSON.stringify(original)), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
  // This projection verifies only the fixed shared receipt schema; it is not
  // PostgreSQL18 evidence. Actual CI must independently produce that major.
  const projected = { ...original, serverMajor: 18 };
  assert.deepEqual(parseP2ForwardRecoveryPostgres18Receipt(JSON.stringify(projected)), projected);
});

test("a forward qualification failure reports only the fixed forward mode and no child output", () => {
  for (const settings of [
    { forwardRecoveryStatus: 125, forwardRecoveryOutput: "private-output", forwardRecoveryStderr: "private-error" },
    { forwardRecoveryStatus: 1, forwardRecoveryOutput: "private-output", forwardRecoveryStderr: "private-error" },
    { forwardRecoveryOutput: forwardRecoveryReceipt({ skipped: 1 }) },
  ]) {
    const value=harness(tap(),[],["ops/gateway","tools/api-contract-toolchain"],settings);try{
      let receipt;
      assert.throws(()=>withSourceReadToken(sourceReadToken,()=>prepareP2IdentityProbeFixtures({frontendRoot:value.root,nodeVersion:"24.18.0",
        recoveryPostgres18:true,run:value.run,dockerSocketStat:value.dockerSocketStat,makeTemporaryDirectory:()=>value.workspace})),
      error=>{receipt=p2IdentityFixtureFailureReceipt(error);return true;});
      assert.equal(receipt.phase,"recovery-postgres18");assert.equal(receipt.stage,"recovery");
      assert.equal(receipt.recoveryQualification,"forward");assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted,true);
      assert.equal(JSON.stringify(receipt).includes("private-"),false);
      const runs=value.calls.filter(call=>call.file==="docker"&&call.args[0]==="--host");assert.equal(runs.length,2);
      assert.equal(runs[0].args.includes("--forward-brand"),false);assert.equal(runs[1].args.at(-1),"--forward-brand");
    }finally{value.cleanup();}
  }
});

test("failures expose only fixed diagnostic phases and never private child output", () => {
  const scenarios = [
    { phase: "source-fetch", stage: "course", fail: (_file, args, options) =>
      options.cwd.endsWith("lash-her-course-api") && args[0] === "fetch" },
    { phase: "npm-ci", stage: "course", fail: (file, args, options) =>
      file === "npm" && args[0] === "ci" && options.cwd.endsWith("lash-her-course-api") },
    { phase: "build", stage: "course", fail: (file, args, options) =>
      file === "npm" && args[0] === "run" && options.cwd.endsWith("lash-her-course-api") },
    { phase: "exact-source-proof", stage: "course", fail: (file, args, options) =>
      file === "git" && args.join(" ") === "remote get-url origin" && options.cwd.endsWith("lash-her-course-api") },
  ];
  for (const scenario of scenarios) {
    const value = harness();
    try {
      const refusingRun = (file, args, options) => scenario.fail(file, args, options) ?
        { status: 1, signal: null, stdout: "private-child-output", stderr: "private-child-error" } : value.run(file, args, options);
      let receipt;
      assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: refusingRun, makeTemporaryDirectory: () => value.workspace })), error => {
        receipt = p2IdentityFixtureFailureReceipt(error); return true;
      });
      assert.equal(receipt.phase, scenario.phase); assert.equal(receipt.stage, scenario.stage);
      assert.equal(JSON.stringify(receipt).includes("private-child"), false);
    } finally { value.cleanup(); }
  }
  const identity = harness(tap({ pass: 18, skipped: 1 }));
  try {
    let receipt;
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: identity.root, nodeVersion: "24.18.0",
      run: identity.run, makeTemporaryDirectory: () => identity.workspace })), error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
    assert.equal(receipt.phase, "identity-tests"); assert.equal(receipt.stage, "identity");
  } finally { identity.cleanup(); }
  const recovery = harness(tap(), [], ["ops/gateway", "tools/api-contract-toolchain"], { recoveryOutput: recoveryReceipt({ checks: 14 }) });
  try {
    let receipt;
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: recovery.root, nodeVersion: "24.18.0",
      recoveryPostgres18: true, run: recovery.run, dockerSocketStat: recovery.dockerSocketStat, makeTemporaryDirectory: () => recovery.workspace })),
    error => { receipt = p2IdentityFixtureFailureReceipt(error); return true; });
    assert.equal(receipt.phase, "recovery-postgres18"); assert.equal(receipt.stage, "recovery");
    assert.equal(receipt.ownedDisposableDatabaseExecutionAttempted, true);
    assert.equal(receipt.databaseConnected, null); assert.equal(receipt.sqlExecuted, null);
    assert.equal(receipt.recoveryFailure, "receipt-invalid");
    assert.equal(receipt.recoveryQualification, "current");
  } finally { recovery.cleanup(); }
  assert.deepEqual(p2IdentityFixtureFailureReceipt(new Error("private")), { version: 1, status: "P2_IDENTITY_PROBE_FIXTURES_REFUSED",
    phase: "preflight", stage: "frontend", fixtureOnly: true, providerTouched: false, stagingTouched: false,
    databaseConnected: false, sqlExecuted: false, ownedDisposableDatabaseExecutionAttempted: false, releaseAccepted: false });
});

test("refuses a non-Node-24 executor before source fetch", () => {
  const value = harness();
  try {
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "26.5.0", run: value.run,
      makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(value.calls.length, 0); assert.equal(existsSync(value.workspace), true);
  } finally { value.cleanup(); }
});

test("refuses a missing or structurally unsafe private source token before Git", () => {
  for (const token of [undefined, "short", "x".repeat(19) + "\n"]) {
    const value = harness();
    try {
      assert.throws(() => withSourceReadToken(token, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
        run: value.run, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
      assert.equal(value.calls.some(call => call.file === "git" && call.args[0] === "fetch"), false);
    } finally { value.cleanup(); }
  }
});

test("removes the complete disposable checkout after a build refusal", () => {
  const value = harness();
  try {
    const refusingRun = (file, args, options) => file === "npm" && args[0] === "run" ?
      { status: 1, signal: null, stdout: "", stderr: "private diagnostic must not escape" } : value.run(file, args, options);
    assert.throws(() => withSourceReadToken(sourceReadToken, () => prepareP2IdentityProbeFixtures({ frontendRoot: value.root, nodeVersion: "24.18.0",
      run: refusingRun, makeTemporaryDirectory: () => value.workspace })), /P2_IDENTITY_FIXTURE_PREPARATION_REFUSED/u);
    assert.equal(existsSync(value.workspace), false);
  } finally { value.cleanup(); }
});

test("fixture manifest used by the test remains byte readable", () => {
  const value = harness();
  try { assert.equal(validateP2IdentityFixtureManifest(readFileSync(join(value.root, "contracts/api-integration/p2-candidate/manifest.json"))).status, "released"); }
  finally { value.cleanup(); }
});

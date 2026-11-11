// A disposable TLS PostgreSQL rehearsal of the recovered frontend continuation.
// The wire peer models the API runtime and Vercel. It performs real PostgreSQL
// lock readbacks and never reaches Docker or a live provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Client } from "pg";
import { bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact, frontendAdmissionTargetSha256 } from "../frontend-admission-bootstrap.mjs";
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "../frontend-migration.mjs";
import { applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES as roles, prepareFrontendRolesPlan } from "../frontend-role-preparation.mjs";
import { readMigrationCatalog } from "../frontend-schema.mjs";
import { abortP2FrontendReplacement } from "../p2-frontend-replacement-abort.mjs";
import { observeP2FrontendReplacementClosed } from "../p2-frontend-replacement-closed.mjs";
import { createP2FrontendReplacementProbe, observeP2FrontendReplacement, verifyP2FrontendReplacementSession } from "../p2-frontend-replacement-probe.mjs";
import { continueP2FrontendReplacementRecovery } from "../p2-frontend-replacement-recovery.mjs";
import { observeP2FrontendReplacementWritten } from "../p2-frontend-replacement-written.mjs";
import { exchangeFrontendReplacementWrite } from "../p2-frontend-replacement-write-transport.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "../qualification-target-profile.mjs";
import { openOwnedFrontendReplacementCluster } from "./owned-frontend-replacement-cluster.mjs";

const raw = value => Buffer.from(JSON.stringify(value) + "\n");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const decode = bytes => JSON.parse(bytes.toString("utf8"));
const encode = bytes => bytes.toString("base64");
const releaseId = "owned-replacement-recovery";
const migrationUser = "owned_frontend_recovery";
const producerSha256 = "d".repeat(64);
const sourceCommit = "a".repeat(40);
const migrationImageDigest = "sha256:" + "b".repeat(64);
const journalSql = "SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at,id";
let failedTrace = [], failedPeerLine;

function fixtureLine(error) {
  const frame = error.stack?.split("\n").find(line => line.includes("owned-frontend-replacement-recovery.mjs:"));
  return Number(/owned-frontend-replacement-recovery\.mjs:(\d+):(\d+)/u.exec(frame ?? "")?.[1]) || null;
}

async function applyFixtureMigrations(client, migrations) {
  await client.query("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)");
  for (const { sql, hash: migrationHash, folderMillis } of migrations) {
    await client.query("BEGIN");
    try {
      for (const statement of sql) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [migrationHash, folderMillis]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

function frontendSelection(cluster, artifact, serverMajor, catalog) {
  const { contractManifestSha256, contractPhase, phase2ContractManifestSha256, sqlArtifactSha256, migrations } = artifact;
  const target = { host: "127.0.0.1", port: cluster.port, database: "owned_replacement", user: migrationUser, runtimeRole: roles.runtime, serverMajor };
  const predecessorTarget = { ...target, database: "owned_predecessor", runtimeRole: "owned_previous_runtime" };
  const contracts = { contractManifestSha256, contractPhase, phase2ContractManifestSha256 };
  const baseline = { version: 1, serverMajor, sqlArtifactSha256, catalog };
  const schemaBaselineSha256 = hash(JSON.stringify(baseline));
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging", releaseId,
    sourceCommit, ...contracts, migrationImageDigest, sqlArtifactSha256, schemaBaselineSha256, recoveryRef: "owned/recovery",
    target: { ...target, qualificationTargetProfile: profile, allowEmptyBootstrap: true, approvedPendingTags: migrations.map(row => row.tag) } };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId, ...contracts,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } },
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256, ...contracts, schemaBaselines: { [serverMajor]: schemaBaselineSha256 } } };
  const probeSelection = { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate, job, baseline, predecessorTarget, targetSha256: frontendAdmissionTargetSha256("staging", target) };
  return { candidate, job, target, probeSelection };
}

function wireInput(packet) {
  const { probe: originalProbe } = packet;
  const { targetSha256, candidate, job, predecessorTarget, databaseOid, migrationRoleOid } = originalProbe;
  const { approvedPendingTags, qualificationTargetProfile, allowEmptyBootstrap, ...target } = job.target;
  assert.equal(allowEmptyBootstrap, true);
  assert.deepEqual(qualificationTargetProfile, profile);
  const shared = { version: 1, qualificationTargetProfile: profile, environment: "staging", releaseId, sourceCommit,
    candidateSha256: hash(raw(candidate)), targetSha256 };
  const plan = { ...shared, phase2ContractManifestSha256: job.phase2ContractManifestSha256,
    status: "P2_FRONTEND_REPLACEMENT_PLAN_PREPARED", predecessor: { target: predecessorTarget },
    replacement: { target, databaseOid, migrationRoleOid, approvedPendingTags, administrativeLogins: packet.administrativeLogins } };
  const planBytes = raw(plan), reviewedPlanSha256 = hash(planBytes), hostMachineId = "b".repeat(32);
  const review = { ...shared, reviewedPlanSha256, hostMachineId, producerSha256,
    apiJobSha256: { course: "1".repeat(64), community: "2".repeat(64) }, configurationSha256: { "gateway.json": "3".repeat(64) } };
  const reviewBytes = raw(review), runtimeReviewSha256 = hash(reviewBytes);
  const recovery = { originalProbe, ...Object.fromEntries(["physicalObservation", "databaseReceipt", "continuationStarted", "writtenObservation"]
    .map(field => [field, Buffer.from(packet[field], "base64")])) };
  const originalEvidenceSha256 = Object.fromEntries(Object.entries(recovery).filter(([field]) => field !== "originalProbe").map(([field, bytes]) => [field, hash(bytes)]));
  originalEvidenceSha256.abortObservation = hash(Buffer.from(packet.abortObservation, "base64"));
  for (const [field, digit] of [["runtimeOutcome", "4"], ["writeContainment", "5"], ["runtimeContainment", "6"]])
    originalEvidenceSha256[field] = digit.repeat(64);
  const originalRoot = "/var/lib/lash-her/releases/staging/owned-original";
  const originalDirectory = originalRoot + `/p2-profiled-replacement-write-${releaseId}`;
  const actionId = "owned-recovery-action";
  const recoveryReviewBytes = raw({ actionId, originalDirectory, originalEvidenceSha256 });
  const recoveryReviewSha256 = hash(recoveryReviewBytes);
  const initial = { ...shared, mode: "p2-profiled-frontend-replacement-write", hostMachineId, reviewedPlanSha256, reviewedPlanBytes: encode(planBytes),
    runtimeReviewSha256, runtimeReviewBytes: encode(reviewBytes), operatorSourceCommit: "9".repeat(40), results: originalRoot + "/" + actionId,
    recoveryReviewSha256, recoveryReviewBytes: encode(recoveryReviewBytes),
    confirmation: `staging/${releaseId}/replacement-write/${reviewedPlanSha256}/${runtimeReviewSha256}/recover/${recoveryReviewSha256}`,
    vercelToken: "owned-fixture" };
  return { initial, plan, review, recovery };
}

function controlledPeer(selection, packet, getUrl, contender, scenario) {
  const { initial, plan, review, recovery } = selection;
  const { qualificationTargetProfile, environment, candidateSha256, targetSha256, phase2ContractManifestSha256 } = plan;
  const { reviewedPlanSha256, runtimeReviewSha256 } = initial;
  const { configurationSha256, apiJobSha256 } = review;
  const postflightSha256 = hash(recovery.writtenObservation);
  const frontendContinuationStartedSha256 = hash(recovery.continuationStarted);
  const frontendDatabaseReceiptSha256 = hash(recovery.databaseReceipt);
  const frontend = decode(recovery.writtenObservation);
  const common = { version: 2, qualificationTargetProfile, environment, releaseId, candidateSha256, contractPhase: "p2",
    phase2ContractManifestSha256, phase: "completed", frontendSqlApplied: true, frontendMigrationMode: "apply-forward",
    frontendReadOnlyVerified: false, frontendSqlReplayed: false, frontendReplacementReadbackSha256: postflightSha256,
    frontendContinuationStartedSha256, trafficAuthorized: false, historicalProviderClosureClaimed: false, oldP200Qualified: false,
    nativeSchedulesEnabled: false, releaseAccepted: false };
  const migration = { ...common, status: "API_DATABASES_VERIFIED_FRONTEND_CONTINUATION_OPEN",
    databaseReceiptSha256: { frontend: frontendDatabaseReceiptSha256 } };
  const migrationOutcomeSha256 = hash(raw(migration));
  const runtime = { ...common, status: "API_RUNTIME_READY", sourceCommit, configurationSha256, migrationOutcomeSha256, frontendPromotionAuthorized: false };
  const runtimeOutcomeSha256 = hash(raw(runtime));
  const base = { qualificationTargetProfile, environment, releaseId, sourceCommit, targetSha256, candidateSha256,
    version: 2, configurationSha256, postflightSha256, reviewedPlanSha256, runtimeReviewSha256, migrationOutcomeSha256,
    runtimeOutcomeSha256, contractPhase: "p2", phase2ContractManifestSha256, frontendSqlApplied: true, frontendSqlReplayed: false,
    historicalProviderClosureClaimed: false, oldP200Qualified: false, nativeSchedulesEnabled: false, trafficAuthorized: false, releaseAccepted: false };
  const identity = { deploymentId: "dpl_ownedRecovery", environment, releaseId, sourceCommit, trafficAuthorized: false };
  const proof = { ...base, ...identity, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED" };
  const workload = { ...identity, status: "FRONTEND_VERIFIED" }, promotion = { ...identity, status: "FRONTEND_DOMAINS_PROMOTED" };
  const submitted = { proof: raw(proof), workload: raw(workload), promotion: raw(promotion) };
  const proofSha256 = hash(submitted.proof);
  const records = new Map([["p2-frontend-replacement-written-observation.json", recovery.writtenObservation]]);
  const record = (name, value) => records.set(name, Buffer.isBuffer(value) ? value : raw(value));
  const trace = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let probe, failed = false, closed = false, sessionClosedSha256, commitIntentSha256, finished = false, callbackChecks = 0;
  const assertPhysical = async () => {
    assert.equal((await observeP2FrontendReplacement(probe, { getUrl })).backendPid, probe.backendPid);
    assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [FRONTEND_MIGRATION_LOCK])).rows[0].acquired, false);
    callbackChecks++;
  };
  async function processFrame(frame) {
    const { operation, id = 0 } = frame;
    if (operation !== "check") trace.push(operation ?? "initial");
    switch (operation) {
      case undefined:
        assert.deepEqual(frame, initial);
        return { id, status: "LOCKED" };
      case "check":
        return { id, status: "LOCKED" };
      case "resume-replacement-written":
        probe = frame.probe;
        assert.notEqual(probe.backendPid, recovery.originalProbe.backendPid);
        assert.notEqual(probe.marker, recovery.originalProbe.marker);
        await assertPhysical();
        record("p2-frontend-replacement-recovery-physical-observation.json", await observeP2FrontendReplacement(probe, { getUrl }));
        return { id, status: "REPLACEMENT_WRITTEN_RESUMED", postflightSha256 };
      case "start-replacement-runtime":
        await assertPhysical();
        assert.equal(frame.postflightSha256, postflightSha256);
        if (scenario === "backend-loss") {
          assert.equal((await contender.query("SELECT pg_terminate_backend($1,5000) AS stopped", [probe.backendPid])).rows[0].stopped, true);
          await assert.rejects(observeP2FrontendReplacement(probe, { getUrl }));
          throw new Error("OWNED_RECOVERY_BACKEND_LOST");
        }
        record("p2-frontend-replacement-runtime-intent.json", { version: 1, qualificationTargetProfile, environment, releaseId, sourceCommit,
          candidateSha256, targetSha256, reviewedPlanSha256, runtimeReviewSha256, postflightSha256, apiJobSha256, configurationSha256,
          status: "P2_FRONTEND_REPLACEMENT_RUNTIME_STARTED", trafficAuthorized: false });
        record("migration-outcome.json", migration);
        record("runtime-outcome.json", runtime);
        return { id, status: "REPLACEMENT_API_RUNTIME_READY", migrationOutcomeSha256, runtimeOutcomeSha256 };
      case "verify-replacement-frontend":
        await assertPhysical();
        for (const [key, name] of Object.entries({ proof: "deployment-proof", workload: "workload-outcome", promotion: "promotion-outcome" })) {
          assert.deepEqual(Buffer.from(frame[key], "base64"), submitted[key]);
          record("frontend-" + name + ".json", submitted[key]);
        }
        return { id, status: "REPLACEMENT_FRONTEND_VERIFIED", proofSha256 };
      case "prepare-replacement-close":
        await assertPhysical();
        record("p2-frontend-replacement-close-prepared.json", { version: 1, qualificationTargetProfile, environment, releaseId, sourceCommit,
          candidateSha256, targetSha256, reviewedPlanSha256, status: "P2_FRONTEND_REPLACEMENT_CLOSE_PREPARED", bootstrapAuthorized: false,
          migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false, providerProofSha256: proofSha256 });
        return { id, status: "REPLACEMENT_CLOSE_PREPARED" };
      case "observe-replacement-closed": {
        await assert.rejects(observeP2FrontendReplacement(probe, { getUrl }));
        const { abortObservation, ...closedPacket } = packet;
        assert.equal(typeof abortObservation, "string");
        const closedReceipt = raw(await observeP2FrontendReplacementClosed(closedPacket, { getUrl }));
        record("frontend-session-closed.json", closedReceipt);
        sessionClosedSha256 = hash(closedReceipt);
        return { id, status: "REPLACEMENT_SESSION_CLOSED", sessionClosedSha256 };
      }
      case "finish-replacement": {
        assert.ok(sessionClosedSha256);
        const bytes = Object.fromEntries(["terminal", "continuationCompleted", "releaseOutcome"].map(key => [key, Buffer.from(frame[key], "base64")]));
        record("frontend-job-outcome.json", bytes.terminal);
        record("frontend-continuation-completed.json", bytes.continuationCompleted);
        record("frontend-release-outcome.json", bytes.releaseOutcome);
        const intent = { ...base, status: "P2_FRONTEND_REPLACEMENT_WRITE_COMMIT_INTENT", frontendSessionClosed: true, migrationMode: "apply-forward",
          deploymentId: identity.deploymentId, owner: frontend.owner, runtime: frontend.runtime, producerSha256,
          frontendDatabaseReceiptSha256, frontendContinuationStartedSha256, frontendTerminalSha256: hash(bytes.terminal),
          frontendContinuationCompletedSha256: hash(bytes.continuationCompleted), frontendReleaseOutcomeSha256: hash(bytes.releaseOutcome),
          frontendSessionClosedSha256: sessionClosedSha256, frontendDeploymentProofSha256: proofSha256,
          frontendWorkloadReceiptSha256: hash(submitted.workload), frontendPromotionReceiptSha256: hash(submitted.promotion) };
        commitIntentSha256 = hash(raw(intent));
        record("p2-frontend-replacement-write-commit-intent.json", intent);
        record("p2-frontend-replacement-write-outcome.json", { ...intent, status: "P2_FRONTEND_REPLACEMENT_READY_FOR_CERTIFICATION" });
        finished = true;
        return { id, status: "REPLACEMENT_JOINED", commitIntentSha256 };
      }
      case "commit":
        assert.ok(finished);
        return { id, status: "COMMITTED", commitIntentSha256 };
      default:
        assert.fail("unreviewed write command");
    }
  }
  function reap(status, signal) {
    if (closed) return;
    closed = true;
    child.stdout.end();
    setImmediate(() => child.emit("close", status, signal));
  }
  child.kill = signal => reap(null, signal);
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      // Let the transport continue to send heartbeat frames during readbacks.
      const frame = decode(chunk);
      callback();
      void processFrame(frame).then(response => {
        if (!closed) child.stdout.write(raw(response));
      }, error => {
        failedPeerLine = fixtureLine(error);
        failed = true;
        if (!closed) child.stdout.write(raw({ id: frame.id ?? 0, status: "P2_HOST_STAGE_FAILED" }));
        reap(1, null);
      });
    },
    final(callback) {
      reap(finished && !failed ? 0 : 1, null);
      callback();
    },
  });
  return { child, trace, checks: () => callbackChecks, proof: submitted,
    releaseOutcome: { ...base, status: "P2_FRONTEND_REPLACEMENT_FRONTEND_VERIFIED", deploymentProofSha256: proofSha256 },
    async readHostEvidence(name) {
      const bytes = records.get(name);
      assert.ok(bytes);
      return bytes;
    } };
}

async function rehearse() {
  assert.equal(process.env.P2_REPLACEMENT_RECOVERY_OWNED_TEST, "true");
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.equal(process.argv.length, 2);
  const pgBin = process.env.PG_BIN;
  assert.equal(realpathSync(pgBin), pgBin);
  const serverMajor = Number(/PostgreSQL\) (16|18)\./u.exec(execFileSync(join(pgBin, "postgres"), ["--version"], { encoding: "utf8" }))?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "p2-recovery-owned-"));
  const privateDir = name => { const path = join(directory, name); mkdirSync(path, { mode: 0o700 }); return path; };
  const key = join(directory, "server.key"), cert = join(directory, "server.crt");
  const originalCa = getCACertificates("default"), clients = [];
  let cluster;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCa, readFileSync(cert, "utf8")]);
    cluster = await openOwnedFrontendReplacementCluster(privateDir("cluster"), pgBin, migrationUser, key, cert,
      process.getuid() === 0 ? { runAsPostgres: true } : {});
    const setup = await cluster.connect("postgres");
    clients.push(setup);
    for (const database of ["owned_replacement", "owned_reference"]) {
      await setup.query(`CREATE DATABASE ${database}`);
      await setup.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    }
    const reference = await cluster.connect("owned_reference");
    clients.push(reference);
    const artifact = frontendMigrationArtifact();
    await applyFixtureMigrations(reference, artifact.migrations);
    const { job, target, candidate, probeSelection } = frontendSelection(cluster, artifact, serverMajor, await readMigrationCatalog(reference));
    const password = randomUUID();
    const url = `postgresql://${target.user}:${password}@${target.host}:${target.port}/${target.database}?sslmode=verify-full`;
    const getUrl = () => url;
    const migration = new Client(frontendConnectionOptions(url, target));
    clients.push(migration);
    await migration.connect();
    const contender = await cluster.connect(target.database);
    clients.push(contender);
    await migration.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const { rows: [identity] } = await migration.query(`SELECT datid::text AS "databaseOid",usesysid::text AS "migrationRoleOid"
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
    await migration.query("SELECT pg_advisory_lock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    const originalProbe = await createP2FrontendReplacementProbe({ ...probeSelection, ...identity }, migration, async () => {});
    const physicalObservation = raw(await observeP2FrontendReplacement(originalProbe, { getUrl }));
    const verifySession = () => verifyP2FrontendReplacementSession(migration, originalProbe);
    const confirmation = `staging/${releaseId}`;
    const credentials = privateDir("roles-private");
    const { owner, runtime, producers } = await applyPreparedFrontendRoles(prepareFrontendRolesPlan(candidate, job,
      { version: 2, qualificationTargetProfile: profile, producerSha256: [producerSha256] }, profile), migration,
    { confirmation, directory: privateDir("roles"), privateDirectory: credentials, verifyEnvironment: async () => {}, verifySession }, profile);
    await bootstrapFrontendAdmission({
      version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: releaseId, sourceCommit,
      sqlSha256: frontendAdmissionBootstrapArtifact().sqlSha256, inventorySha256: "c".repeat(64),
      targetSha256: originalProbe.targetSha256, target: job.target, owner, producers,
    }, migration, { confirmation, verifySession, record: () => {} }, profile);
    await applyFixtureMigrations(migration, artifact.migrations);
    const after = (await contender.query(journalSql)).rows;
    assert.equal(after.length, 83);
    const binding = Object.fromEntries(Object.entries(job).filter(([key]) => key !== "target"));
    const receiptTarget = Object.fromEntries(Object.entries(target).filter(([key]) => key !== "runtimeRole"));
    const receiptBase = { ...binding, service: "frontend", target: receiptTarget, migrationMode: "apply-forward", trafficAuthorized: false };
    const databaseReceipt = raw({ ...receiptBase, status: "DATABASE_VERIFIED", before: [], after,
      applied: artifact.migrations.map(({ tag, hash: migrationHash }) => ({ tag, hash: migrationHash })),
      schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: false });
    const continuationStarted = raw({ ...receiptBase, status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true });
    const writtenPacket = { probe: originalProbe, physicalObservation: encode(physicalObservation), databaseReceipt: encode(databaseReceipt),
      continuationStarted: encode(continuationStarted), owner, runtime, producerSha256, administrativeLogins: [] };
    const writtenObservation = raw(await observeP2FrontendReplacementWritten(writtenPacket, { getUrl }));
    await migration.end();
    const abortObservation = raw(await abortP2FrontendReplacement(originalProbe, physicalObservation, { getUrl }));
    const packet = { ...writtenPacket, writtenObservation: encode(writtenObservation), abortObservation: encode(abortObservation) };
    const runtimeDatabaseUrl = new URL(url);
    runtimeDatabaseUrl.username = runtime.name;
    runtimeDatabaseUrl.password = JSON.parse(readFileSync(join(credentials, "frontend-role-credentials.json"), "utf8")).password;
    const selection = wireInput(packet);
    for (const scenario of ["backend-loss", "success"]) {
      const peer = controlledPeer(selection, packet, getUrl, contender, scenario);
      failedTrace = peer.trace;
      failedPeerLine = undefined;
      const results = privateDir(scenario);
      const action = exchangeFrontendReplacementWrite(peer.child, selection.initial, selection.plan, host =>
        continueP2FrontendReplacementRecovery({ host, packet, getUrl, directory: results,
          runtimeDatabaseUrl: runtimeDatabaseUrl.toString(), continueFrontend: async ({ verifyLockedSession, ready }) => {
            assert.equal(scenario, "success");
            assert.equal(ready.migrationOutcome.frontendSqlReplayed, false);
            await verifyLockedSession();
            await host.verifyReplacementFrontend(peer.proof);
            await verifyLockedSession();
            return peer.releaseOutcome;
          } }), { readHostEvidence: peer.readHostEvidence, recovery: selection.recovery });
      if (scenario === "backend-loss") {
        await assert.rejects(action, { message: "P2_FRONTEND_REPLACEMENT_WRITE_TRANSPORT_REFUSED" });
        assert.deepEqual(peer.trace, ["initial", "resume-replacement-written", "start-replacement-runtime"]);
      } else {
        await action;
        assert.deepEqual(peer.trace, ["initial", "resume-replacement-written", "start-replacement-runtime", "verify-replacement-frontend",
          "prepare-replacement-close", "observe-replacement-closed", "finish-replacement", "commit"]);
        assert.equal(peer.checks(), 4);
      }
      assert.deepEqual(readFileSync(join(results, "database-receipt.json")), databaseReceipt);
      assert.deepEqual(readFileSync(join(results, "frontend-continuation-started.json")), continuationStarted);
      assert.deepEqual((await contender.query(journalSql)).rows, after);
      assert.deepEqual((await contender.query("SELECT epoch::text,new_work,recovery FROM frontend_admission.control")).rows,
        [{ epoch: "1", new_work: false, recovery: false }]);
      assert.equal((await contender.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [FRONTEND_MIGRATION_LOCK])).rows[0].acquired, true);
      await contender.query("SELECT pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    }
    console.log(JSON.stringify({ status: "OWNED_FRONTEND_REPLACEMENT_RECOVERY_PASSED", serverMajor, frontendMigrations: after.length,
      runtimeAndProviderSubstituted: true, liveProviderTouched: false, productionTouched: false,
      checked: ["retained-83-migrations", "retained-original-receipt-bytes", "fresh-tls-lock", "recovery-wire-through-terminal",
        "backend-loss-before-promotion", "closed-admission-preserved"] }));
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    if (cluster) await cluster.stop();
    setDefaultCACertificates(originalCa);
    rmSync(directory, { recursive: true, force: true });
  }
}

await rehearse().catch(error => {
  // Do not relay raw errors that might include an owned URL or password.
  console.error(JSON.stringify({ status: "OWNED_FRONTEND_REPLACEMENT_RECOVERY_FAILED", line: fixtureLine(error),
    errorCode: error.code === "ERR_ASSERTION" ? "ERR_ASSERTION" : null, trace: failedTrace, peerLine: failedPeerLine }));
  process.exitCode = 1;
});

// The harness owns every loopback cluster and its short-lived credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";
import { FRONTEND_MIGRATION_LOCK, frontendMigrationArtifact, prepareFrontendMigration, runFrontendMigration, runOwnedFrontendReplacementBootstrap } from "./frontend-migration.mjs";
import { FRONTEND_PREPARATION_ROLES as roles } from "./frontend-role-preparation.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import { observeP2FrontendReplacement } from "./p2-frontend-replacement-probe.mjs";
import { observeP2FrontendReplacementWritten } from "./p2-frontend-replacement-written.mjs";
import { observeP2FrontendReplacementClosed } from "./p2-frontend-replacement-closed.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const source = fileURLToPath(new URL("../..", import.meta.url));
const self = fileURLToPath(import.meta.url);
const gate = "FRONTEND_REPLACEMENT_BOOTSTRAP_LOCAL_TEST";
const host = "127.0.0.1", migrationUser = "owned_frontend_migration", oldUser = "owned_frontend_previous_migration";
const predecessorDatabase = "owned_frontend_predecessor", oldRuntime = "owned_frontend_previous_runtime";
const producerSha256 = "a".repeat(64), inventorySha256 = "b".repeat(64);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rawDigest = value => createHash("sha256").update(value).digest("hex");
const run = (program, args, options) => execFileSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const privateDir = directory => { mkdirSync(directory, { mode: 0o700 }); return directory; };
const readJson = (directory, name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
let phase = "setup";

async function withDatabase(cluster, database, task) {
  const client = await cluster.connect(database);
  try { return await task(client); }
  finally { await client.end(); }
}

async function createDatabase(cluster, database) {
  await withDatabase(cluster, "postgres", async client => {
    await client.query(`create database ${database}`);
    await client.query(`revoke all on database ${database} from public`);
  });
  await withDatabase(cluster, database, client => client.query("revoke create on schema public from public"));
}

async function referenceBaseline(cluster, artifact, serverMajor) {
  const database = "owned_frontend_baseline";
  await createDatabase(cluster, database);
  return withDatabase(cluster, database, async client => {
    for (const migration of artifact.migrations) {
      await client.query("begin");
      try {
        for (const statement of migration.sql) await client.query(statement);
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
    }
    return { version: 1, serverMajor, sqlArtifactSha256: artifact.sqlArtifactSha256, catalog: await readMigrationCatalog(client) };
  });
}

function plan(sourceCommit, artifact, baseline, target, predecessorTarget, releaseId) {
  const migrationImageDigest = "sha256:" + "c".repeat(64), schemaBaselineSha256 = digest(baseline);
  const contract = { contractPhase: artifact.contractPhase, contractManifestSha256: artifact.contractManifestSha256,
    phase2ContractManifestSha256: artifact.phase2ContractManifestSha256 };
  const frontendMigration = { sourceCommit, sqlArtifactSha256: artifact.sqlArtifactSha256,
    schemaBaselines: { [target.serverMajor]: schemaBaselineSha256 }, ...contract, qualificationTargetProfile: profile };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${migrationImageDigest}` } },
    ...contract, frontendMigration };
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging", releaseId, sourceCommit,
    ...contract, migrationImageDigest, sqlArtifactSha256: artifact.sqlArtifactSha256, schemaBaselineSha256,
    recoveryRef: "owned/frontend-replacement", target: { ...target, qualificationTargetProfile: profile,
      allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  return { version: 1, qualificationTargetProfile: profile, candidate, job, baseline, predecessorTarget,
    administrativeLogins: [], producerSha256, inventorySha256 };
}

async function invoke(directory, name, input, cluster, predecessorCluster, success, { ordinary = false, confirmation, continueRelease, withOwnedHost } = {}) {
  phase = name;
  const results = privateDir(join(directory, name));
  const outputs = { directory: privateDir(join(results, "release")), rolesDirectory: privateDir(join(results, "roles")),
    privateDirectory: privateDir(join(results, "credentials")) };
  const { host: selectedHost, port, user, database } = input.job.target;
  const password = randomUUID(), url = `postgresql://${user}:${password}@${selectedHost}:${port}/${database}?sslmode=verify-full`;
  let credentialRead = false, error;
  const getUrl = async () => { credentialRead = true; return url; };
  try {
    if (ordinary) {
      const prepared = prepareFrontendMigration(input.candidate, input.job, input.baseline, undefined, profile);
      await runFrontendMigration(prepared, { confirmation: `staging/${input.job.releaseId}`, getUrl }, profile);
    } else await runOwnedFrontendReplacementBootstrap(input, {
      ...outputs, cluster, predecessorCluster, getUrl,
      confirmation: confirmation ?? `owned-frontend-bootstrap/${input.job.releaseId}`,
      ...(continueRelease ? { continueRelease: value => continueRelease(value, outputs) } : {}),
      ...(withOwnedHost ? { withOwnedHost: (lease, task) => withOwnedHost({ ...lease, getUrl }, task) } : {}),
    });
  } catch (failure) { error = failure; }
  assert.equal(String(error?.message ?? "").includes(password), false);
  const outcomeFile = join(outputs.directory, "job-outcome.json");
  const outcome = existsSync(outcomeFile) ? readJson(outputs.directory, "job-outcome.json") : undefined;
  const replacementOutcomeFile = join(outputs.directory, "replacement-bootstrap-outcome.json");
  const replacementOutcome = existsSync(replacementOutcomeFile) ? readJson(outputs.directory, "replacement-bootstrap-outcome.json") : undefined;
  assert.equal(!error, success, `${name}: ${outcome?.phase ?? replacementOutcome?.phase ?? "no outcome"}`);
  for (const evidenceDirectory of [outputs.directory, outputs.rolesDirectory])
    for (const file of readdirSync(evidenceDirectory))
      assert.equal(readFileSync(join(evidenceDirectory, file), "utf8").includes(password), false);
  return { ...outputs, outcome, replacementOutcome, credentialRead };
}

function hostedFixture(cluster, input, operations, { wrongCustody = false, afterCustody } = {}) {
  return async ({ verifyEnvironment, signal, getUrl }, task) => {
    let probe, physical, armReceiptSha256, writtenPacket, writtenBytes;
    const arm = {
      async armReplacement(locked) {
        operations.push("arm");
        probe = locked;
        physical = Buffer.from(JSON.stringify(await observeP2FrontendReplacement(probe, { getUrl })) + "\n");
        armReceiptSha256 = rawDigest(physical);
        return { physicalObservation: physical.toString("base64"), physicalObservationSha256: rawDigest(physical), armReceiptSha256 };
      },
      async authorizeReplacementWrite(boundary) {
        operations.push("custody");
        await assertPristine(cluster, input.job.target.database);
        assert.equal(boundary.status, "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED");
        await afterCustody?.();
        const receipt = { status: "P2_FRONTEND_REPLACEMENT_WRITE_CUSTODY_ACKNOWLEDGED", armReceiptSha256,
          physicalObservationSha256: wrongCustody ? "f".repeat(64) : rawDigest(physical),
          bootstrapAuthorized: false, migrationAuthorized: false, deploymentAuthorized: false, trafficAuthorized: false };
        return { receipt, writeIntentSha256: digest(receipt) };
      },
      async verifyReplacementWritten({ databaseReceipt, continuationStarted, owner, runtime, producerSha256 }) {
        operations.push("written");
        writtenPacket = { probe, physicalObservation: physical.toString("base64"),
          databaseReceipt: databaseReceipt.toString("base64"), continuationStarted: continuationStarted.toString("base64"),
          owner, runtime, producerSha256, administrativeLogins: input.administrativeLogins };
        const receipt = await observeP2FrontendReplacementWritten(writtenPacket, { getUrl });
        writtenBytes = Buffer.from(JSON.stringify(receipt) + "\n");
        return { receipt, bytes: writtenBytes, postflightSha256: rawDigest(writtenBytes) };
      },
      async startReplacementRuntime() {
        operations.push("runtime");
        return { status: "OWNED_REPLACEMENT_API_RUNTIME_READY" };
      },
      async prepareReplacementClose() {
        operations.push("prepare-close");
        await observeP2FrontendReplacement(probe, { getUrl });
      },
      async observeReplacementClosed() {
        operations.push("closed");
        const receipt = await observeP2FrontendReplacementClosed({
          ...writtenPacket, writtenObservation: writtenBytes.toString("base64"),
        }, { getUrl });
        assert.equal(receipt.originalLocksAbsent, true);
        assert.equal(receipt.writtenObservationSha256, rawDigest(writtenBytes));
      },
      async finishReplacement({ terminal, continuationCompleted, releaseOutcome }) {
        operations.push("finish");
        assert.equal(JSON.parse(terminal).migrationMode, "apply-forward");
        assert.equal(JSON.parse(terminal).phase, "completed");
        assert.equal(JSON.parse(continuationCompleted).status, "FRONTEND_CONTINUATION_COMPLETED");
        assert.equal(JSON.parse(releaseOutcome).status, "OWNED_REPLACEMENT_FRONTEND_VERIFIED");
        await verifyEnvironment();
      },
    };
    return task(verifyEnvironment, signal, arm);
  };
}

const journalSql = "select hash,created_at from drizzle.__drizzle_migrations order by created_at,id";
const journalExists = async client => (await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present")).rows[0].present;

async function assertPristine(cluster, database) {
  await withDatabase(cluster, database, async client => {
    assert.equal(await journalExists(client), false);
    assert.equal((await client.query("select to_regnamespace('frontend_admission') is null as absent")).rows[0].absent, true);
    assert.equal((await client.query("select count(*)::int as count from pg_roles where rolname=any($1::text[])", [Object.values(roles)])).rows[0].count, 0);
  });
}

async function verifyApplied(cluster, input, artifact, outputs) {
  const { target, sourceCommit } = input.job;
  const targetSha256 = frontendAdmissionTargetSha256("staging", target);
  const applied = artifact.migrations.map(row => ({ hash: row.hash, created_at: String(row.folderMillis) }));
  await withDatabase(cluster, target.database, async client => {
    assert.deepEqual((await client.query(journalSql)).rows, applied);
    assert.deepEqual((await client.query("select environment,target_sha256,epoch::text,new_work,recovery from frontend_admission.control")).rows,
      [{ environment: "staging", target_sha256: targetSha256, epoch: "1", new_work: false, recovery: false }]);
    const registered = (await client.query(`select producer_sha256,source_sha,database_role::regrole::text as role,enabled
      from frontend_admission.producers`)).rows;
    assert.deepEqual(registered, [{ producer_sha256: producerSha256, source_sha: sourceCommit, role: roles.runtime, enabled: true }]);
    assert.equal((await client.query("select count(*)::int as count from frontend_admission.operations")).rows[0].count, 0);
  });
  const credentialFile = join(outputs.privateDirectory, "frontend-role-credentials.json");
  assert.equal(statSync(credentialFile).mode & 0o077, 0);
  const credential = readJson(outputs.privateDirectory, "frontend-role-credentials.json");
  assert.ok(typeof credential.password === "string" && credential.password.length >= 64);
  for (const evidenceDirectory of [outputs.directory, outputs.rolesDirectory])
    for (const file of readdirSync(evidenceDirectory))
      assert.equal(readFileSync(join(evidenceDirectory, file), "utf8").includes(credential.password), false);
  const runtime = await cluster.connect(target.database, roles.runtime, credential.password);
  try {
    const policy = await runtime.query("select * from frontend_admission.current_policy($1,$2,$3,$4)",
      ["staging", targetSha256, producerSha256, sourceCommit]);
    assert.deepEqual(policy.rows, [{ epoch: "1", new_work: false, recovery: false }]);
    for (const kind of ["new-work", "recovery"]) await assert.rejects(runtime.query(
      "call frontend_admission.begin_operation($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), kind, "staging", targetSha256, "1", producerSha256, sourceCommit]), { message: "FRONTEND_ADMISSION_REFUSED" });
    await assert.rejects(runtime.query(journalSql), { code: "42501" });
  } finally { await runtime.end(); }
  return applied;
}

async function fixture() {
  assert.equal(process.env[gate], "true");
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.equal(process.argv.length, 2);
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const serverMajor = Number(/PostgreSQL\) (16|18)\./u.exec(run(join(pgBin, "postgres"), ["--version"]))?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: source }).trim();
  assert.equal(run("git", ["status", "--porcelain"], { cwd: source }), "");
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "frontend-replacement-owned-"));
  const key = join(directory, "server.key"), cert = join(directory, "server.crt"), clusters = [];
  const artifact = frontendMigrationArtifact(source);
  assert.equal(artifact.migrations.length, 83);
  const originalCertificates = getCACertificates("default");
  let result;
  try {
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", `subjectAltName=DNS:localhost,IP:${host}`, "-keyout", key, "-out", cert]);
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCertificates, readFileSync(cert, "utf8")]);
    const start = async (label, user) => {
      const cluster = await openOwnedFrontendReplacementCluster(privateDir(join(directory, label)), pgBin, user, key, cert);
      clusters.push(cluster);
      return cluster;
    };
    const predecessor = await start("predecessor", oldUser);
    await createDatabase(predecessor, predecessorDatabase);
    const predecessorTarget = { host, port: predecessor.port, database: predecessorDatabase, user: oldUser, runtimeRole: oldRuntime, serverMajor };
    await withDatabase(predecessor, predecessorDatabase, async client => {
      await client.query(`create role ${oldRuntime} login;`);
      await client.query("create table public.preserved_history(value text primary key)");
      await client.query("insert into public.preserved_history values('retained')");
    });
    const replacement = await start("replacement", migrationUser);
    const target = { host, port: replacement.port, database: "owned_frontend_replacement", user: migrationUser, runtimeRole: roles.runtime, serverMajor };
    await createDatabase(replacement, target.database);
    const baseline = await referenceBaseline(replacement, artifact, serverMajor);
    const selected = plan(sourceCommit, artifact, baseline, target, predecessorTarget, "owned-frontend-replacement");
    const attempt = (name, success, options) => invoke(directory, name, selected, replacement, predecessor, success, options);
    assert.equal((await attempt("wrong-confirmation", false, { confirmation: "wrong" })).credentialRead, false);
    assert.equal((await invoke(directory, "same-target", { ...selected, predecessorTarget: target }, replacement, replacement, false)).credentialRead, false);
    for (const [label, forged] of [["forged-cluster", { ...replacement }], ["serialized-cluster", JSON.parse(JSON.stringify(replacement))]]) {
      const refused = await invoke(directory, label, selected, forged, predecessor, false);
      assert.equal(refused.credentialRead, false);
      for (const output of [refused.directory, refused.rolesDirectory, refused.privateDirectory])
        assert.deepEqual(readdirSync(output), []);
    }
    assert.equal((await invoke(directory, "wrong-cluster", selected, predecessor, replacement, false)).credentialRead, false);
    assert.equal((await attempt("ordinary-write", false, { ordinary: true })).credentialRead, false);
    await withFrontendEnvironmentLock(async () => {
      const blocked = await attempt("environment-lock-contended", false);
      assert.equal(blocked.replacementOutcome?.phase, "environment-lock");
      assert.equal(blocked.replacementOutcome?.intentRetained, false);
    });
    await withDatabase(replacement, target.database, async client => {
      await client.query("select pg_advisory_lock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
      try {
        const blocked = await attempt("database-lock-contended", false);
        assert.equal(blocked.outcome?.phase, "database-lock");
        assert.equal(blocked.replacementOutcome?.intentRetained, false);
      } finally { await client.query("select pg_advisory_unlock(hashtext($1))", [FRONTEND_MIGRATION_LOCK]); }
    });
    await assertPristine(replacement, target.database);
    await withDatabase(replacement, target.database, client => client.query("create table public.unreviewed_existing_data(value text)"));
    await attempt("nonempty", false);
    await assertPristine(replacement, target.database);
    await withDatabase(replacement, target.database, client => client.query("drop table public.unreviewed_existing_data"));
    await withDatabase(replacement, "postgres", client => client.query(`create role ${oldRuntime} nologin`));
    await attempt("shared-predecessor-role", false);
    await assertPristine(replacement, target.database);
    await withDatabase(replacement, "postgres", client => client.query(`drop role ${oldRuntime}`));
    const refusedOperations = [];
    const wrongCustody = await attempt("foreign-host-custody", false, {
      withOwnedHost: hostedFixture(replacement, selected, refusedOperations, { wrongCustody: true }),
      continueRelease() { assert.fail("foreign host custody reached continuation"); },
    });
    assert.deepEqual(refusedOperations, ["arm", "custody"]);
    assert.equal(wrongCustody.replacementOutcome.intentRetained, false);
    await assertPristine(replacement, target.database);
    const drift = await attempt("catalog-drift-after-custody", false, {
      withOwnedHost: hostedFixture(replacement, selected, [], { afterCustody: () => withDatabase(replacement, target.database,
        client => client.query("create table public.unreviewed_after_custody(value text)")) }),
      continueRelease() { assert.fail("drifted catalog reached continuation"); },
    });
    assert.equal(drift.replacementOutcome.intentRetained, false);
    await assertPristine(replacement, target.database);
    await withDatabase(replacement, target.database, client => client.query("drop table public.unreviewed_after_custody"));
    const hostOperations = [];
    const applied = await attempt("apply", true, {
      withOwnedHost: hostedFixture(replacement, selected, hostOperations),
      async continueRelease(continuation, outputs) {
      const { database, owner, runtime, roleProofSha256, admission, verifyLockedSession } = continuation;
      assert.deepEqual(hostOperations, ["arm", "custody", "written", "runtime"]);
      assert.equal(continuation.ready.status, "OWNED_REPLACEMENT_API_RUNTIME_READY");
      assert.ok(existsSync(join(outputs.directory, "replacement-write-custody.json")));
      assert.equal(database.applied.length, artifact.migrations.length);
      assert.deepEqual(admission, { migrationCount: artifact.migrations.length, admissionEpoch: "1", newWork: false, recovery: false, operations: 0 });
      const written = readJson(outputs.directory, "replacement-written-observation.json");
      assert.equal(written.status, "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED");
      assert.equal(written.appliedMigrationCount, artifact.migrations.length);
      for (const [field, name] of [["physicalObservationSha256", "replacement-physical-observation.json"],
        ["databaseReceiptSha256", "database-receipt.json"], ["continuationStartedSha256", "frontend-continuation-started.json"]]) {
        assert.equal(written[field], createHash("sha256").update(readFileSync(join(outputs.directory, name))).digest("hex"));
      }
      const rolesReceipt = readJson(outputs.rolesDirectory, "roles-preparation-outcome.json");
      assert.deepEqual({ owner, runtime }, { owner: rolesReceipt.owner, runtime: rolesReceipt.runtime });
      assert.equal(roleProofSha256, rolesReceipt.proofSha256);
      const credential = readJson(outputs.privateDirectory, "frontend-role-credentials.json");
      assert.equal(continuation.private.runtimeDatabaseUrl, credential.runtimeDatabaseUrl);
      assert.equal(JSON.stringify(continuation).includes(credential.password), false);
      const physical = readJson(outputs.directory, "replacement-physical-observation.json");
      const raw = readFileSync(join(outputs.directory, "replacement-physical-observation.json"));
      assert.equal(readJson(outputs.directory, "replacement-bootstrap-started.json").physicalObservationSha256,
        createHash("sha256").update(raw).digest("hex"));
      await verifyLockedSession();
      await assert.rejects(withFrontendEnvironmentLock(async () => assert.fail("environment lock released")));
      await withDatabase(replacement, target.database, async client => {
        const { rows: [held] } = await client.query(`select count(*)::int as locks from pg_catalog.pg_locks
          where locktype='advisory' and pid=$1 and mode='ExclusiveLock' and granted`, [physical.backendPid]);
        assert.equal(held.locks, 2);
        const { rows: [competing] } = await client.query("select pg_try_advisory_lock(hashtext($1)) as acquired", [FRONTEND_MIGRATION_LOCK]);
        assert.equal(competing.acquired, false);
      });
      await verifyApplied(replacement, selected, artifact, outputs);
      await verifyLockedSession();
      return { status: "OWNED_REPLACEMENT_FRONTEND_VERIFIED" };
    } });
    assert.deepEqual(hostOperations, ["arm", "custody", "written", "runtime", "prepare-close", "closed", "finish"]);
    assert.equal(applied.replacementOutcome?.status, "OWNED_FRONTEND_REPLACEMENT_DATABASE_VERIFIED");
    assert.equal(applied.replacementOutcome?.deploymentAuthorized, false);
    assert.equal(applied.replacementOutcome?.automaticReplayAllowed, false);
    assert.equal(applied.replacementOutcome?.migrationCount, artifact.migrations.length);
    const closedReceipt = readJson(applied.directory, "replacement-closed-after-sql.json");
    assert.equal(closedReceipt.status, "OWNED_FRONTEND_REPLACEMENT_CLOSED_AFTER_SQL");
    assert.equal(closedReceipt.newWork, false);
    assert.equal(closedReceipt.recovery, false);
    assert.equal(readJson(applied.directory, "replacement-bootstrap-started.json").status, "OWNED_FRONTEND_REPLACEMENT_BOOTSTRAP_STARTED");
    assert.equal(readJson(applied.directory, "replacement-closed-after-continuation.json").status, "OWNED_FRONTEND_REPLACEMENT_CLOSED_AFTER_CONTINUATION");
    assert.equal(readJson(applied.directory, "frontend-continuation-completed.json").databaseVerified, true);
    const appliedRows = await verifyApplied(replacement, selected, artifact, applied);
    const databaseReceipt = readJson(applied.directory, "database-receipt.json");
    assert.equal(databaseReceipt.status, "DATABASE_VERIFIED");
    assert.deepEqual(databaseReceipt.before, []);
    assert.deepEqual(databaseReceipt.after, appliedRows);
    assert.deepEqual(databaseReceipt.applied, artifact.migrations.map(({ tag, hash }) => ({ tag, hash })));
    assert.equal(databaseReceipt.trafficAuthorized, false);
    assert.deepEqual(await withDatabase(replacement, target.database, readMigrationCatalog), baseline.catalog);
    const successReceipt = readFileSync(join(applied.directory, "database-receipt.json"));
    await attempt("fresh-directory-replay", false);
    assert.deepEqual(readFileSync(join(applied.directory, "database-receipt.json")), successReceipt);
    assert.deepEqual(await withDatabase(replacement, target.database, async client => (await client.query(journalSql)).rows), appliedRows);

    const late = await start("late", migrationUser);
    const lateTarget = { ...target, port: late.port, database: "owned_frontend_late_failure" };
    await createDatabase(late, lateTarget.database);
    const mismatchedBaseline = structuredClone(baseline);
    mismatchedBaseline.catalog.relations.push({ relname: "owned_frontend_intentionally_missing" });
    const latePlan = plan(sourceCommit, artifact, mismatchedBaseline, lateTarget, predecessorTarget, "owned-frontend-late-failure");
    const failure = await invoke(directory, "late-schema-mismatch", latePlan, late, predecessor, false);
    assert.equal(failure.outcome?.status, "FAILED_REQUIRES_REVIEW");
    assert.equal(failure.outcome?.phase, "postflight");
    assert.equal(failure.replacementOutcome?.intentRetained, true);
    assert.equal(failure.replacementOutcome?.automaticReplayAllowed, false);
    assert.equal(existsSync(join(failure.directory, "database-receipt.json")), false);
    await verifyApplied(late, latePlan, artifact, failure);
    const failureReceipt = readFileSync(join(failure.directory, "job-outcome.json"));
    await invoke(directory, "late-schema-mismatch-replay", latePlan, late, predecessor, false);
    assert.deepEqual(readFileSync(join(failure.directory, "job-outcome.json")), failureReceipt);
    assert.deepEqual(await withDatabase(late, lateTarget.database, async client => (await client.query(journalSql)).rows), appliedRows);
    const interrupted = await start("interrupted", migrationUser);
    const interruptedTarget = { ...target, port: interrupted.port, database: "owned_frontend_interrupted" };
    await createDatabase(interrupted, interruptedTarget.database);
    const interruptedPlan = plan(sourceCommit, artifact, baseline, interruptedTarget, predecessorTarget, "owned-frontend-interrupted");
    const incomplete = await invoke(directory, "interrupted-continuation", interruptedPlan, interrupted, predecessor, false,
      { async continueRelease({ verifyLockedSession }) { await verifyLockedSession(); throw new Error("OWNED_CONTINUATION_INTERRUPTED"); } });
    assert.equal(incomplete.outcome.status, "FAILED_REQUIRES_REVIEW");
    assert.equal(incomplete.outcome.phase, "compatible-frontend-continuation");
    assert.equal(incomplete.replacementOutcome.automaticReplayAllowed, false);
    assert.equal(existsSync(join(incomplete.directory, "frontend-continuation-completed.json")), false);
    const interruptedReceipt = readFileSync(join(incomplete.directory, "database-receipt.json"));
    await invoke(directory, "interrupted-continuation-replay", interruptedPlan, interrupted, predecessor, false);
    assert.deepEqual(readFileSync(join(incomplete.directory, "database-receipt.json")), interruptedReceipt);
    assert.deepEqual(await verifyApplied(interrupted, interruptedPlan, artifact, incomplete), appliedRows);
    await withDatabase(predecessor, predecessorDatabase, async client => {
      assert.deepEqual((await client.query("select value from public.preserved_history")).rows, [{ value: "retained" }]);
      assert.equal(await journalExists(client), false);
      assert.equal((await client.query("select to_regnamespace('frontend_admission') is null as absent")).rows[0].absent, true);
    });
    await late.stop();
    assert.equal((await invoke(directory, "stopped-cluster", latePlan, late, predecessor, false)).credentialRead, false);
    result = { status: "OWNED_FRONTEND_REPLACEMENT_BOOTSTRAP_PASSED", sourceCommit, serverMajor,
      sqlArtifactSha256: artifact.sqlArtifactSha256, appliedMigrationCount: appliedRows.length, trafficAuthorized: false,
      checks: ["explicit-confirmation", "distinct-predecessor", "forged-and-serialized-clusters-refused-before-effects", "mismatched-cluster-refused",
        "stopped-cluster-refused", "ordinary-profiled-write-refused", "environment-lock-contention",
        "database-lock-contention", "nonempty-target-refused", "predecessor-role-refused", "full-migration-lineage",
        "exact-schema", "closed-runtime-admission", "predecessor-preserved",
        "fresh-directory-replay-refused", "late-schema-drift-retains-commits-and-refuses-replay",
        "independent-physical-proof-before-write", "independent-written-readback-of-original-receipts", "both-locks-held-through-compatible-continuation",
        "foreign-host-custody-refused-before-roles", "catalog-drift-after-host-custody-refused-before-roles",
        "host-readback-and-api-readiness-on-original-locked-session", "independent-closure-before-original-receipt-join",
        "closed-admission-rechecked-after-continuation", "failed-continuation-preserves-commits-and-refuses-replay"] };
  } finally {
    let allStopped = true;
    for (const cluster of clusters.reverse()) {
      try { await cluster.stop(); } catch { allStopped = false; }
    }
    setDefaultCACertificates(originalCertificates);
    if (allStopped) rmSync(directory, { recursive: true, force: true });
    else throw new Error("OWNED_FRONTEND_REPLACEMENT_CLUSTER_CLEANUP_UNVERIFIED");
  }
  console.log(JSON.stringify(result));
}

try {
  await fixture();
} catch (error) {
  // Only the trusted fixture's own assertion names and fixed codes are needed.
  console.error(JSON.stringify({ status: "OWNED_FRONTEND_REPLACEMENT_BOOTSTRAP_REFUSED", phase,
    ...(error?.code === "ERR_ASSERTION" ? { assertion: error.stack?.split("\n").find(line => line.includes(self))?.trim() } : {}) }));
  process.exitCode = 1;
}

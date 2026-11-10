import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact, frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { reconcileFrontendOperation } from "./frontend-admission.mjs";
import { frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES as roles, prepareFrontendRolesPlan } from "./frontend-role-preparation.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import {
  containP2ProfiledCertificationAdmission, containP2ProfiledReplacementCertificationAdmission,
  observeP2CertificationPhysical, observeP2ProfiledInterruptedFrontendPhysical, observeP2ProfiledReplacementFrontendPhysical,
  observeP2ProfiledInterruptedReplacementFrontendPhysical, readP2CertificationCurrent,
  withP2CertificationFrontendSession, withP2ProfiledInterruptedFrontendSession,
} from "./p2-certification-current-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const artifact = frontendMigrationArtifact();
const digest = digit => digit.repeat(64);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceCommit = "a".repeat(40), producerSha256 = digest("b");
const migrationUser = "owned_frontend_certifier";
const releaseId = "owned-frontend-replacement";
const journalSql = "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC";
const expectedJournal = artifact.migrations.map(({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) }));
const closed = { epoch: "1", newWork: false, recovery: false, active: 0, uncertain: 0 };

function selection({
  port = 5432, serverMajor = 16, catalog = {}, databaseOid = "42", migrationRoleOid = "43",
  owner = { name: roles.owner, oid: "44" }, runtime = { name: roles.runtime, oid: "45" }, administrativeLogins = [],
} = {}) {
  const { sqlArtifactSha256, contractManifestSha256, contractPhase, phase2ContractManifestSha256 } = artifact;
  const contracts = { contractManifestSha256, contractPhase, phase2ContractManifestSha256 };
  const target = { host: "127.0.0.1", port, database: "owned_replacement", user: migrationUser, serverMajor };
  const targetSha256 = frontendAdmissionTargetSha256("staging", target);
  const baseline = { version: 1, serverMajor, sqlArtifactSha256, catalog };
  const schemaBaselineSha256 = hash(baseline);
  const migrationImageDigest = "sha256:" + digest("a");
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging",
    releaseId, sourceCommit, ...contracts, migrationImageDigest, sqlArtifactSha256, schemaBaselineSha256,
    recoveryRef: "owned/previous", target: { ...target, qualificationTargetProfile: profile, runtimeRole: roles.runtime,
      allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId, ...contracts,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } },
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256, ...contracts,
      schemaBaselines: { [serverMajor]: schemaBaselineSha256 } } };
  const replacementRelease = { version: 1, kind: "frontend-replacement", qualificationTargetProfile: profile,
    reviewedPlanSha256: digest("c"), runtimeReviewSha256: digest("d"), postflightSha256: digest("e"),
    frontendSessionClosedSha256: digest("f"), frontendDatabaseReceiptSha256: digest("1"),
    databaseOid, migrationRoleOid, predecessorRuntimeRole: "owned_predecessor_runtime", administrativeLogins };
  const producer = { producerSha256, role: runtime };
  const plan = { version: 2, qualificationTargetProfile: profile, environment: "staging", sourceCommit, originalReleaseId: releaseId,
    certificationActionId: "owned-replacement-certification", mode: "lifecycle-persistence", startState: "already-closed",
    initialEpoch: "1", targetSha256, ...contracts, replacementRelease, candidateSha256: digest("2"), planSha256: digest("3"),
    originalReleasePlanSha256: replacementRelease.reviewedPlanSha256, originalReleaseReceiptSha256: digest("4"),
    nativePlan: { version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: releaseId, sourceCommit,
      targetSha256, target: { ...target, qualificationTargetProfile: profile }, phase2ContractManifestSha256, owner, producer,
      purpose: "scoped-certification-control-only", initialEpoch: "1", commandWitnesses: [] } };
  return { plan, prepared: { migration: { candidate, job, artifact, baseline },
    plan: { targetSha256, owner, producers: [producer], replacementRelease } } };
}

async function rejectUnboundReplacementSelection() {
  let reads = 0;
  const getUrl = () => { reads++; throw new Error("owned credential read"); };
  const run = ({ prepared, plan }) => withP2CertificationFrontendSession(prepared, plan, { getUrl }, () => {}, profile);
  await assert.rejects(run(selection()), /owned credential read/u);
  assert.equal(reads, 1);
  for (const [label, edit] of [
    ["legacy historical logins", ({ prepared }) => { prepared.plan.historicalLogins = {}; }],
    ["missing inventory marker", ({ prepared }) => { delete prepared.plan.replacementRelease; }],
    ["missing plan marker", ({ plan }) => { delete plan.replacementRelease; }],
    ["wrong retained digest", ({ plan }) => { plan.originalReleasePlanSha256 = digest("5"); }],
    ["missing raw database receipt digest", ({ plan }) => { delete plan.replacementRelease.frontendDatabaseReceiptSha256; }],
    ["duplicate migration login identity", ({ plan }) => {
      plan.replacementRelease.administrativeLogins.push({ name: migrationUser, oid: "46" });
    }],
    ["reordered approved admins", ({ plan }) => {
      plan.replacementRelease.administrativeLogins.push({ name: "owned_second", oid: "46" }, { name: "owned_first", oid: "47" });
    }],
    ["current journal job", ({ prepared }) => { prepared.migration.job.target.allowEmptyBootstrap = false; }],
    ["missing source tag", ({ prepared }) => { prepared.migration.job.target.approvedPendingTags.pop(); }],
    ["reordered source tags", ({ prepared }) => { prepared.migration.job.target.approvedPendingTags.reverse(); }],
    ["unreviewed artifact", ({ prepared }) => { prepared.migration.job.sqlArtifactSha256 = digest("6"); }],
    ["known ACK without its reviewed witness", ({ plan }) => { plan.mode = "known-ack-recovery"; }],
    ["interrupted known ACK at the ordinary entry point", ({ plan }) => { plan.mode = "p2-profiled-known-ack-interrupted-restoration"; }],
  ]) {
    const invalid = selection();
    edit(invalid);
    await assert.rejects(run(invalid), { message: "P2_CERTIFICATION_CURRENT_REFUSED" }, label);
  }
  assert.equal(reads, 1);
}

async function applySourceJournal(client) {
  await client.query("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)");
  for (const { sql, hash, folderMillis } of artifact.migrations) {
    await client.query("BEGIN");
    try {
      for (const statement of sql) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [hash, folderMillis]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
}

async function verifyKnownAckRecovery({ admin, selected, dependencies, command, hold, observer }) {
  const { plan, prepared } = selected;
  const policy = { environment: "staging", targetSha256: plan.targetSha256 };
  const operate = async (initialEpoch, interrupted) => {
    const nativeEpoch = String(initialEpoch + 1), windowEpoch = String(initialEpoch + 2), finalEpoch = String(initialEpoch + 3);
    const commandId = randomUUID(), userId = randomUUID(), issuedAt = new Date().toISOString();
    const uncertainId = randomUUID(), replayId = randomUUID();
    const commandValue = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt };
    await admin.query("INSERT INTO public.customer_users(id,email,status,account_version) VALUES($1,$2,'suspended',1)",
      [userId, `owned-${initialEpoch}@example.invalid`]);
    await admin.query(`INSERT INTO public.customer_account_commands(command_id,user_id,account_version,idempotency_key,action,issued_at,command)
      VALUES($1,$2,1,$3,'suspend',$4,$5)`, [commandId, userId, randomUUID(), issuedAt, commandValue]);
    await admin.query(`INSERT INTO public.customer_account_deliveries(command_id,receiver,status,attempts)
      VALUES($1,'course','pending',0),($1,'community','pending',0)`, [commandId]);
    const nativePlan = { ...plan.nativePlan, initialEpoch: nativeEpoch, planSha256: digest("7"),
      commandWitnesses: [{ commandId, accountVersion: "1", action: "suspend" }] };
    const known = { ...plan, mode: "known-ack-recovery", certificationActionId: `owned-known-ack-${initialEpoch}`,
      planSha256: digest("8"), initialEpoch: String(initialEpoch), nativePlan };
    const settlement = hash({ operationId: uncertainId, epoch: finalEpoch, sourceCommit });
    const settle = async client => {
      await client.query(`SET ROLE "${nativePlan.owner.name}"`);
      try {
        await assert.rejects(reconcileFrontendOperation(client, policy, windowEpoch, uncertainId, settlement));
        await reconcileFrontendOperation(client, policy, finalEpoch, uncertainId, settlement);
      } finally { await client.query("RESET ROLE"); }
    };
    let retained;
    const probe = await hold(async ({ client, verify, probe, receipt }) => {
      assert.deepEqual(receipt.admission, { ...closed, epoch: known.initialEpoch });
      assert.equal(receipt.witness.operations.length, 0);
      await admin.query("UPDATE frontend_admission.control SET recovery=true,epoch=$1", [nativeEpoch]);
      await readP2CertificationCurrent(client, prepared, known, verify, false, profile);
      await admin.query("UPDATE frontend_admission.control SET epoch=$1", [windowEpoch]);
      for (const [id, state] of [[uncertainId, "uncertain"], [replayId, "completed"]]) {
        await admin.query(`INSERT INTO frontend_admission.operations(id,producer_sha256,source_sha,database_role,epoch,kind,state,completed_at)
          VALUES($1,$2,$3,$4,$5,'recovery',$6,CASE WHEN $6='completed' THEN pg_catalog.clock_timestamp() ELSE NULL END)`,
        [id, producerSha256, sourceCommit, nativePlan.producer.role.oid, windowEpoch, state]);
      }
      await admin.query(`UPDATE public.customer_account_deliveries SET status='acknowledged',acknowledged_at=$1,attempts=1
        WHERE command_id=$2`, [issuedAt, commandId]);
      const physical = await observer(probe, "witness");
      assert.deepEqual(physical.admission, { ...closed, epoch: windowEpoch, recovery: true, uncertain: 1 });
      assert.deepEqual(physical.witness.operations.map(row => [row.id, row.state]), [[uncertainId, "uncertain"], [replayId, "completed"]]);
      assert.deepEqual(physical.replacementRelease, plan.replacementRelease);
      await admin.query("UPDATE frontend_admission.operations SET source_sha=$1 WHERE id=$2", ["f".repeat(40), replayId]);
      try { await assert.rejects(observer(probe, "witness"), { checkpoint: "current-replacement-known-ack-operations" }); }
      finally { await admin.query("UPDATE frontend_admission.operations SET source_sha=$1 WHERE id=$2", [sourceCommit, replayId]); }
      if (interrupted) return probe;
      await admin.query("UPDATE frontend_admission.control SET recovery=false,epoch=$1", [finalEpoch]);
      await settle(client);
      retained = await observer(probe, "witness");
      assert.deepEqual(retained.admission, { ...closed, epoch: finalEpoch });
      assert.deepEqual(retained.witness.operations.map(row => row.reconciliation_sha256), [settlement, null]);
      return probe;
    }, { plan: known, prepared });
    if (!interrupted) {
      const terminal = await observer(probe, "verify-closed");
      assert.equal(terminal.status, "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED");
      assert.equal(terminal.witnessSha256, retained.witnessSha256);
      return;
    }

    const pending = () => admin.query(`SELECT id::text,state,completed_at,reconciliation_sha256 FROM frontend_admission.operations
      WHERE epoch=$1 ORDER BY started_at,id`, [windowEpoch]).then(({ rows }) => rows);
    const untouched = await pending();
    const guarded = await containP2ProfiledReplacementCertificationAdmission(probe, dependencies);
    assert.equal(guarded.epoch, finalEpoch);
    assert.equal(guarded.admissionChanged, true);
    assert.deepEqual(guarded.knownAckLedger, { active: 0, uncertain: 1, closedZero: false });
    assert.deepEqual(await pending(), untouched);
    const fixedFence = command("--profiled-replacement-guard-fence", probe);
    assert.equal(fixedFence.status, 0, fixedFence.stderr);
    assert.deepEqual(JSON.parse(fixedFence.stdout), { ...guarded, admissionChanged: false });
    await assert.rejects(observer(probe, "verify-closed"), { checkpoint: "current-replacement-known-ack-closure" });

    const interruptedPlan = { ...known, mode: "p2-profiled-known-ack-interrupted-restoration",
      certificationActionId: "owned-interrupted-replacement", originalCertificationActionId: known.certificationActionId,
      configurationCanonicalSha256: digest("9"), planSha256: digest("4"),
      initialEpoch: finalEpoch, operationId: uncertainId, reconciliationSha256: settlement };
    const holdInterrupted = (task, reviewed = interruptedPlan) => withP2ProfiledInterruptedFrontendSession(prepared, reviewed, dependencies, task);
    await assert.rejects(holdInterrupted(() => assert.fail("unsettled interrupted path")), { checkpoint: "current-interrupted-closed" });
    await settle(admin);
    await assert.rejects(holdInterrupted(() => assert.fail("wrong selected operation"), { ...interruptedPlan, operationId: replayId }),
      { checkpoint: "current-interrupted-settlement" });
    await assert.rejects(holdInterrupted(() => assert.fail("wrong settlement"), { ...interruptedPlan, reconciliationSha256: digest("5") }),
      { checkpoint: "current-interrupted-settlement" });

    const fixedFlag = "--profiled-replacement-known-ack-interrupted";
    const verifyInterrupted = (fresh, operation) => observeP2ProfiledInterruptedReplacementFrontendPhysical({ ...fresh, operation }, dependencies);
    let readRetained;
    const fresh = await holdInterrupted(async context => {
      assert.deepEqual(Object.keys(context).sort(), ["probe", "readCurrent", "receipt", "verify"]);
      const { probe: fresh, receipt, readCurrent, verify } = context;
      readRetained = readCurrent;
      assert.notEqual(fresh.marker, probe.marker);
      assert.notDeepEqual([fresh.backendPid, fresh.backendStart], [probe.backendPid, probe.backendStart]);
      assert.deepEqual(receipt.admission, { ...closed, epoch: finalEpoch });
      assert.deepEqual(receipt.replacementRelease, plan.replacementRelease);
      assert.deepEqual(receipt.witness.operations.map(row => row.reconciliation_sha256), [settlement, null]);
      const observed = await verifyInterrupted(fresh, "witness");
      assert.equal(observed.witnessSha256, receipt.witnessSha256);
      assert.deepEqual(observed.replacementRelease, plan.replacementRelease);
      const fixed = command(fixedFlag, { ...fresh, operation: "witness" });
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.deepEqual(JSON.parse(fixed.stdout), JSON.parse(JSON.stringify(observed)));
      for (const wrong of ["--profiled-current", "--profiled-known-ack-interrupted", "--profiled-replacement"]) {
        const refused = command(wrong, { ...fresh, operation: "witness" });
        assert.equal(refused.status, 1, wrong);
        assert.equal(refused.stdout, "", wrong);
      }
      const deniedFence = command("--profiled-replacement-guard-fence", fresh);
      assert.equal(deniedFence.status, 1);
      await assert.rejects(verifyInterrupted(fresh, "verify-closed"), { checkpoint: "current-replacement-backend-still-present" });
      await admin.query("UPDATE frontend_admission.operations SET completed_at=completed_at+interval '1 second' WHERE id=$1", [replayId]);
      try { await assert.rejects(readCurrent(), { checkpoint: "current-interrupted-witness-changed" }); }
      finally { await admin.query("UPDATE frontend_admission.operations SET completed_at=completed_at-interval '1 second' WHERE id=$1", [replayId]); }
      await verify();
      assert.equal((await readCurrent()).witnessSha256, receipt.witnessSha256);
      return fresh;
    });
    await assert.rejects(readRetained(), { checkpoint: "current-interrupted-session-closed" });
    const closure = await verifyInterrupted(fresh, "verify-closed");
    assert.equal(closure.status, "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED");
    assert.equal(closure.backendAbsent && closure.migrationLockReleased && closure.nonceLockReleased, true);
    assert.equal(closure.witnessSha256, fresh.receipt.witnessSha256);
    assert.equal(closure.journalSha256, probe.receipt.journalSha256);
    const fixedClosure = command(fixedFlag, { ...fresh, operation: "verify-closed" });
    assert.equal(fixedClosure.status, 0, fixedClosure.stderr);
    assert.deepEqual(JSON.parse(fixedClosure.stdout), closure);
  };
  await operate(3, false);
  await operate(6, true);
}

async function verifyOwnedReplacementCertification() {
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const version = execFileSync(join(pgBin, "postgres"), ["--version"], { encoding: "utf8" });
  const serverMajor = Number(version.match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  if (process.env.OWNED_POSTGRES_MAJOR !== undefined) assert.equal(String(serverMajor), process.env.OWNED_POSTGRES_MAJOR);
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "p2-cert-replacement-"));
  const key = join(directory, "server.key"), cert = join(directory, "server.crt"), clients = [];
  const originalCA = getCACertificates("default");
  const privateDir = name => {
    const path = join(directory, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  let cluster;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCA, readFileSync(cert, "utf8")]);
    cluster = await openOwnedFrontendReplacementCluster(privateDir("cluster"), pgBin, migrationUser, key, cert);
    const setup = await cluster.connect("postgres");
    clients.push(setup);
    await setup.query("CREATE DATABASE owned_replacement");
    await setup.query("REVOKE ALL ON DATABASE owned_replacement FROM PUBLIC");
    const initializer = await cluster.connect("owned_replacement"), admin = await cluster.connect("owned_replacement");
    clients.push(initializer, admin);
    await initializer.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const { rows: [identity] } = await initializer.query(`SELECT datid::text AS "databaseOid",usesysid::text AS "migrationRoleOid"
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
    const oldPid = initializer.processID;
    const base = { port: cluster.port, serverMajor, ...identity };
    const { prepared: { migration: { candidate, job } } } = selection(base);
    await initializer.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [FRONTEND_MIGRATION_LOCK]);
    const verifySession = async () => {
      const { rows: [session] } = await initializer.query("SELECT pg_catalog.pg_backend_pid() AS pid");
      assert.equal(session.pid, oldPid);
    };
    const confirmation = `staging/${releaseId}`;
    const rolePlan = prepareFrontendRolesPlan(candidate, job,
      { version: 2, qualificationTargetProfile: profile, producerSha256: [producerSha256] }, profile);
    const { owner, runtime, producers } = await applyPreparedFrontendRoles(rolePlan, initializer, {
      confirmation, directory: privateDir("roles"), privateDirectory: privateDir("credentials"),
      verifyEnvironment: async () => {}, verifySession,
    }, profile);
    await bootstrapFrontendAdmission({
      version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: releaseId, sourceCommit,
      sqlSha256: frontendAdmissionBootstrapArtifact().sqlSha256, inventorySha256: digest("c"),
      targetSha256: frontendAdmissionTargetSha256("staging", job.target), target: job.target, owner, producers,
    }, initializer, { confirmation, verifySession, record: () => {} }, profile);
    await applySourceJournal(initializer);
    await initializer.end();
    clients.splice(clients.indexOf(initializer), 1);
    await admin.query("CREATE ROLE owned_reviewed_admin LOGIN");
    await admin.query("GRANT CONNECT ON DATABASE owned_replacement TO owned_reviewed_admin");
    const { rows: administrativeLogins } = await admin.query("SELECT rolname AS name,oid::text FROM pg_catalog.pg_roles WHERE rolname='owned_reviewed_admin'");
    const selected = selection({ ...base, catalog: await readMigrationCatalog(admin), owner, runtime, administrativeLogins });
    const { plan } = selected;
    const password = randomUUID();
    const url = `postgresql://${migrationUser}:${password}@127.0.0.1:${cluster.port}/owned_replacement?sslmode=verify-full`;
    const dependencies = { getUrl: () => url, verifyEnvironment: async () => {} };
    const hold = (task, reviewed = selected) => withP2CertificationFrontendSession(reviewed.prepared, reviewed.plan, dependencies, task, profile);
    const observer = (probe, operation) => observeP2ProfiledReplacementFrontendPhysical({ ...probe, operation }, dependencies);
    const command = (flag, packet) => spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      fileURLToPath(new URL("./p2-certification-current-probe.mjs", import.meta.url)), flag], {
      input: JSON.stringify(packet), encoding: "utf8", timeout: 15_000,
      env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, FRONTEND_STAGING_MIGRATION_DATABASE_URL: url },
    });
    let probe;
    await hold(async ({ client, verify, receipt, probe: actual }) => {
      probe = actual;
      assert.notEqual(probe.backendPid, oldPid);
      assert.match(probe.backendStart, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u);
      assert.equal(Object.hasOwn(probe, "historicalLogins"), false);
      assert.equal(Object.hasOwn(receipt, "retiredLogins"), false);
      assert.deepEqual(receipt.replacementRelease, plan.replacementRelease);
      assert.deepEqual(receipt.after, expectedJournal);
      assert.deepEqual(receipt.admission, closed);
      assert.equal(receipt.effectiveLoginBoundaryVerified, true);
      assert.equal(receipt.predecessorRuntimeRoleAbsent, true);
      const physical = await observer(probe, "witness");
      assert.equal(physical.status, "P2_FRONTEND_PHYSICAL_LOCK_VERIFIED");
      assert.equal(physical.backendPid, client.processID);
      assert.equal(physical.backendStart, probe.backendStart);
      assert.deepEqual(physical.replacementRelease, plan.replacementRelease);
      assert.equal(physical.effectiveLoginBoundaryVerified, true);
      assert.equal(physical.predecessorRuntimeRoleAbsent, true);
      assert.deepEqual(physical.witness, receipt.witness);
      const packet = { ...probe, operation: "witness" };
      const fixed = command("--profiled-replacement", packet);
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.deepEqual(JSON.parse(fixed.stdout), physical);
      for (const wrong of ["--profiled-current", "--profiled-known-ack-interrupted", "--profiled-replacement-guard-fence"]) {
        const denied = command(wrong, packet);
        assert.equal(denied.status, 1, wrong);
        assert.equal(denied.stdout, "", wrong);
        assert.equal(denied.stderr.trim(), "P2_CERTIFICATION_PHYSICAL_REFUSED", wrong);
      }
      await assert.rejects(observer(probe, "verify-closed"), { checkpoint: "current-replacement-backend-still-present" });
      await assert.rejects(observer({ ...probe, marker: digest("9") }, "verify-schema"), { checkpoint: "current-replacement-lock-identity" });
      await assert.rejects(observer({ ...probe, backendStart: "2026-11-01T00:00:00.000000Z" }, "verify-schema"),
        { checkpoint: "current-replacement-backend-identity" });
      await assert.rejects(containP2ProfiledReplacementCertificationAdmission(probe, dependencies), { checkpoint: "guard-physical-lock" });
      await verify();
    });
    const completion = await observer(probe, "verify-closed");
    assert.equal(completion.status, "P2_CERTIFICATION_FRONTEND_SESSION_CLOSED");
    assert.equal(completion.backendAbsent, true);
    assert.equal(completion.migrationLockReleased, true);
    assert.equal(completion.nonceLockReleased, true);
    assert.deepEqual(completion.admission, closed);
    assert.deepEqual(completion.replacementRelease, plan.replacementRelease);
    const fixedClosure = command("--profiled-replacement", { ...probe, operation: "verify-closed" });
    assert.equal(fixedClosure.status, 0, fixedClosure.stderr);
    assert.deepEqual(JSON.parse(fixedClosure.stdout), completion);
    let deniedReads = 0;
    const deniedDependencies = { getUrl() { deniedReads++; } };
    const packet = { ...probe, operation: "verify-schema" };
    await assert.rejects(observeP2CertificationPhysical(packet, deniedDependencies, profile), { checkpoint: "current-replacement-probe" });
    await assert.rejects(observeP2ProfiledInterruptedFrontendPhysical(packet, deniedDependencies), { checkpoint: "current-replacement-probe" });
    await assert.rejects(containP2ProfiledCertificationAdmission(probe, deniedDependencies), { checkpoint: "current-replacement-probe" });
    await assert.rejects(observeP2ProfiledReplacementFrontendPhysical({ ...packet, receipt: { ...probe.receipt, retiredLogins: [] } },
      deniedDependencies), { checkpoint: "current-replacement-receipt" });
    assert.equal(deniedReads, 0);

    const refuseDrift = async (label, change, undo, checkpoint) => {
      await admin.query(change);
      try {
        await assert.rejects(hold(() => assert.fail(label)), { message: "P2_CERTIFICATION_PHYSICAL_SESSION_FAILED", checkpoint }, label);
        await assert.rejects(observer(probe, "verify-closed"), { checkpoint }, label);
      } finally { await admin.query(undo); }
    };
    await refuseDrift("predecessor role exists even without login", "CREATE ROLE owned_predecessor_runtime NOLOGIN",
      "DROP ROLE owned_predecessor_runtime", "current-replacement-logins");
    await refuseDrift("unreviewed login has effective CONNECT", "CREATE ROLE owned_unreviewed_login LOGIN; GRANT CONNECT ON DATABASE owned_replacement TO owned_unreviewed_login",
      "REVOKE CONNECT ON DATABASE owned_replacement FROM owned_unreviewed_login; DROP ROLE owned_unreviewed_login", "current-replacement-logins");
    const revokedPassword = randomUUID();
    await admin.query(`CREATE ROLE owned_revoked_login LOGIN PASSWORD '${revokedPassword}';
      GRANT CONNECT ON DATABASE owned_replacement TO owned_revoked_login`);
    const revoked = await cluster.connect("owned_replacement", "owned_revoked_login", revokedPassword);
    try {
      await admin.query("REVOKE CONNECT ON DATABASE owned_replacement FROM owned_revoked_login");
      assert.equal((await revoked.query("SELECT 1 AS alive")).rows[0].alive, 1);
      await assert.rejects(hold(() => assert.fail("previously authorized client session")), { checkpoint: "current-replacement-unapproved-session" });
      await assert.rejects(observer(probe, "verify-closed"), { checkpoint: "current-replacement-unapproved-session" });
      await assert.rejects(containP2ProfiledReplacementCertificationAdmission(probe, dependencies),
        { checkpoint: "current-replacement-unapproved-session" });
    } finally {
      await revoked.end();
      await admin.query("DROP ROLE owned_revoked_login");
    }
    await refuseDrift("reviewed login no longer has effective CONNECT", "REVOKE CONNECT ON DATABASE owned_replacement FROM owned_reviewed_admin",
      "GRANT CONNECT ON DATABASE owned_replacement TO owned_reviewed_admin", "current-replacement-logins");
    await refuseDrift("journal diverges", "UPDATE drizzle.__drizzle_migrations SET hash='wrong' WHERE id=1",
      `UPDATE drizzle.__drizzle_migrations SET hash='${expectedJournal[0].hash}' WHERE id=1`, "current-lineage-schema");
    await refuseDrift("recovery admission remains open", "UPDATE frontend_admission.control SET recovery=true",
      "UPDATE frontend_admission.control SET recovery=false", "current-admission-state");
    const wrongOid = structuredClone(selected);
    wrongOid.plan.replacementRelease.databaseOid = wrongOid.prepared.plan.replacementRelease.databaseOid = "1";
    await assert.rejects(hold(() => assert.fail("wrong database OID"), wrongOid), { checkpoint: "current-replacement-database-identity" });

    await admin.query("UPDATE frontend_admission.control SET new_work=true,epoch=2");
    const fenced = await containP2ProfiledReplacementCertificationAdmission(probe, dependencies);
    assert.equal(fenced.frontendAdmissionClosed, true);
    assert.equal(fenced.admissionChanged, true);
    assert.equal(fenced.epoch, "3");
    assert.equal(fenced.sqlReplayed, false);
    assert.equal(fenced.releaseAccepted, false);
    assert.deepEqual(fenced.replacementRelease, plan.replacementRelease);
    const fixedFence = command("--profiled-replacement-guard-fence", probe);
    assert.equal(fixedFence.status, 0, fixedFence.stderr);
    assert.deepEqual(JSON.parse(fixedFence.stdout), { ...fenced, admissionChanged: false });
    assert.deepEqual((await admin.query(journalSql)).rows, expectedJournal);
    assert.deepEqual((await admin.query("SELECT new_work,recovery FROM frontend_admission.control")).rows, [{ new_work: false, recovery: false }]);
    await verifyKnownAckRecovery({ admin, selected, dependencies, command, hold, observer });
    assert.deepEqual((await admin.query(journalSql)).rows, expectedJournal);
    assert.equal(expectedJournal.length, 83);
    return { version: 1, status: "P2_CERTIFICATION_REPLACEMENT_OWNED_PASS", serverMajor, frontendMigrations: expectedJournal.length,
      checks: ["pinned-original-replacement-full-journal-and-reviewed-role-boundary",
        "fresh-two-lock-witness-and-independent-read-only-closure",
        "fixed-replacement-observer-and-guard-dispatch",
        "predecessor-unreviewed-login-and-revoked-live-client-refusal",
        "journal-admission-marker-backend-and-database-identity-refusal",
        "independent-guard-fence-without-sql-replay",
        "replacement-known-ack-exact-uncertainty-and-selected-settlement",
        "replacement-known-ack-guard-preserves-uncertainty-and-fresh-interrupted-closure"],
      skipped: 0, actualTlsPostgres: true, noSqlReplay: true, providerTouched: false, fixtureOnly: true };
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    if (cluster) await cluster.stop();
    setDefaultCACertificates(originalCA);
    rmSync(directory, { recursive: true, force: true });
  }
}

const owned = process.env.P2_CERTIFICATION_REPLACEMENT_OWNED_TEST === "true";
if (process.argv.length === 2) {
  test("fresh replacement requires identical pinned full-tag provenance before credentials", rejectUnboundReplacementSelection);
  test("fresh certification independently observes replacement roles, closed admission and both new advisory locks",
    { skip: !owned, timeout: 120_000 }, verifyOwnedReplacementCertification);
} else {
  try {
    assert.deepEqual(process.argv.slice(2), ["--owned-json"]);
    assert.ok(owned && process.versions.node.split(".")[0] === "24");
    await rejectUnboundReplacementSelection();
    console.log(JSON.stringify(await verifyOwnedReplacementCertification()));
  } catch (error) {
    console.error(JSON.stringify({ status: "P2_CERTIFICATION_REPLACEMENT_OWNED_FAILED",
      ...(typeof error?.checkpoint === "string" && /^[a-z][a-z-]{1,79}$/u.test(error.checkpoint) ? { checkpoint: error.checkpoint } : {}),
      providerTouched: false, fixtureOnly: true }));
    process.exitCode = 1;
  }
}

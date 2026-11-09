import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Client } from "pg";
import { bootstrapFrontendAdmission, frontendAdmissionBootstrapArtifact, frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES as roles, prepareFrontendRolesPlan } from "./frontend-role-preparation.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import { createP2FrontendReplacementProbe, observeP2FrontendReplacement, verifyP2FrontendReplacementSession } from "./p2-frontend-replacement-probe.mjs";
import { observeP2FrontendReplacementWritten } from "./p2-frontend-replacement-written.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = { message: "P2_FRONTEND_REPLACEMENT_WRITTEN_OBSERVATION_REFUSED" };
const artifact = frontendMigrationArtifact();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64");
const receipt = encoded => JSON.parse(Buffer.from(encoded, "base64"));
const encodedHash = encoded => sha256(Buffer.from(encoded, "base64"));
const emptyCatalog = Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions",
  "enums", "sequences", "policies"].map(key => [key, []]));
const journalSql = "SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC";
const producerSha256 = "d".repeat(64);
const migrationUser = "owned_frontend_writer";

function selection(port = 5432, serverMajor = 16, sourceCommit = "a".repeat(40), catalog = emptyCatalog) {
  const releaseId = "owned-replacement-written", migrationImageDigest = "sha256:" + "b".repeat(64);
  const target = { host: "127.0.0.1", port, database: "owned_replacement", user: migrationUser,
    runtimeRole: roles.runtime, serverMajor };
  const predecessorTarget = { ...target, database: "owned_previous", runtimeRole: "owned_previous_runtime" };
  const { sqlArtifactSha256, contractManifestSha256, contractPhase, phase2ContractManifestSha256 } = artifact;
  const contracts = { contractManifestSha256, contractPhase, phase2ContractManifestSha256 };
  const baseline = { version: 1, serverMajor, sqlArtifactSha256, catalog };
  const schemaBaselineSha256 = sha256(JSON.stringify(baseline));
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging", releaseId,
    sourceCommit, ...contracts, migrationImageDigest, sqlArtifactSha256, schemaBaselineSha256, recoveryRef: "owned/previous",
    target: { ...target, qualificationTargetProfile: profile, allowEmptyBootstrap: true,
      approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId, ...contracts,
    integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } },
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256, ...contracts,
      schemaBaselines: { [serverMajor]: schemaBaselineSha256 } } };
  return { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock", candidate, job, baseline,
    predecessorTarget, targetSha256: frontendAdmissionTargetSha256("staging", target), databaseOid: "42", migrationRoleOid: "43" };
}

function physicalProof(probe) {
  const { job, targetSha256, databaseOid, migrationRoleOid, marker, backendPid, backendStart } = probe;
  return { version: 1, qualificationTargetProfile: profile, operation: probe.operation,
    status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", environment: job.environment,
    releaseId: job.releaseId, sourceCommit: job.sourceCommit, targetSha256, databaseOid, migrationRoleOid,
    marker, backendPid, backendStart, readOnlyVerified: true, authorityIssued: false, trafficAuthorized: false };
}

function packetFor(probe, physical, owner, runtime, after) {
  const { job } = probe;
  const { environment, releaseId, sourceCommit, contractPhase, phase2ContractManifestSha256, migrationImageDigest,
    sqlArtifactSha256, schemaBaselineSha256, contractManifestSha256, operator, recoveryRef } = job;
  const target = Object.fromEntries(["host", "port", "database", "user", "serverMajor"].map(key => [key, job.target[key]]));
  const binding = { version: 2, qualificationTargetProfile: profile, service: "frontend", environment, releaseId, sourceCommit,
    contractPhase, phase2ContractManifestSha256, migrationImageDigest, sqlArtifactSha256, schemaBaselineSha256,
    contractManifestSha256, operator, migrationMode: "apply-forward", target, recoveryRef, trafficAuthorized: false };
  const databaseReceipt = encode({ ...binding, status: "DATABASE_VERIFIED", before: [], after,
    applied: artifact.migrations.map(({ tag, hash }) => ({ tag, hash })),
    schemaVerified: true, runtimeRoleVerified: true, readOnlyVerified: false });
  const continuationStarted = encode({ ...binding, status: "FRONTEND_CONTINUATION_STARTED", databaseVerified: true });
  return { probe, physicalObservation: encode(physical), databaseReceipt, continuationStarted, owner, runtime, producerSha256,
    administrativeLogins: [] };
}

const editReceipt = (packet, field, mutate) => {
  const value = receipt(packet[field]);
  mutate(value);
  packet[field] = encode(value);
};

test("written replacement rejects malformed, substituted and partial retained evidence before reading credentials", async () => {
  const probe = { ...selection(), marker: "f".repeat(64), backendPid: 42, backendStart: "2026-11-07T00:00:00.000000Z" };
  const after = artifact.migrations.map(({ hash, folderMillis }) => ({ hash, created_at: String(folderMillis) }));
  const packet = packetFor(probe, physicalProof(probe), { name: roles.owner, oid: "44" }, { name: roles.runtime, oid: "45" }, after);
  let credentialReads = 0;
  await assert.rejects(observeP2FrontendReplacementWritten(packet, { getUrl() {
    credentialReads++;
    throw new Error("owned credential failure");
  } }), refusal);
  assert.equal(credentialReads, 1);
  for (const [name, mutate] of [
    ["unknown field", value => { value.extra = true; }],
    ["invalid base64", value => { value.databaseReceipt += "\n"; }],
    ["ambiguous JSON", value => { value.physicalObservation = Buffer.from('{"version":1,"version":1}').toString("base64"); }],
    ["different probe source", value => { value.probe.job.sourceCommit = "c".repeat(40); }],
    ["different physical marker", value => editReceipt(value, "physicalObservation", proof => { proof.marker = "e".repeat(64); })],
    ["different release receipt", value => editReceipt(value, "databaseReceipt", proof => { proof.releaseId = "other-release"; })],
    ["different applied hash", value => editReceipt(value, "databaseReceipt", proof => { proof.applied[0].hash = "e".repeat(64); })],
    ["partial journal", value => editReceipt(value, "databaseReceipt", proof => { proof.after.pop(); })],
    ["nonempty initial journal", value => editReceipt(value, "databaseReceipt", proof => { proof.before = [proof.after[0]]; })],
    ["wrong continuation status", value => editReceipt(value, "continuationStarted", proof => { proof.status = "FRONTEND_CONTINUATION_COMPLETED"; })],
    ["different continuation source", value => editReceipt(value, "continuationStarted", proof => { proof.sourceCommit = "c".repeat(40); })],
    ["role alias", value => { value.runtime = value.owner; }],
    ["zero producer hash", value => { value.producerSha256 = "0".repeat(64); }],
    ["missing login boundary", value => { delete value.administrativeLogins; }],
    ["extra login field", value => { value.administrativeLogins = [{ name: "owned_admin", oid: "46", approved: true }]; }],
    ["duplicate login identity", value => { value.administrativeLogins = [{ name: "owned_one", oid: "46" }, { name: "owned_two", oid: "46" }]; }],
    ["predecessor login allowlisted", value => { value.administrativeLogins = [{ name: value.probe.predecessorTarget.runtimeRole, oid: "46" }]; }],
  ]) {
    const altered = structuredClone(packet);
    mutate(altered);
    let requested = false;
    await assert.rejects(observeP2FrontendReplacementWritten(altered, { getUrl() { requested = true; } }), refusal, name);
    assert.equal(requested, false, name);
  }
});

async function applySql(client) {
  await client.query("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)");
  for (const migration of artifact.migrations) {
    await client.query("BEGIN");
    try {
      for (const statement of migration.sql) await client.query(statement);
      await client.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [migration.hash, migration.folderMillis]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
}

function packagedWritten(packet, url, cert, args = []) {
  return spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "/candidate/ops/platform/frontend-image.mjs",
    "--observe-replacement-written", ...args], { input: typeof packet === "string" ? packet : JSON.stringify(packet),
    encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert,
      FRONTEND_STAGING_MIGRATION_DATABASE_URL: url } });
}

test("owned TLS PostgreSQL independently reads the full written journal and refuses drift while original locks remain held", {
  skip: process.env.P2_FRONTEND_REPLACEMENT_WRITTEN_OWNED_TEST !== "true", timeout: 120_000,
}, async () => {
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const version = execFileSync(join(pgBin, "postgres"), ["--version"], { encoding: "utf8" });
  const serverMajor = Number(version.match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  const packaged = process.env.P2_FRONTEND_REPLACEMENT_PACKAGED_TEST === "true";
  const sourceCommit = packaged ? JSON.parse(readFileSync("/candidate/migration-source.json", "utf8")).commit : undefined;
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "p2-replacement-written-"));
  const key = join(directory, "server.key"), cert = join(directory, "server.crt"), clients = [];
  const originalCa = getCACertificates("default");
  const privateDir = name => {
    const result = join(directory, name);
    mkdirSync(result, { mode: 0o700 });
    return result;
  };
  let cluster;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCa, readFileSync(cert, "utf8")]);
    cluster = await openOwnedFrontendReplacementCluster(privateDir("cluster"), pgBin, migrationUser, key, cert);
    const setup = await cluster.connect("postgres");
    clients.push(setup);
    for (const database of ["owned_replacement", "owned_reference"]) {
      await setup.query(`CREATE DATABASE ${database}`);
      await setup.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    }
    const reference = await cluster.connect("owned_reference");
    clients.push(reference);
    await applySql(reference);
    const selected = selection(cluster.port, serverMajor, sourceCommit, await readMigrationCatalog(reference));
    const { job } = selected, { target } = job;
    const password = randomUUID();
    const url = `postgresql://${target.user}:${password}@${target.host}:${target.port}/${target.database}?sslmode=verify-full`;
    const dependencies = { getUrl: () => url };
    const migration = new Client(frontendConnectionOptions(url, target));
    clients.push(migration);
    await migration.connect();
    const admin = await cluster.connect(target.database);
    clients.push(admin);
    await migration.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const { rows: [identity] } = await migration.query(`SELECT datid::text AS "databaseOid",usesysid::text AS "migrationRoleOid"
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
    const lock = (client, lockKey) => client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [lockKey]);
    const unlock = (client, lockKey) => client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [lockKey]);
    await lock(migration, FRONTEND_MIGRATION_LOCK);
    const probe = await createP2FrontendReplacementProbe({ ...selected, ...identity }, migration, async () => {});
    const physical = await observeP2FrontendReplacement(probe, dependencies);
    const verifySession = () => verifyP2FrontendReplacementSession(migration, probe);
    const confirmation = `staging/${job.releaseId}`;
    const rolePlan = prepareFrontendRolesPlan(selected.candidate, job,
      { version: 2, qualificationTargetProfile: profile, producerSha256: [producerSha256] }, profile);
    const { owner, runtime, producers } = await applyPreparedFrontendRoles(rolePlan, migration, {
      confirmation, directory: privateDir("roles"), privateDirectory: privateDir("credentials"),
      verifyEnvironment: async () => {}, verifySession,
    }, profile);
    await bootstrapFrontendAdmission({
      version: 2, qualificationTargetProfile: profile, environment: "staging", actionId: job.releaseId, sourceCommit: job.sourceCommit,
      sqlSha256: frontendAdmissionBootstrapArtifact().sqlSha256, inventorySha256: "c".repeat(64),
      targetSha256: selected.targetSha256, target, owner, producers,
    }, migration, { confirmation, verifySession, record: () => {} }, profile);
    await applySql(migration);
    const { rows: after } = await admin.query(journalSql);
    assert.equal(after.length, 83);
    assert.deepEqual(await readMigrationCatalog(admin), selected.baseline.catalog);
    const packet = packetFor(probe, physical, owner, runtime, after);
    const result = await observeP2FrontendReplacementWritten(packet, dependencies);
    assert.deepEqual(result, {
      ...physical, operation: "verify-replacement-written", status: "P2_FRONTEND_REPLACEMENT_WRITTEN_VERIFIED",
      physicalObservationSha256: encodedHash(packet.physicalObservation), databaseReceiptSha256: encodedHash(packet.databaseReceipt),
      continuationStartedSha256: encodedHash(packet.continuationStarted), owner, runtime, producerSha256, appliedMigrationCount: 83,
      epoch: "1", newWork: false, recovery: false, active: 0, uncertain: 0, schemaVerified: true, runtimeRoleVerified: true,
      administrativeLogins: [], effectiveLoginBoundaryVerified: true,
    });
    assert.equal(JSON.stringify(result).includes(password), false);
    if (packaged) {
      const accepted = packagedWritten(packet, url, cert);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(accepted.stdout.includes(password), false);
      assert.deepEqual(JSON.parse(accepted.stdout), result);
      const wrongCommit = sourceCommit === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
      const wrongProbe = { ...selection(cluster.port, serverMajor, wrongCommit, selected.baseline.catalog),
        ...identity, marker: probe.marker, backendPid: probe.backendPid, backendStart: probe.backendStart };
      for (const [input, args] of [
        [packetFor(wrongProbe, physicalProof(wrongProbe), owner, runtime, after), []],
        [{ ...packet, extra: true }, []],
        [packet, ["--unreviewed"]],
      ]) {
        const denied = packagedWritten(input, url, cert, args);
        assert.equal(denied.status, 1);
        assert.equal(denied.stdout, "");
        assert.equal(denied.stderr.trim(), "FRONTEND_PACKAGED_SOURCE_REFUSED");
        assert.equal(denied.stderr.includes(password), false);
      }
    }

    const observe = input => observeP2FrontendReplacementWritten(input, dependencies);
    await assert.rejects(observe({ ...packet, owner: { ...owner, oid: "1" } }), refusal);
    await assert.rejects(observe({ ...packet, runtime: { ...runtime, oid: "1" } }), refusal);
    await assert.rejects(observe({ ...packet, producerSha256: "e".repeat(64) }), refusal);
    const refuseDrift = async (label, apply, restore) => {
      await apply();
      try { await assert.rejects(observe(packet), refusal, label); }
      finally { await restore(); }
    };
    const sqlDrift = (label, change, revert) => refuseDrift(label, () => admin.query(change), () => admin.query(revert));
    await sqlDrift("journal hash", "UPDATE drizzle.__drizzle_migrations SET hash='unexpected' WHERE id=1",
      `UPDATE drizzle.__drizzle_migrations SET hash='${after[0].hash}' WHERE id=1`);
    await sqlDrift("unreviewed schema", "CREATE TABLE public.unreviewed_data(id int)", "DROP TABLE public.unreviewed_data");
    await sqlDrift("runtime has journal privilege",
      `GRANT USAGE ON SCHEMA drizzle TO "${runtime.name}"`, `REVOKE USAGE ON SCHEMA drizzle FROM "${runtime.name}"`);
    await sqlDrift("runtime loses public schema USAGE",
      `REVOKE USAGE ON SCHEMA public FROM PUBLIC,"${runtime.name}"`, `GRANT USAGE ON SCHEMA public TO PUBLIC,"${runtime.name}"`);
    await sqlDrift("runtime loses database CONNECT",
      `REVOKE CONNECT ON DATABASE owned_replacement FROM "${runtime.name}"`, `GRANT CONNECT ON DATABASE owned_replacement TO "${runtime.name}"`);
    await sqlDrift("runtime gains database TEMP",
      `GRANT TEMP ON DATABASE owned_replacement TO "${runtime.name}"`, `REVOKE TEMP ON DATABASE owned_replacement FROM "${runtime.name}"`);
    await sqlDrift("admission owner can log in", `ALTER ROLE "${owner.name}" LOGIN`, `ALTER ROLE "${owner.name}" NOLOGIN`);
    await sqlDrift("predecessor role exists without CONNECT", "CREATE ROLE owned_previous_runtime NOLOGIN", "DROP ROLE owned_previous_runtime");
    await sqlDrift("PUBLIC can execute admission procedure", "GRANT EXECUTE ON PROCEDURE frontend_admission.finish_operation(uuid,text) TO PUBLIC",
      "REVOKE EXECUTE ON PROCEDURE frontend_admission.finish_operation(uuid,text) FROM PUBLIC");
    await admin.query(`CREATE ROLE owned_admin_z LOGIN; CREATE ROLE owned_admin_a LOGIN;
      GRANT CONNECT ON DATABASE owned_replacement TO owned_admin_a, owned_admin_z`);
    try {
      await assert.rejects(observe(packet), refusal, "undeclared effective logins");
      const { rows: administrativeLogins } = await admin.query(`SELECT rolname AS name,oid::text FROM pg_catalog.pg_roles
        WHERE rolname IN ('owned_admin_a','owned_admin_z') ORDER BY rolname`);
      assert.equal(administrativeLogins.length, 2);
      await assert.rejects(observe({ ...packet, administrativeLogins: [{ ...administrativeLogins[0], oid: "1" }, administrativeLogins[1]] }),
        refusal, "reviewed name with substituted OID");
      assert.deepEqual(await observe({ ...packet, administrativeLogins: [...administrativeLogins].reverse() }),
        { ...result, administrativeLogins });
    } finally {
      await admin.query(`REVOKE CONNECT ON DATABASE owned_replacement FROM owned_admin_a, owned_admin_z;
        DROP ROLE owned_admin_a, owned_admin_z`);
    }
    assert.deepEqual(await observe(packet), result);
    await sqlDrift("producer disabled", "UPDATE frontend_admission.producers SET enabled=false", "UPDATE frontend_admission.producers SET enabled=true");
    await sqlDrift("new work open", "UPDATE frontend_admission.control SET new_work=true", "UPDATE frontend_admission.control SET new_work=false");
    await sqlDrift("recovery open", "UPDATE frontend_admission.control SET recovery=true", "UPDATE frontend_admission.control SET recovery=false");
    for (const state of ["active", "uncertain"]) {
      const operationId = randomUUID();
      await refuseDrift(`${state} admission operation`, () => admin.query(`INSERT INTO frontend_admission.operations
        (id,producer_sha256,source_sha,database_role,epoch,kind,state) VALUES($1,$2,$3,$4,1,'recovery',$5)`,
        [operationId, producerSha256, job.sourceCommit, runtime.oid, state]),
      () => admin.query("DELETE FROM frontend_admission.operations WHERE id=$1", [operationId]));
    }
    for (const lockKey of [probe.marker, FRONTEND_MIGRATION_LOCK]) {
      await unlock(migration, lockKey);
      await lock(admin, lockKey);
      try { await assert.rejects(observe(packet), refusal, "lock held by wrong backend"); }
      finally { await unlock(admin, lockKey); await lock(migration, lockKey); }
    }
    await admin.query("BEGIN; LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE");
    const pending = observe(packet);
    void pending.catch(() => {});
    let markerReleased = false;
    try {
      const deadline = Date.now() + 1500;
      let waiting = false;
      do {
        const { rows: [activity] } = await setup.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE datid=$1::oid AND application_name='lash-her-frontend-replacement-observer' AND wait_event_type='Lock'
          AND query ILIKE '%from drizzle.__drizzle_migrations%') AS waiting`, [probe.databaseOid]);
        waiting = activity.waiting;
        if (!waiting) await delay(20);
      } while (!waiting && Date.now() < deadline);
      assert.equal(waiting, true);
      await unlock(migration, probe.marker);
      markerReleased = true;
    } finally { await admin.query("ROLLBACK"); }
    try { await assert.rejects(pending, refusal, "marker lost after journal read starts"); }
    finally { if (markerReleased) await lock(migration, probe.marker); }
    await verifySession();
    assert.deepEqual(await observe(packet), result);
    assert.deepEqual((await admin.query(journalSql)).rows, after);
    await migration.end();
    await assert.rejects(observe(packet), refusal);
  } finally {
    try { await Promise.allSettled(clients.map(client => client.end())); }
    finally {
      await cluster?.stop();
      setDefaultCACertificates(originalCa);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

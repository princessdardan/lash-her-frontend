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
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendConnectionOptions, frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { openOwnedFrontendReplacementCluster } from "./harness/owned-frontend-replacement-cluster.mjs";
import { abortP2FrontendReplacement } from "./p2-frontend-replacement-abort.mjs";
import { observeHeldFrontendReplacement } from "./p2-frontend-replacement-arm.mjs";
import { createP2FrontendReplacementProbe, observeP2FrontendReplacement } from "./p2-frontend-replacement-probe.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as profile } from "./qualification-target-profile.mjs";

const refusal = { message: "P2_FRONTEND_REPLACEMENT_ABORT_REFUSED" };
const artifact = frontendMigrationArtifact();
const hash = value => createHash("sha256").update(value).digest("hex");
const raw = value => Buffer.from(JSON.stringify(value) + "\n");
function selection(port = 5432, serverMajor = 16, sourceCommit = "a".repeat(40)) {
  const releaseId = "owned-replacement-abort", migrationImageDigest = "sha256:" + "b".repeat(64);
  const target = { host: "127.0.0.1", port, database: "owned_replacement", user: "owned_migrator",
    runtimeRole: "owned_runtime", serverMajor };
  const predecessorTarget = { ...target, database: "owned_previous", runtimeRole: "owned_previous_runtime" };
  const { sqlArtifactSha256, contractManifestSha256, contractPhase, phase2ContractManifestSha256 } = artifact;
  const baseline = { version: 1, serverMajor, sqlArtifactSha256,
    catalog: Object.fromEntries(["relations", "columns", "constraints", "indexes", "triggers", "functions",
      "enums", "sequences", "policies"].map(key => [key, []])) };
  const job = { version: 2, qualificationTargetProfile: profile, operator: "Dardan", environment: "staging", releaseId,
    sourceCommit, contractPhase, phase2ContractManifestSha256, contractManifestSha256, migrationImageDigest, sqlArtifactSha256,
    schemaBaselineSha256: hash(JSON.stringify(baseline)), recoveryRef: "owned/previous",
    target: { ...target, qualificationTargetProfile: profile, allowEmptyBootstrap: true,
      approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
  const candidate = { version: 3, qualificationTargetProfile: profile, environment: "staging", releaseId,
    contractPhase, phase2ContractManifestSha256, contractManifestSha256, integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
    sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
    artifacts: { frontendMigration: { image: "ghcr.io/princessdardan/lash-her-platform-frontend-migration@" + migrationImageDigest } },
    frontendMigration: { qualificationTargetProfile: profile, sourceCommit, sqlArtifactSha256, contractManifestSha256,
      contractPhase, phase2ContractManifestSha256, schemaBaselines: { [serverMajor]: job.schemaBaselineSha256 } } };
  return { version: 1, qualificationTargetProfile: profile, operation: "verify-pre-bootstrap-lock",
    candidate, job, baseline, predecessorTarget, targetSha256: frontendAdmissionTargetSha256("staging", target),
    databaseOid: "42", migrationRoleOid: "43" };
}

test("abort refuses changed or ambiguous retained proof before credential resolution", async () => {
  const input = { ...selection(), backendPid: 42, backendStart: "2026-11-07T00:00:00.000000Z", marker: "f".repeat(64) };
  let requested = false;
  const dependencies = { getUrl() { requested = true; } };
  for (const observation of [
    Buffer.from('{"version":1,"version":1}'), raw({ ...input, authorityIssued: true }),
    raw({ status: "P2_FRONTEND_REPLACEMENT_PHYSICAL_LOCK_VERIFIED", backendPid: 42 }),
  ]) await assert.rejects(abortP2FrontendReplacement(input, observation, dependencies), refusal);
  assert.equal(requested, false);
});

test("owned TLS PostgreSQL aborts only the retained backend and observes committed journal state without replay", {
  skip: process.env.P2_FRONTEND_REPLACEMENT_ABORT_OWNED_TEST !== "true", timeout: 120000,
}, async () => {
  const pgBin = process.env.PG_BIN;
  assert.ok(pgBin?.startsWith("/"));
  const postgresVersion = execFileSync(join(pgBin, "postgres"), ["--version"], { encoding: "utf8" });
  const serverMajor = Number(postgresVersion.match(/PostgreSQL\) (16|18)\./u)?.[1]);
  assert.ok([16, 18].includes(serverMajor));
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "p2-replacement-abort-"));
  const key = join(directory, "server.key"), cert = join(directory, "server.crt"), clients = [];
  const originalCa = getCACertificates("default");
  const packaged = process.env.P2_FRONTEND_REPLACEMENT_PACKAGED_TEST === "true";
  const packagedCommit = packaged ? JSON.parse(readFileSync("/candidate/migration-source.json", "utf8")).commit : undefined;
  let cluster;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
    setDefaultCACertificates([...originalCa, readFileSync(cert, "utf8")]);
    const workspace = join(directory, "cluster");
    mkdirSync(workspace, { mode: 0o700 });
    cluster = await openOwnedFrontendReplacementCluster(workspace, pgBin, "owned_frontend_admin", key, cert);
    const setup = await cluster.connect("postgres");
    clients.push(setup);
    const password = randomUUID(), selected = selection(cluster.port, serverMajor, packagedCommit), target = selected.job.target;
    await setup.query(`CREATE ROLE owned_migrator LOGIN PASSWORD '${password}'`);
    await setup.query("CREATE DATABASE owned_replacement OWNER owned_migrator");
    const url = `postgresql://${target.user}:${password}@${target.host}:${target.port}/${target.database}?sslmode=verify-full`;
    const dependencies = { getUrl: () => url };
    const executePackaged = (input, args = []) => spawnSync(process.execPath, ["/candidate/ops/platform/frontend-image.mjs",
      "--abort-replacement", ...args], { encoding: "utf8", input, timeout: 30_000, env: {
      PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: cert, FRONTEND_STAGING_MIGRATION_DATABASE_URL: url,
    } });
    const abort = async (probe, physicalObservation) => {
      if (!packaged) return abortP2FrontendReplacement(probe, physicalObservation, dependencies);
      const accepted = executePackaged(JSON.stringify({ probe, physicalObservation: physicalObservation.toString("base64") }));
      assert.equal(accepted.status, 0);
      assert.ok(!accepted.stdout.includes(password));
      return JSON.parse(accepted.stdout);
    };
    const connect = async () => {
      const client = new Client(frontendConnectionOptions(url, target));
      client.on("error", () => {});
      clients.push(client);
      await client.connect();
      return client;
    };
    const lock = (client, key) => client.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [key]);
    const unlock = (client, key) => client.query("SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [key]);
    const makeProbe = async (client) => {
      const { rows: [identity] } = await client.query(`SELECT datid::text AS "databaseOid",usesysid::text AS "migrationRoleOid"
        FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
      await lock(client, FRONTEND_MIGRATION_LOCK);
      const probe = await createP2FrontendReplacementProbe({ ...selected, ...identity }, client, async () => {});
      const observation = await observeP2FrontendReplacement(probe, dependencies);
      return { probe, observation };
    };
    const catalogSetup = await connect();
    await catalogSetup.query("REVOKE ALL ON DATABASE owned_replacement FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const { rows: [identities] } = await catalogSetup.query(`SELECT
      datid::text AS "databaseOid",usesysid::text AS "migrationRoleOid",
      (SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname='owned_frontend_admin') AS "adminOid"
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
    await catalogSetup.end();
    const { databaseOid, migrationRoleOid, adminOid } = identities;
    const heldPlan = { probe: { ...selected, databaseOid, migrationRoleOid },
      plan: { replacement: { target: Object.fromEntries(Object.keys(selected.predecessorTarget).map(key => [key, target[key]])) } },
      administrativeLogins: [{ name: "owned_frontend_admin", oid: adminOid }] };
    let guardChecks = 0;
    const independent = async (probe, corrupt = false) => {
      const physical = await observeP2FrontendReplacement(probe, dependencies);
      if (corrupt) physical.databaseOid = "1";
      const bytes = raw(physical);
      return { physicalObservation: bytes.toString("base64"), physicalObservationSha256: hash(bytes), armReceiptSha256: "d".repeat(64) };
    };
    const custody = { signal: new AbortController().signal, arm: independent,
      async verifyEnvironment() { guardChecks++; } };
    const verified = await observeHeldFrontendReplacement(heldPlan, url, custody);
    assert.equal(verified.boundary.databaseOid, databaseOid);
    assert.equal(verified.boundary.readOnlyVerified, true);
    assert.equal(verified.boundary.authorityIssued, false);
    assert.ok(guardChecks >= 4);
    await assert.rejects(observeHeldFrontendReplacement(heldPlan, url, {
      ...custody, arm: probe => independent(probe, true),
    }), /ARM_REVIEW_REQUIRED/u);
    const droppedGuard = new AbortController();
    await assert.rejects(observeHeldFrontendReplacement(heldPlan, url, {
      ...custody, signal: droppedGuard.signal, async arm(probe) {
        const observed = await independent(probe);
        droppedGuard.abort();
        return observed;
      },
    }), /ARM_REVIEW_REQUIRED/u);

    const beforeJournal = await connect();
    const { rows: [beforeArmEffects] } = await beforeJournal.query(`SELECT
      pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NULL AS "journalAbsent",
      pg_catalog.to_regnamespace('frontend_admission') IS NULL AS "admissionAbsent",
      NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND database=$1::oid) AS "locksAbsent"`, [databaseOid]);
    assert.deepEqual(beforeArmEffects, { journalAbsent: true, admissionAbsent: true, locksAbsent: true });
    const absent = await makeProbe(beforeJournal), absentRaw = raw(absent.observation);
    if (packaged) {
      const packet = { probe: absent.probe, physicalObservation: absentRaw.toString("base64") };
      const wrongCommit = packagedCommit === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
      const wrongProbe = structuredClone(packet.probe);
      wrongProbe.job.sourceCommit = wrongCommit;
      wrongProbe.candidate.sources.frontend.commit = wrongCommit;
      wrongProbe.candidate.frontendMigration.sourceCommit = wrongCommit;
      for (const [input, args] of [
        [JSON.stringify({ ...packet, probe: wrongProbe,
          physicalObservation: raw({ ...absent.observation, sourceCommit: wrongCommit }).toString("base64") })],
        [JSON.stringify({ ...packet, physicalObservation: packet.physicalObservation + "\n" })],
        [JSON.stringify({ ...packet, extra: true })],
        [`{"probe":${JSON.stringify(packet.probe)},"physicalObservation":"e30=","physicalObservation":${JSON.stringify(packet.physicalObservation)}}`],
        [Buffer.alloc(2_000_001, 32)],
        [JSON.stringify(packet), ["--unreviewed"]],
      ]) {
        const refused = executePackaged(input, args);
        assert.equal(refused.status, 1);
        assert.equal(refused.stdout, "");
        assert.equal(refused.stderr.trim().split("\n").at(-1), "FRONTEND_PACKAGED_SOURCE_REFUSED");
        assert.ok(!refused.stderr.includes(password));
        assert.equal((await beforeJournal.query("SELECT 1 AS alive")).rows[0].alive, 1);
      }
    }
    const empty = await abort(absent.probe, absentRaw);
    assert.equal(empty.backendTerminated, true);
    assert.equal(empty.journalPresent, false);
    assert.deepEqual(empty.appliedPrefix, []);
    assert.equal(empty.physicalObservationSha256, hash(absentRaw));
    assert.equal((await abortP2FrontendReplacement(absent.probe, absentRaw, dependencies)).backendTerminated, false);

    const migration = await connect(), other = await connect();
    const { probe, observation } = await makeProbe(migration), observationRaw = raw(observation);
    await assert.rejects(abortP2FrontendReplacement({ ...probe, marker: "e".repeat(64) }, observationRaw, dependencies), refusal);
    for (const change of [{ backendPid: other.processID }, { migrationRoleOid: "1" }, { databaseOid: "1" }]) {
      await assert.rejects(abortP2FrontendReplacement({ ...probe, ...change }, raw({ ...observation, ...change }), dependencies), refusal);
    }
    assert.equal((await migration.query("SELECT 1 AS alive")).rows[0].alive, 1);
    await unlock(migration, probe.marker);
    await lock(other, probe.marker);
    await assert.rejects(abortP2FrontendReplacement(probe, observationRaw, dependencies), refusal);
    assert.equal((await migration.query("SELECT 1 AS alive")).rows[0].alive, 1);
    await unlock(other, probe.marker);
    await unlock(migration, FRONTEND_MIGRATION_LOCK);
    await lock(other, FRONTEND_MIGRATION_LOCK);
    await assert.rejects(abortP2FrontendReplacement(probe, observationRaw, dependencies), refusal);
    assert.equal((await migration.query("SELECT 1 AS alive")).rows[0].alive, 1);
    await unlock(other, FRONTEND_MIGRATION_LOCK);

    const [first, second] = artifact.migrations;
    await migration.query("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)");
    async function beginMigration({ sql, hash, folderMillis }) {
      await migration.query("BEGIN");
      for (const statement of sql) await migration.query(statement);
      await migration.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [hash, folderMillis]);
    }
    await beginMigration(first);
    await migration.query("COMMIT");
    await beginMigration(second);
    const result = await abort(probe, observationRaw);
    assert.equal(result.status, "P2_FRONTEND_REPLACEMENT_ABORT_OBSERVED");
    for (const key of ["backendTerminated", "originalBackendAbsent", "originalLocksAbsent", "observationLockReleased",
      "journalPresent", "readOnlyVerified"]) {
      assert.equal(result[key], true, key);
    }
    for (const key of ["authorityIssued", "trafficAuthorized", "replayAuthorized"]) assert.equal(result[key], false, key);
    const { tag, hash: firstHash, folderMillis } = first;
    assert.deepEqual(result.appliedPrefix, [{ tag, hash: firstHash, folderMillis }]);
    assert.equal(result.appliedPrefixSha256, hash(JSON.stringify(result.appliedPrefix)));
    const { rows: [catalog] } = await other.query(`SELECT to_regclass('public.checkout_orders')::text AS first,
      to_regclass('public.training_enrollments')::text AS second, pg_backend_pid() AS pid`);
    assert.deepEqual(catalog, { first: "checkout_orders", second: null, pid: other.processID });

    // Stall the journal read after the observer has taken the migration lock.
    // Another backend cannot begin a coordinated migration during that read.
    await other.query("BEGIN; LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE");
    const pending = abortP2FrontendReplacement(probe, observationRaw, dependencies);
    void pending.catch(() => {});
    try {
      let waiting = false;
      const deadline = Date.now() + 1_500;
      do {
        const { rows: [observed] } = await setup.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a
          WHERE a.datid=$1::oid AND a.application_name='lash-her-frontend-replacement-abort'
          AND a.wait_event_type='Lock' AND a.query LIKE '%FROM drizzle.__drizzle_migrations%') AS waiting`, [probe.databaseOid]);
        waiting = observed.waiting;
        if (!waiting) await delay(20);
      } while (!waiting && Date.now() < deadline);
      assert.equal(waiting, true);
      const { rows: [contended] } = await other.query("SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext($1)) AS acquired",
        [FRONTEND_MIGRATION_LOCK]);
      assert.equal(contended.acquired, false);
    } finally { await other.query("ROLLBACK"); }
    const reobserved = await pending;
    assert.deepEqual(reobserved.appliedPrefix, result.appliedPrefix);
    assert.equal(reobserved.observationLockReleased, true);
    const { rows: [available] } = await other.query("SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext($1)) AS acquired",
      [FRONTEND_MIGRATION_LOCK]);
    assert.equal(available.acquired, true);

    await other.query("UPDATE drizzle.__drizzle_migrations SET hash='unexpected'");
    await assert.rejects(abortP2FrontendReplacement(probe, observationRaw, dependencies), refusal);
  } finally {
    try { await Promise.allSettled(clients.map(client => client.end())); }
    finally {
      await cluster?.stop();
      setDefaultCACertificates(originalCa);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

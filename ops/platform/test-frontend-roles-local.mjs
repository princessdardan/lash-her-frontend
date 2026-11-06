// Disposable owned TLS/SCRAM PostgreSQL only. No ambient database URL is read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, unlinkSync, realpathSync, readdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { withFrontendEnvironmentLock } from "./frontend-environment-lock.mjs";
import { prepareFrontendRolesPlan, applyPreparedFrontendRoles, FRONTEND_PREPARATION_ROLES as names, frontendRolesHash } from "./frontend-role-preparation.mjs";

const execute = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lockName = "lash-her:private-db:migrations";
let phase = "ownership";
async function main() {
  assert.equal(process.env.FRONTEND_ROLES_OWNED_TEST, "true");
  const binaries = process.env.PG_BIN, major = Number(process.env.OWNED_POSTGRES_MAJOR ?? "16"); assert.ok(binaries?.startsWith("/") && [16, 18].includes(major));
  assert.match(execute(join(binaries, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const listener = createServer(); await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-roles-owned-"))), data = join(directory, "data"), password = `owned-${randomUUID()}`;
  chmodSync(directory, 0o700); const clients = [], checks = [], outcomes = []; let started = false, scenario = 0;
  const record = name => checks.push(name);
  try {
    phase = "cluster";
    execute(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "frontend_test_admin", "-E", "UTF8", "--locale=C"]);
    const certificate = join(directory, "server.crt"), key = join(directory, "server.key");
    execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\nlog_statement='none'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all frontend_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    execute(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
    const connect = async (database, user = "frontend_test_admin", suppliedPassword = password) => {
      const client = new Client({ host: "127.0.0.1", port, database, user, password: suppliedPassword, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
      client.on("error", () => {}); clients.push(client); await client.connect(); return client;
    };
    const setup = await connect("postgres");
    await setup.query(`CREATE ROLE frontend_operator LOGIN CREATEROLE NOINHERIT PASSWORD '${password}'`);
    await setup.query(`CREATE ROLE old_frontend_runtime LOGIN INHERIT PASSWORD '${password}'`);
    await setup.query("CREATE DATABASE frontend_role_owned OWNER frontend_operator");
    const administrator = await connect("frontend_role_owned"), operator = await connect("frontend_role_owned", "frontend_operator");
    await operator.query("CREATE TABLE public.preserved_data(id serial PRIMARY KEY,value text NOT NULL)");
    await operator.query("INSERT INTO public.preserved_data(value) VALUES('synthetic-preserved-row')");
    await operator.query("CREATE SCHEMA drizzle"); await operator.query("CREATE TABLE drizzle.__drizzle_migrations(id int,hash text)");
    await operator.query("INSERT INTO drizzle.__drizzle_migrations VALUES(1,'synthetic-unchanged-journal')");
    await operator.query("GRANT USAGE ON SCHEMA public TO old_frontend_runtime"); await operator.query("GRANT SELECT ON public.preserved_data TO old_frontend_runtime");
    const before = { data: (await operator.query("TABLE public.preserved_data")).rows, journal: (await operator.query("TABLE drizzle.__drizzle_migrations")).rows,
      oldRole: (await operator.query("SELECT oid::text,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole FROM pg_roles WHERE rolname='old_frontend_runtime'")).rows,
      oldAcl: (await operator.query("SELECT relacl::text FROM pg_class WHERE oid='public.preserved_data'::regclass")).rows };
    const fixture = (suffix = "case", reuse) => {
      const action = `owned-role-${++scenario}-${suffix}`, sourceCommit = "a".repeat(40), sqlArtifactSha256 = "b".repeat(64), contract = `sha256:${"c".repeat(64)}`, image = `sha256:${"d".repeat(64)}`;
      const candidate = { version: 2, environment: "staging", releaseId: action, integration: { state: "passed" }, sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" },
        sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" } },
        contractPhase: "p2", phase2ContractManifestSha256: contract, contractManifestSha256: `sha256:${"e".repeat(64)}`,
        frontendMigration: { sourceCommit, sqlArtifactSha256, contractPhase: "p2", phase2ContractManifestSha256: contract, contractManifestSha256: `sha256:${"e".repeat(64)}` }, artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${image}` } } };
      const job = { version: 1, operator: "Dardan", environment: "staging", releaseId: action, sourceCommit, sqlArtifactSha256, contractPhase: "p2", phase2ContractManifestSha256: contract,
        contractManifestSha256: candidate.contractManifestSha256, migrationImageDigest: image, recoveryRef: "owned/recovery-1",
        target: { host: "127.0.0.1", port, database: "frontend_role_owned", user: "frontend_operator", runtimeRole: names.runtime, serverMajor: major } };
      const receipts = join(directory, `${action}-receipts`), privatePath = join(directory, `${action}-private`); mkdirSync(receipts, { mode: 0o700 }); mkdirSync(privatePath, { mode: 0o700 });
      return { candidate, job, plan: prepareFrontendRolesPlan(candidate, job, { version: 1, producerSha256: ["f".repeat(64)], ...(reuse ? { reuse } : {}) }), directory: receipts, privateDirectory: privatePath };
    };
    const pid = (await operator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const verifySession = async () => assert.equal((await operator.query("SELECT pg_backend_pid() AS pid")).rows[0].pid, pid);
    const existingNewRoles = async () => (await operator.query("SELECT oid::text,rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", [Object.values(names)])).rows;
    const resetNewRoles = async () => {
      for (const name of [names.runtime, names.owner]) if ((await existingNewRoles()).some(row => row.rolname === name)) {
        await administrator.query(`DROP OWNED BY "${name}"`); await administrator.query(`DROP ROLE "${name}"`);
      }
    };
    phase = "real-parent-locks";
    await withFrontendEnvironmentLock(async verifyEnvironment => {
      const lockPath = join(directory, "environment.lock");
      await assert.rejects(withFrontendEnvironmentLock(async () => {}, { path: lockPath })); record("actual-environment-flock-contention-refuses-second-parent");
      const other = await connect("frontend_role_owned", "frontend_operator");
      assert.equal((await other.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockName])).rows[0].locked, true);
      const blocked = fixture("contended"); await assert.rejects(applyPreparedFrontendRoles(blocked.plan, operator, { ...blocked, confirmation: `staging/${blocked.plan.actionId}`, verifyEnvironment, verifySession }));
      assert.equal((await existingNewRoles()).length, 0); record("actual-physical-lock-contention-refuses-before-role-mutation");
      await other.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
      assert.equal((await operator.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockName])).rows[0].locked, true);
      const run = (f, client = operator, extra = {}) => applyPreparedFrontendRoles(f.plan, client, { ...f, confirmation: `staging/${f.plan.actionId}`, verifyEnvironment, verifySession, ...extra });
      phase = "wrong-target-role";
      const wrongTarget = fixture("wrong-target"); wrongTarget.job.target.database = "wrong_database"; wrongTarget.plan = prepareFrontendRolesPlan(wrongTarget.candidate, wrongTarget.job, { version: 1, producerSha256: ["f".repeat(64)] });
      await assert.rejects(run(wrongTarget)); record("actual-wrong-target-refused"); await assert.rejects(run(fixture("wrong-role"), administrator)); record("actual-wrong-session-role-refused");
      await administrator.query(`CREATE ROLE "${names.owner}" NOLOGIN INHERIT`); await assert.rejects(run(fixture("collision")));
      assert.equal((await administrator.query("SELECT rolinherit FROM pg_roles WHERE rolname=$1", [names.owner])).rows[0].rolinherit, true); await administrator.query(`DROP ROLE "${names.owner}"`); record("unrelated-existing-name-is-not-coerced");
      phase = "rollback";
      const rollback = fixture("rollback"), originalQuery = operator.query.bind(operator);
      let mutations = 0;
      const failing = { connection: operator.connection, connectionParameters: operator.connectionParameters, query: async (sql, values) => { if (sql.startsWith("CREATE ROLE")) { mutations++; if (mutations === 2) throw Error("owned-injected-before-second-role"); } return originalQuery(sql, values); } };
      await assert.rejects(run(rollback, failing)); assert.equal((await existingNewRoles()).length, 0);
      const rollbackOutcome = JSON.parse(readFileSync(join(rollback.directory, "roles-preparation-outcome.json"))); assert.equal(rollbackOutcome.sqlOutcome, "rolled-back"); outcomes.push(rollbackOutcome); record("actual-role-creation-rollback-retains-intent-and-private-credential");
      await assert.rejects(run(rollback)); assert.equal(mutations, 2); record("failed-action-is-never-replayed");
      phase = "missing-private-receipt";
      const missing = fixture("missing-private"); let environmentChecks = 0;
      await assert.rejects(run(missing, operator, { verifyEnvironment: async () => { await verifyEnvironment(); if (++environmentChecks === 2) unlinkSync(join(missing.privateDirectory, "frontend-role-credentials.json")); } }));
      assert.equal((await existingNewRoles()).length, 0); const missingOutcome=JSON.parse(readFileSync(join(missing.directory, "roles-preparation-outcome.json"))); assert.equal(missingOutcome.sqlOutcome,"not-started"); outcomes.push(missingOutcome); record("missing-private-credential-receipt-refuses-before-role-sql");
      phase = "prepare-real-roles";
      const positive = fixture("positive"); let prepared;
      try { prepared = await run(positive); } catch {
        const failure = JSON.parse(readFileSync(join(positive.directory, "roles-preparation-outcome.json"), "utf8"));
        process.stderr.write(JSON.stringify({diagnostic:"owned-positive-refusal",phase:failure.phase,sqlState:failure.sqlState,checkpoint:failure.checkpoint})+"\n"); throw Error("owned-positive-refusal");
      } outcomes.push(JSON.parse(JSON.stringify(prepared)));
      assert.ok(prepared.owner.oid !== prepared.runtime.oid); assert.deepEqual((await existingNewRoles()).map(row => row.oid).sort(), [prepared.owner.oid, prepared.runtime.oid].sort());
      assert.equal(statSync(prepared.private.credentialReceiptRef).mode & 0o777, 0o600); record("real-postgres-assigned-oids-and-private-credential-retained");
      const serialized = JSON.stringify(prepared), credential = JSON.parse(readFileSync(prepared.private.credentialReceiptRef, "utf8"));
      assert.ok(!serialized.includes(credential.password) && !serialized.includes("postgresql:") && !serialized.includes("credentialReceiptRef")); record("public-output-does-not-serialize-private-credentials");
      const runtime = await connect("frontend_role_owned", prepared.runtime.name, credential.password);
      await runtime.query("INSERT INTO public.preserved_data(value) VALUES('synthetic-new-runtime-row')");
      await runtime.query("UPDATE public.preserved_data SET value='synthetic-updated-row' WHERE value='synthetic-new-runtime-row'");
      await runtime.query("DELETE FROM public.preserved_data WHERE value='synthetic-updated-row'"); record("actual-runtime-public-crud-and-sequence-usage");
      for (const sql of ["CREATE TABLE public.must_not_exist(id int)", "CREATE SCHEMA must_not_exist", "SELECT * FROM drizzle.__drizzle_migrations", `SET ROLE "${names.owner}"`, "SET ROLE frontend_operator"])
        await assert.rejects(runtime.query(sql), error => error.code === "42501"); record("actual-runtime-persistent-ddl-journal-and-membership-denied");
      await operator.query("BEGIN"); await operator.query(`SET LOCAL ROLE "${names.owner}"`); await operator.query("CREATE SCHEMA owned_admission_ability_probe"); await operator.query("ROLLBACK"); record("owner-can-create-schema-only-through-operator-set-role");
      await operator.query("CREATE TABLE public.future_default_grant(id serial PRIMARY KEY,value text)");
      await runtime.query("INSERT INTO public.future_default_grant(value) VALUES('synthetic-future')"); record("actual-future-table-and-sequence-default-grants");
      const reuse = { ownerOid: prepared.owner.oid, runtimeOid: prepared.runtime.oid, proofSha256: prepared.proofSha256 };
      const reused = fixture("reuse", reuse), reusedProof = await run(reused, operator, { reuseDirectory: positive.directory, reusePrivateDirectory: positive.privateDirectory });
      assert.deepEqual(reusedProof.owner, prepared.owner); assert.deepEqual(reusedProof.runtime, prepared.runtime); record("exact-approved-oid-grant-and-private-credential-reuse");
      const wrongOid = fixture("wrong-oid", { ...reuse, runtimeOid: "1" }); await assert.rejects(run(wrongOid, operator, { reuseDirectory: positive.directory, reusePrivateDirectory: positive.privateDirectory })); record("wrong-reuse-oid-refused");
      await operator.query(`GRANT TRUNCATE ON public.preserved_data TO "${names.runtime}"`);
      await assert.rejects(run(fixture("wrong-grants", reuse), operator, { reuseDirectory: positive.directory, reusePrivateDirectory: positive.privateDirectory }));
      await operator.query(`REVOKE TRUNCATE ON public.preserved_data FROM "${names.runtime}"`); record("existing-role-extra-grants-refused-without-coercion");
      await runtime.end();
      assert.deepEqual((await operator.query("TABLE public.preserved_data")).rows, before.data); assert.deepEqual((await operator.query("TABLE drizzle.__drizzle_migrations")).rows, before.journal);
      assert.deepEqual((await operator.query("SELECT oid::text,rolname,rolcanlogin,rolinherit,rolsuper,rolcreaterole FROM pg_roles WHERE rolname='old_frontend_runtime'")).rows, before.oldRole);
      const oldReader = await connect("frontend_role_owned", "old_frontend_runtime"); assert.deepEqual((await oldReader.query("TABLE public.preserved_data")).rows, before.data); record("old-role-oid-flags-access-and-actual-data-journal-preserved");
      assert.equal((await operator.query("SELECT to_regnamespace('frontend_admission') IS NULL AS absent")).rows[0].absent, true); record("no-admission-ledger-application-migration-or-feature-activation");
      await resetNewRoles();
      phase = "lost-commit-acknowledgment";
      const lost = fixture("lost-ack"); let commits = 0, roleQueries = 0;
      const losing = { connection: operator.connection, connectionParameters: operator.connectionParameters, query: async (sql, values) => { if (sql.startsWith("CREATE ROLE")) roleQueries++; const result = await originalQuery(sql, values); if (sql === "COMMIT") { commits++; throw Error("owned-lost-commit-ack"); } return result; } };
      await assert.rejects(run(lost, losing)); const lostOutcome = JSON.parse(readFileSync(join(lost.directory, "roles-preparation-outcome.json"), "utf8"));
      assert.equal(lostOutcome.sqlOutcome, "commit-acknowledgment-unknown"); assert.equal((await existingNewRoles()).length, 2); assert.equal(commits, 1);
      assert.equal(statSync(join(lost.privateDirectory, "frontend-role-credentials.json")).mode & 0o777, 0o600); outcomes.push(lostOutcome); record("actual-commit-then-lost-ack-retains-unknown-and-private-recovery-material");
      await assert.rejects(run(lost, losing)); assert.equal(roleQueries, 2); assert.equal(commits, 1); record("lost-commit-acknowledgment-is-never-replayed");
      await operator.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
    }, { path: join(directory, "environment.lock") });
    const serverLog = readFileSync(join(directory, "postgres.log"), "utf8");
    for (const entry of readdirSync(directory).filter(name => name.endsWith("-private"))) {
      const file = join(directory, entry, "frontend-role-credentials.json");
      if (existsSync(file)) { const credential = JSON.parse(readFileSync(file, "utf8")); assert.ok(!serverLog.includes(credential.password)); assert.ok(!JSON.stringify(outcomes).includes(credential.password)); }
    }
    assert.ok(!serverLog.includes("SCRAM-SHA-256$")); record("owned-server-logs-and-public-receipts-contain-no-password-or-scram-verifier");
    return { status: "FRONTEND_ROLES_OWNED_PASS", fixtureOnly: true, postgresMajor: major, actualTls: true, actualScram: true, actualFlockContention: true,
      actualPhysicalLockContention: true, executedChecks: checks.length, skipped: 0, checks, outcomes,
      sourceModuleSha256: frontendRolesHash(readFileSync(new URL("./frontend-role-preparation.mjs", import.meta.url))), providerTouched: false, migrationAuthorized: false };
  } finally {
    for (const client of clients) { try { await client.end(); } catch { /* Disposable owned peers only. */ } }
    if (started) execute(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(directory, { recursive: true, force: true });
  }
}
main().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(() => { process.stderr.write(`${JSON.stringify({ status: "FRONTEND_ROLES_OWNED_FAILED", phase, providerTouched: false })}\n`); process.exitCode = 1; });

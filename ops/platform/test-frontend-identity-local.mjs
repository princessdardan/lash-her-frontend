// Owns a new loopback TLS/SCRAM PostgreSQL cluster. No configured URL is read.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";
import { exerciseFrontendAdmission } from "./harness/owned-frontend-admission.mjs";

const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const execute = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
function dependencyBinding() {
  const require = createRequire(import.meta.url), nextAuth = require.resolve("next-auth");
  const authCore = createRequire(nextAuth).resolve("@auth/core");
  const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  const packageAt = entry => new URL("./package.json", pathToFileURL(entry));
  return {
    packageJsonSha256: digest(join(source, "package.json")), packageLockSha256: digest(join(source, "package-lock.json")),
    nextAuth: JSON.parse(readFileSync(packageAt(nextAuth), "utf8")).version,
    authCore: JSON.parse(readFileSync(packageAt(authCore), "utf8")).version,
    installedAuthCorePackageSha256: digest(packageAt(authCore)),
    installedAuthCoreAssertSha256: digest(new URL("./lib/utils/assert.js", pathToFileURL(authCore))),
  };
}
let phase = "configuration";
async function main() {
  assert.equal(process.env.FRONTEND_IDENTITY_LOCAL_TEST, "true");
  const dependency = dependencyBinding();
  const binaries = process.env.PG_BIN;
  assert.ok(binaries?.startsWith("/"));
  const major = process.env.FRONTEND_IDENTITY_POSTGRES18_LOCAL_TEST === "true" ? 18 : 16;
  assert.match(execute(join(binaries, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const probe = createServer(); await new Promise((resolveReady, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveReady); });
  const port = probe.address().port; await new Promise((resolveClosed) => probe.close(resolveClosed));
  const directory = mkdtempSync(join(tmpdir(), "frontend-identity-owned-")), data = join(directory, "data");
  const password = `owned-${randomUUID()}`, clients = [];
  let started = false;
  try {
    phase = "cluster";
    execute(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "frontend_test_admin", "-E", "UTF8", "--locale=C"]);
    const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
    execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]);
    chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all frontend_test_admin 127.0.0.1/32 trust\nhostssl all all 127.0.0.1/32 scram-sha-256\n");
    execute(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); started = true;
    const connect = async (database, user = "frontend_test_admin") => {
      const client = new Client({ host: "127.0.0.1", port, database, user, password, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
      clients.push(client); await client.connect(); return client;
    };
    const admin = await connect("postgres");
    await admin.query(`CREATE ROLE frontend_runtime LOGIN NOINHERIT PASSWORD '${password}'`);
    await admin.query("CREATE DATABASE frontend_admission_owned");
    phase = "admission";
    const admissionChecks = await exerciseFrontendAdmission(connect, password);
    phase = "migrations";
    const owner = await connect("frontend_admission_owned");
    const artifact = frontendMigrationArtifact(source);
    await owner.query("CREATE SCHEMA drizzle");
    await owner.query("CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint)");
    for (const migration of artifact.migrations) {
      await owner.query("BEGIN");
      try {
        for (const statement of migration.sql) await owner.query(statement);
        await owner.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [migration.hash, migration.folderMillis]);
        await owner.query("COMMIT");
      } catch (error) { await owner.query("ROLLBACK"); throw error; }
    }
    await owner.query("GRANT USAGE ON SCHEMA public TO frontend_admission_protocol");
    await owner.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO frontend_admission_protocol");
    await owner.query("GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO frontend_admission_protocol");
    phase = "identity";
    const environment = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/register-server-only-test.mjs", "ops/platform/harness/owned-frontend-identity-admission.mjs"], {
      cwd: source, encoding: "utf8", timeout: 120_000,
      env: { ...environment, NODE_EXTRA_CA_CERTS: certificate, FRONTEND_IDENTITY_OWNED_TEST: "true",
        OWNED_RECONCILIATION_PORT: String(port), OWNED_RECONCILIATION_PASSWORD: password, OWNED_RECONCILIATION_MAJOR: String(major) },
    });
    assert.equal(child.status, 0, child.stderr);
    const identity = JSON.parse(child.stdout);
    assert.ok(["FRONTEND_IDENTITY_OWNED_PASS", "FRONTEND_IDENTITY_OWNED_FINDINGS"].includes(identity.status));
    // The completed owned HTTP fixture leaves immutable commands behind. Block
    // only its mutable synthetic deliveries before another file's global worker
    // scan; never allow unrelated regression fixtures to consume those commands.
    await owner.query("UPDATE customer_account_deliveries SET status='blocked',lease_id=NULL,lease_until=NULL,last_error='owned_fixture_quarantined' WHERE status<>'acknowledged'");
    await owner.query("UPDATE customer_account_exports SET status='failed',frontend_data=NULL,data=NULL WHERE status='pending'");
    phase = "regressions";
    const regressionFiles = ["src/lib/customer-auth/store.db.test.ts", "src/lib/customer-auth/receipts.db.test.ts", "src/lib/customer-auth/session-issuance.db.test.ts",
      "src/lib/customer-lifecycle/store.db.test.ts", "src/lib/customer-lifecycle/faults.db.test.ts"];
    const regression = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/register-server-only-test.mjs", "--test", "--test-concurrency=1", "--test-reporter=tap", ...regressionFiles], {
      cwd: source, encoding: "utf8", timeout: 120_000,
      env: { ...environment, NODE_ENV: "test", APP_ENV: "local", NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project", NEXT_PUBLIC_SANITY_DATASET: "test-dataset",
        NODE_EXTRA_CA_CERTS: certificate, FRONTEND_CUSTOMER_LIFECYCLE_OWNED_TEST: "true",
        TEST_DATABASE_URL: `postgresql://frontend_test_admin:${password}@127.0.0.1:${port}/frontend_admission_owned?sslmode=verify-full` },
    });
    assert.equal(regression.status, 0, regression.stderr + regression.stdout);
    const tests = Number(/^# tests (\d+)$/mu.exec(regression.stdout)?.[1]);
    assert.ok(tests >= 33, "All 17 identity and 16 lifecycle database regressions must execute");
    assert.match(regression.stdout, /^# fail 0$/mu); assert.match(regression.stdout, /^# skipped 0$/mu);
    assert.deepEqual(dependencyBinding(), dependency, "Identity qualification dependencies changed during the owned run");
    return { status: identity.findings.length ? "FRONTEND_IDENTITY_LOCAL_FINDINGS" : "FRONTEND_IDENTITY_LOCAL_PASS", postgresMajor: major, migrations: artifact.migrations.length,
      sqlArtifactSha256: artifact.sqlArtifactSha256, dependency, admissionChecks, identity,
      legacyDatabaseRegressions: { files: regressionFiles, tests, failures: 0, skipped: 0 }, providerTouched: false };
  } finally {
    for (const client of clients) { try { await client.end(); } catch { /* Owned cluster cleanup only. */ } }
    if (started) execute(join(binaries, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(directory, { recursive: true, force: true });
  }
}
main().then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); if (result.identity.findings.length) process.exitCode = 1; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "FRONTEND_IDENTITY_LOCAL_FAILED", phase, providerTouched: false,
    detail: ["identity", "regressions"].includes(phase) ? error.message : undefined,
    sqlState: /^[A-Z0-9]{5}$/u.test(error.code ?? "") ? error.code : undefined })}\n`);
  process.exitCode = 1;
});

// Owns a new loopback TLS/SCRAM cluster. No configured database URL is accepted.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, copyFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendMigrationArtifact, FRONTEND_MIGRATION_LOCK } from "./frontend-migration.mjs";
import { readMigrationCatalog } from "./frontend-schema.mjs";
import { verifyPackagedFrontendSource } from "./frontend-image-source.mjs";

const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const hash = (value) => createHash("sha256").update(value).digest("hex");
let phase = "initialization";
async function main() {
  assert.equal(process.env.FRONTEND_MIGRATION_LOCAL_TEST, "true");
  const binaries = process.env.PG_BIN; assert.ok(binaries && binaries.startsWith("/"));
  const major = process.env.FRONTEND_MIGRATION_POSTGRES18_LOCAL_TEST === "true" ? 18 : 16;
  assert.match(run(join(binaries, "postgres"), ["--version"]), new RegExp(`PostgreSQL\\) ${major}\\.`, "u"));
  const probe = createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const directory = mkdtempSync(join(tmpdir(), "frontend-migration-owned-")), data = join(directory, "data");
  let app = join(directory, "app");
  const password = `owned-${randomUUID()}`, connections = []; let running = false;
  const records = [];
  try {
    phase = "cluster";
    run(join(binaries, "initdb"), ["-D", data, "-A", "trust", "-U", "frontend_test_admin", "-E", "UTF8", "--locale=C"]);
    const key = join(directory, "server.key"), certificate = join(directory, "server.crt");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", certificate]); chmodSync(key, 0o600);
    writeFileSync(join(data, "postgresql.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${key}'\npassword_encryption='scram-sha-256'\n`);
    writeFileSync(join(data, "pg_hba.conf"), "local all all trust\nhostssl all frontend_migration 127.0.0.1/32 scram-sha-256\nhostssl all frontend_runtime 127.0.0.1/32 scram-sha-256\nhostssl all frontend_test_admin 127.0.0.1/32 trust\n");
    run(join(binaries, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]); running = true;
    const connect = async (database, user = "frontend_test_admin") => {
      const client = new Client({ host: "127.0.0.1", port, user, database, password, ssl: { rejectUnauthorized: true, ca: readFileSync(certificate, "utf8") } });
      connections.push(client); await client.connect(); return client;
    };
    const admin = await connect("postgres");
    await admin.query(`create role frontend_migration login noinherit password '${password}'`);
    await admin.query(`create role frontend_runtime login noinherit password '${password}'`);
    for (const database of ["frontend_baseline", "frontend_apply", "frontend_upgrade", "frontend_promote"]) {
      await admin.query(`create database ${database}`);
      await admin.query(`grant create,connect on database ${database} to frontend_migration`);
      const owner = await connect(database);
      await owner.query("grant usage,create on schema public to frontend_migration");
      await owner.query("grant usage on schema public to frontend_runtime");
      await owner.query("alter default privileges for role frontend_migration in schema public grant select,insert,update,delete on tables to frontend_runtime");
      await owner.query("alter default privileges for role frontend_migration in schema public grant usage,select on sequences to frontend_runtime");
    }
    phase = "source-fixture";
    let commit, cli = "ops/platform/frontend-migration.mjs";
    const cleanEnv = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
    if (process.env.FRONTEND_PACKAGED_MIGRATION_ROOT) {
      app = process.env.FRONTEND_PACKAGED_MIGRATION_ROOT; assert.ok(app.startsWith("/"));
      const packaged = verifyPackagedFrontendSource(app); commit = packaged.commit;
      for (const [file, expected] of Object.entries(packaged.files)) {
        const original = ["package.json", "package-lock.json"].includes(file) ? join(source, "ops/platform/frontend-migration-deps", file) : join(source, file);
        assert.equal(hash(readFileSync(original)), expected, "Packaged CLI differs from the source under test");
      }
      cli = "ops/platform/frontend-image.mjs";
    } else {
      mkdirSync(app); mkdirSync(join(app, "ops/platform"), { recursive: true }); mkdirSync(join(app, "src/lib/private-db"), { recursive: true });
      mkdirSync(join(app, "contracts/api-integration/v1"), { recursive: true });
      for (const name of ["frontend-migration.mjs", "frontend-schema.mjs", "source-checkout.mjs", "source-policy.mjs", "release-inputs.mjs", "release.mjs"])
        copyFileSync(join(source, "ops/platform", name), join(app, "ops/platform", name));
      copyFileSync(join(source, "src/lib/private-db/migration-lineage.ts"), join(app, "src/lib/private-db/migration-lineage.ts"));
      copyFileSync(join(source, "contracts/api-integration/v1/manifest.json"), join(app, "contracts/api-integration/v1/manifest.json"));
      cpSync(join(source, "drizzle"), join(app, "drizzle"), { recursive: true });
      symlinkSync(join(source, "node_modules"), join(app, "node_modules"), "dir");
      writeFileSync(join(app, "package.json"), '{"type":"module","private":true}\n'); writeFileSync(join(app, ".gitignore"), "node_modules/\n");
      Object.assign(cleanEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      const git = (...args) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Owned Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: app, env: cleanEnv });
      git("init", "--quiet"); git("add", "."); git("commit", "--quiet", "-m", "Owned migration fixture"); commit = git("rev-parse", "HEAD").trim();

    }
    const artifact = frontendMigrationArtifact(app);
    const applyPrefix = async (client, migrations) => {
      await client.query("create schema drizzle"); await client.query("create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)");
      for (const migration of migrations) {
        await client.query("begin");
        try { for (const statement of migration.sql) await client.query(statement); await client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)", [migration.hash,migration.folderMillis]); await client.query("commit"); }
        catch (error) { await client.query("rollback"); throw error; }
      }
    };
    phase = "reference-schema";
    const baselineClient = await connect("frontend_baseline", "frontend_migration"); await applyPrefix(baselineClient, artifact.migrations);
    await baselineClient.query("begin read only");
    const baseline = { version: 1, serverMajor: major, sqlArtifactSha256: artifact.sqlArtifactSha256, catalog: await readMigrationCatalog(baselineClient) };
    await baselineClient.query("rollback"); const schemaFile = join(directory, "schema.json"); writeFileSync(schemaFile, JSON.stringify(baseline), { mode: 0o600 });
    const candidate = { version: 2, environment: "staging", releaseId: "frontend-owned", integration: { state: "passed" },
      artifacts: { frontendMigration: { image: `ghcr.io/princessdardan/lash-her-platform-frontend-migration@${process.env.FRONTEND_MIGRATION_IMAGE_DIGEST ?? `sha256:${"b".repeat(64)}`}` } },
      sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" }, contractManifestSha256: artifact.contractManifestSha256,
      sources: { frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit, requiredChecks: "passed" } } };
    const job = { version: 1, operator: "Dardan", releaseId: candidate.releaseId, environment: "staging", sourceCommit: commit,
      migrationImageDigest: candidate.artifacts.frontendMigration.image.split("@")[1],
      contractManifestSha256: artifact.contractManifestSha256, sqlArtifactSha256: artifact.sqlArtifactSha256, schemaBaselineSha256: hash(JSON.stringify(baseline)), recoveryRef: "owned/recreation",
      target: { host: "127.0.0.1", port, database: "frontend_apply", user: "frontend_migration", runtimeRole: "frontend_runtime", serverMajor: major,
        allowEmptyBootstrap: true, approvedPendingTags: artifact.migrations.map(({ tag }) => tag) } };
    candidate.frontendMigration = { sourceCommit: commit, sqlArtifactSha256: artifact.sqlArtifactSha256,
      contractManifestSha256: artifact.contractManifestSha256, schemaBaselines: { [major]: job.schemaBaselineSha256 } };
    const invoke = (label, selected = job, selectedCandidate = candidate, options = {}) => {
      const jobFile = join(directory, `${label}.job.json`), candidateFile = join(directory, `${label}.candidate.json`), output = join(directory, label); mkdirSync(output, { mode: 0o700 });
      writeFileSync(jobFile, JSON.stringify(selected)); writeFileSync(candidateFile, JSON.stringify(selectedCandidate));
      const named = selected.environment === "staging" ? "FRONTEND_STAGING_MIGRATION_DATABASE_URL" : "FRONTEND_PROD_MIGRATION_DATABASE_URL";
      const env = { ...cleanEnv, NODE_EXTRA_CA_CERTS: certificate, [named]: `postgresql://${selected.target.user}:${password}@127.0.0.1:${port}/${selected.target.database}?sslmode=verify-full`, ...options.env };
      const result = spawnSync(process.execPath, [cli, "--execute", candidateFile, jobFile, schemaFile,
        "--confirm", `${selected.environment}/${selected.releaseId}`, output], { cwd: app, env, encoding: "utf8", timeout: 300_000 });
      return { result, output };
    };
    const success = (name, call) => { assert.equal(call.result.status, 0, `${name} failed`); const receipt = JSON.parse(readFileSync(join(call.output,"database-receipt.json"),"utf8")); assert.equal(receipt.status,"DATABASE_VERIFIED"); assert.equal(JSON.parse(readFileSync(join(call.output,"job-outcome.json"),"utf8")).status,"DATABASE_VERIFIED"); records.push(name); return receipt; };
    phase = "fresh-cli"; const fresh = invoke("fresh"); const receipt = success("fresh-apply", fresh);
    phase = "noop-cli"; const current = structuredClone(job); current.target.approvedPendingTags = []; current.target.allowEmptyBootstrap = false; success("already-current", invoke("noop", current));
    phase = "data-bearing-upgrade";
    const upgrade = await connect("frontend_upgrade", "frontend_migration"), cutoff = artifact.migrations.findIndex(({ tag }) => tag.startsWith("0033_")); assert.ok(cutoff > 0);
    await applyPrefix(upgrade, artifact.migrations.slice(0, cutoff + 1));
    await upgrade.query("insert into marketing_contacts(email,email_normalized,name,source,first_consented_at,last_consented_at) values('owned@example.invalid','owned@example.invalid','Owned upgrade fixture','owned-test',now(),now())");
    const next = structuredClone(job); next.target.database = "frontend_upgrade"; next.target.allowEmptyBootstrap = false; next.target.approvedPendingTags = artifact.migrations.slice(cutoff + 1).map(({ tag }) => tag);
    success("data-bearing-upgrade", invoke("upgrade", next));
    assert.equal((await upgrade.query("select name from marketing_contacts where email_normalized='owned@example.invalid'")).rows[0].name,"Owned upgrade fixture");
    phase = "negative-cli";
    await upgrade.query("select pg_advisory_lock(hashtext($1))",[FRONTEND_MIGRATION_LOCK]);
    const locked = structuredClone(next); locked.target.approvedPendingTags = [];
    assert.notEqual(invoke("contended",locked).result.status,0); await upgrade.query("select pg_advisory_unlock(hashtext($1))",[FRONTEND_MIGRATION_LOCK]); records.push("lock-contention");
    const mismatch = structuredClone(current); mismatch.target.approvedPendingTags = [artifact.migrations.at(-1).tag]; assert.notEqual(invoke("pending-mismatch",mismatch).result.status,0); records.push("pending-chain-refusal");
    const owner = await connect("frontend_apply"); await owner.query("update drizzle.__drizzle_migrations set hash='changed' where created_at=(select max(created_at) from drizzle.__drizzle_migrations)");
    assert.notEqual(invoke("journal-drift",current).result.status,0); await owner.query("update drizzle.__drizzle_migrations set hash=$1 where created_at=$2",[artifact.migrations.at(-1).hash,artifact.migrations.at(-1).folderMillis]); records.push("lineage-refusal");
    await owner.query("create table owned_schema_drift(id int)"); assert.notEqual(invoke("schema-drift",current).result.status,0); await owner.query("drop table owned_schema_drift"); records.push("schema-refusal");
    await owner.query("grant create on schema public to frontend_runtime"); assert.notEqual(invoke("runtime-ddl",current).result.status,0); await owner.query("revoke create on schema public from frontend_runtime");
    await owner.query("grant create on database frontend_apply to frontend_runtime"); assert.notEqual(invoke("runtime-database-ddl",current).result.status,0); await owner.query("revoke create on database frontend_apply from frontend_runtime");
    await owner.query("alter table marketing_contacts owner to frontend_runtime"); assert.notEqual(invoke("runtime-owner",current).result.status,0);
    await owner.query("alter table marketing_contacts owner to frontend_migration"); await owner.query("grant select,insert,update,delete on marketing_contacts to frontend_runtime"); records.push("runtime-privilege-refusal");
    assert.notEqual(invoke("wrong-ca",current,candidate,{env:{NODE_EXTRA_CA_CERTS:""}}).result.status,0); records.push("tls-certificate-refusal");
    phase = "production-promotion";
    const production = structuredClone(job); production.environment="production"; production.target.database="frontend_promote";
    production.stagingVerification={database:receipt,terminal:JSON.parse(readFileSync(join(fresh.output,"job-outcome.json"),"utf8"))};
    success("exact-artifact-production-promotion",invoke("promotion",production,{...candidate,environment:"production"}));
    const result={status:"FRONTEND_MIGRATION_OWNED_POSTGRES_PASS",postgresMajor:major,migrations:artifact.migrations.length,checks:records,providerTouched:false,
      sourceCommit:commit,migrationImageDigest:job.migrationImageDigest,packagedCliVerified:cli.endsWith("frontend-image.mjs"),
      sqlArtifactSha256:artifact.sqlArtifactSha256,contractManifestSha256:artifact.contractManifestSha256,schemaBaselineSha256:hash(JSON.stringify(baseline))};
    if(process.env.FRONTEND_MIGRATION_EXPORT_SCHEMA==="true")result.schemaBaseline=baseline;
    console.log(JSON.stringify(result));
  } finally {
    for (const client of connections) { try { await client.end(); } catch { /* owned cluster only */ } }
    if(running)run(join(binaries,"pg_ctl"),["-D",data,"-m","immediate","-w","stop"]);
    rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(()=>{console.error(JSON.stringify({status:"OWNED_FRONTEND_MIGRATION_FAILED",phase,providerTouched:false}));process.exitCode=1;});

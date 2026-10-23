/** One-shot staging job. No dotenv loading and no production target. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client } from "pg";
import { assertAppliedMigrationLineage, buildExpectedPrivateDbMigrationLineage } from "../../src/lib/private-db/migration-lineage";

const lockName = "lash-her:private-db:migrations";
const expectedHost = "ep-plain-field-b7yma047.c-13.us-east-1.aws.neon.tech";
const runtimeRole = "lash_her_frontend_staging_runtime";

export function assertReleaseContext(env: Record<string, string | undefined>, revision: string): void {
  assert.equal(process.versions.node.split(".")[0], "24", "Node 24 is required");
  assert.equal(env.GITHUB_ACTIONS, "true", "Protected GitHub job required");
  assert.equal(env.GITHUB_REPOSITORY, "princessdardan/lash-her-frontend");
  assert(["refs/heads/staging", "refs/heads/codex/p1-02-staging-release"].includes(env.GITHUB_REF ?? ""), "Reviewed release branch required");
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, revision, "Checkout must match the job revision");
  assert.equal(env.STAGING_MIGRATION_EXPECTED_COMMIT, revision, "Protected environment must approve the exact revision");
  assert.match(env.STAGING_MIGRATION_RECOVERY_REFERENCE ?? "", /^https:\/\/[^\s?]+$/, "Protected recovery evidence URL required");
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    assert.equal(existsSync(file), false, "Migration checkout must contain no environment files");
  }
}

export function assertStagingTarget(value: string | undefined): URL {
  // Never include URL values in assertions or exceptions.
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("Invalid staging database connection"); }
  if (!(["postgres:", "postgresql:"].includes(url.protocol) &&
    url.hostname === expectedHost && (!url.port || url.port === "5432") &&
    url.pathname === "/neondb" && decodeURIComponent(url.username) === "neondb_owner" &&
    url.password && url.searchParams.get("sslmode") === "verify-full" &&
    [...url.searchParams.keys()].every(key => ["sslmode", "channel_binding"].includes(key)))) {
    throw new Error("Connection must select the reviewed direct staging owner with certificate verification");
  }
  return url;
}

async function main() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assertReleaseContext(process.env, revision);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "", "Migration source must be committed and clean");
  const url = assertStagingTarget(process.env.STAGING_MIGRATION_DATABASE_URL);
  delete process.env.STAGING_MIGRATION_DATABASE_URL;
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" }).map((migration, index) => {
    const entry = journal.entries[index];
    assert(entry && entry.when === migration.folderMillis, "Journal order mismatch");
    return { ...migration, tag: entry.tag };
  });
  assert.equal(migrations.length, journal.entries.length);
  const expected = buildExpectedPrivateDbMigrationLineage(migrations);
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 15000, statement_timeout: 120000, lock_timeout: 15000, application_name: "lash-her-protected-staging-migration" });
  let locked = false;
  try {
    await client.connect();
    const stream = (client as unknown as { connection: { stream: { encrypted: boolean; authorized: boolean } } }).connection.stream;
    assert(stream.encrypted && stream.authorized, "Verified TLS required");
    const identity = (await client.query("select current_user, current_database() as database, current_setting('server_version') as version")).rows[0];
    assert.equal(identity.current_user, "neondb_owner"); assert.equal(identity.database, "neondb");
    assert.match(identity.version, /^18\./, "Rehearsed PostgreSQL major required");
    locked = (await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [lockName])).rows[0].locked;
    assert(locked, "Another migration holds the database release lock");
    const present = (await client.query("select to_regclass('drizzle.__drizzle_migrations') is not null as present")).rows[0].present;
    const readJournal = async () => (await client.query("select hash, created_at from drizzle.__drizzle_migrations order by created_at asc nulls first, id asc")).rows;
    const before = present ? await readJournal() : [];
    if (!present) {
      const tables = (await client.query("select count(*)::int as count from pg_tables where schemaname='public'")).rows[0].count;
      assert.equal(tables, 0, "Unjournaled application data blocks initial migration");
    }
    const latest = assertAppliedMigrationLineage(expected, before);
    const pending = migrations.filter(migration => migration.folderMillis > latest);
    await client.query("create schema if not exists drizzle");
    await client.query("create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)");
    for (const migration of pending) {
      await client.query("begin");
      try {
        for (const statement of migration.sql) await client.query(statement);
        await client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values ($1,$2)", [migration.hash, migration.folderMillis]);
        await client.query("commit");
      } catch { await client.query("rollback"); throw new Error(`Staging migration failed: ${migration.tag}; inspect state before retry`); }
    }
    const after = await readJournal();
    assert.equal(assertAppliedMigrationLineage(expected, after), migrations.at(-1)?.folderMillis);
    const runtime = (await client.query("select rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname=$1", [runtimeRole])).rows[0];
    assert(runtime && !runtime.rolsuper && !runtime.rolcreatedb && !runtime.rolcreaterole && !runtime.rolreplication && !runtime.rolbypassrls, "Restricted runtime role required");
    assert.equal((await client.query("select has_schema_privilege($1,'public','CREATE') as allowed", [runtimeRole])).rows[0].allowed, false);
    const inaccessible = (await client.query("select tablename from pg_tables where schemaname='public' and not (has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'SELECT') and has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'INSERT') and has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'UPDATE') and has_table_privilege($1, quote_ident(schemaname)||'.'||quote_ident(tablename), 'DELETE'))", [runtimeRole])).rows;
    assert.equal(inaccessible.length, 0, "Runtime grants must cover every migrated table");
    const receipt = { schemaVersion: 1, status: "verified", repository: process.env.GITHUB_REPOSITORY, commit: revision, runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, host: expectedHost, database: "neondb", serverVersion: identity.version, recoveryReference: process.env.STAGING_MIGRATION_RECOVERY_REFERENCE, tlsVerified: true, advisoryLock: lockName, before, applied: pending.map(({ tag, hash, folderMillis }) => ({ tag, hash, created_at: folderMillis })), after, runtimeRoleVerified: true, completedAt: new Date().toISOString() };
    writeFileSync(path.resolve("staging-migration-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ status: receipt.status, commit: revision, applied: pending.length, verified: after.length, valuesLogged: false }));
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
    await client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Protected staging migration failed; connection and error details withheld. Inspect the job stage and database state before any retry."); process.exitCode = 1; });
}

// Disposable recovery fixture only; never an application startup/migration path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Pool } from "/app/node_modules/pg/esm/index.mjs";
import { drizzle } from "/app/node_modules/drizzle-orm/node-postgres/index.js";
import { migrate } from "/app/node_modules/drizzle-orm/node-postgres/migrator.js";

assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.OWNED_RECOVERY_FIXTURE, "1");
const url = new URL(process.env.TEST_DATABASE_URL);
assert.equal(url.hostname, "postgres");
assert.match(url.pathname, /^\/lash_her_(course|community)_p1_test$/u);
assert.match(url.password, /^[a-f0-9]{64}$/u);
assert.equal(url.search, "?sslmode=disable");
const pool = new Pool({ connectionString: url.toString(), max: 1 });
try {
  const before = await pool.query("SELECT current_database() AS name, (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables");
  assert.equal(before.rows[0].name, url.pathname.slice(1)); assert.equal(before.rows[0].tables, 0);
  const journal = JSON.parse(readFileSync("/app/drizzle/meta/_journal.json", "utf8"));
  const migrations = journal.entries.map((entry) => ({ tag: entry.tag,
    sha256: createHash("sha256").update(readFileSync(`/app/drizzle/${entry.tag}.sql`)).digest("hex") }));
  await migrate(drizzle(pool), { migrationsFolder: "/app/drizzle" });
  const applied = (await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0].count;
  assert.equal(applied, migrations.length);
  process.stdout.write(JSON.stringify({ status: "OWNED_PUBLISHED_SQL_APPLIED_ONCE", database: before.rows[0].name, applied, migrations }) + "\n");
} finally { await pool.end(); }

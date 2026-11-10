import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { FRONTEND_PREPARATION_ROLES } from "./frontend-role-preparation.mjs";
import { readManagedNeonCatalog, replacementCatalogCountsSql, selectManagedNeonCatalog,
  selectManagedNeonCatalogForTarget, verifyManagedNeonCatalog } from "./frontend-managed-neon-catalog.mjs";

const rawBaseline = readFileSync(new URL("./managed-neon-replacement-catalog.json", import.meta.url));
const baseline = JSON.parse(rawBaseline);
const reference = { id: baseline.id, sha256: createHash("sha256").update(rawBaseline).digest("hex") };
const refusal = { message: "FRONTEND_MANAGED_NEON_CATALOG_REFUSED" };
const { provider, target, databaseOid, migrationRoleOid, administrativeLogins } = baseline;
const context = { provider, target, databaseOid, migrationRoleOid, administrativeLogins };

test("managed Neon catalog requires the exact committed reference and replacement identity", () => {
  const selected = selectManagedNeonCatalog(reference, context);
  assert.deepEqual(selectManagedNeonCatalogForTarget(context), selected);
  assert.deepEqual(selected.reference, reference);
  assert.deepEqual(Object.fromEntries(Object.entries(selected.expectedCatalogCounts).filter(([, count]) => count)),
    { pg_default_acl: 2, normal_object_dependencies: 2, local_shared_dependencies: 2 });
  assert.deepEqual(selected.databaseAclBefore, baseline.databaseAclBefore);
  assert.deepEqual(selected.databaseAclAfter, baseline.databaseAclAfter);
  assert.ok(Object.isFrozen(selected.roles[0]) && Object.isFrozen(selected.databaseAclAfter[0]) &&
    Object.isFrozen(selected.expectedCatalogCounts));
  for (const wrong of [{ ...reference, id: "another" }, { ...reference, sha256: "0".repeat(64) }, { ...reference, path: "alternate" }]) {
    assert.throws(() => selectManagedNeonCatalog(wrong, context), refusal);
  }
  for (const wrong of [
    { provider: { ...provider, projectId: "other" } },
    { provider: { ...provider, branchId: "other" } },
    { provider: { ...provider, endpointId: "other" } },
    { provider: { ...provider, directHost: "other.example" } },
    { target: { ...target, port: 5433 } },
    { target: { ...target, serverMajor: 16 } },
    { target: { ...target, runtimeRole: "different" } },
    { databaseOid: "1" },
    { migrationRoleOid: "10" },
    { administrativeLogins: [] },
  ]) assert.throws(() => selectManagedNeonCatalog(reference, { ...context, ...wrong }), refusal);
  assert.equal(selectManagedNeonCatalogForTarget({ ...context, target: { ...target, host: "127.0.0.1" } }), undefined);
  assert.throws(() => selectManagedNeonCatalogForTarget({ ...context, databaseOid: "1" }), refusal);
});

test("managed catalog checks exact physical rows and the chosen database ACL", async () => {
  const selected = selectManagedNeonCatalog(reference, context);
  const categories = ["roles", "memberships", "defaultAcl", "dependencies", "sharedDependencies", "databaseAclAfter"];
  function fixture(last = "databaseAclAfter", edit = () => {}) {
    const expected = structuredClone(categories.map(name => selected[name === "databaseAclAfter" ? last : name]));
    edit(expected);
    return { query({ rowMode }) {
      assert.equal(rowMode, "array");
      return { rows: expected.shift() };
    } };
  }
  await verifyManagedNeonCatalog(fixture(), selected);
  await verifyManagedNeonCatalog(fixture("databaseAclBefore"), selected, { databaseAcl: "before" });
  await assert.rejects(verifyManagedNeonCatalog(fixture("databaseAclBefore"), selected), refusal);
  await assert.rejects(verifyManagedNeonCatalog(fixture(), selected, { databaseAcl: "before", extra: true }), refusal);
  for (const [index, position, wrong] of [
    [0, 3, false], [1, 5, false], [2, 4, "{}"], [2, 0, "123"], [3, 3, "pg_class"],
    [4, 4, "10"], [5, 1, "10"],
  ]) await assert.rejects(verifyManagedNeonCatalog(fixture("databaseAclAfter", groups => {
    groups[index][0][position] = wrong;
  }), selected), refusal);
});

const ownedUrl = process.env.P2_MANAGED_NEON_OWNED_URL;
test("owned PostgreSQL 18 reproduces managed ACLs and refuses equal-count role/ACL drift", {
  skip: !ownedUrl, timeout: 30_000,
}, async () => {
  const url = new URL(ownedUrl);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/managed_neon_owned");
  assert.equal(url.username, "owned_neon_admin");
  assert.ok(Number(url.port) > 1024);
  const client = new Client({ connectionString: ownedUrl, connectionTimeoutMillis: 2000, query_timeout: 3000 });
  await client.connect();
  try {
    const { rows: [initial] } = await client.query(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version_num')::int / 10000 AS major`);
    assert.deepEqual(initial, { database: "managed_neon_owned", username: "owned_neon_admin", major: 18 });
    await client.query(`CREATE ROLE owned_neon_migration LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS;
      CREATE ROLE owned_neon_service LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS;
      CREATE ROLE owned_neon_group NOLOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS;
      CREATE ROLE owned_neon_drift NOLOGIN;
      GRANT owned_neon_group TO owned_neon_migration,owned_neon_service WITH SET TRUE;
      ALTER DATABASE managed_neon_owned OWNER TO owned_neon_migration;
      GRANT ALL ON DATABASE managed_neon_owned TO owned_neon_group;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,MAINTAIN ON TABLES TO owned_neon_group WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE,UPDATE ON SEQUENCES TO owned_neon_group WITH GRANT OPTION`);
    const { rows: [{ oid: db }] } = await client.query("SELECT oid::text FROM pg_database WHERE datname=current_database()");
    const { rows } = await client.query(`SELECT rolname AS name,oid::text FROM pg_roles WHERE rolname=ANY($1::name[]) ORDER BY rolname`,
      [["owned_neon_admin", "owned_neon_migration", "owned_neon_service", "owned_neon_group"]]);
    const identity = { databaseOid: db, migrationRoleOid: rows.find(row => row.name === "owned_neon_migration").oid,
      roles: rows.map(row => [row.name, row.oid]) };
    const before = await readManagedNeonCatalog(client, identity);
    await client.query("REVOKE CONNECT,TEMP ON DATABASE managed_neon_owned FROM PUBLIC");
    const { databaseAcl, ...observed } = await readManagedNeonCatalog(client, identity);
    const owned = { ...identity, ...observed, databaseAclAfter: databaseAcl, databaseAclBefore: before.databaseAcl };
    assert.deepEqual(owned.defaultAcl.map(row => row.slice(1)), [
      [rows[0].oid, "2200", "r", "{owned_neon_group=a*r*w*d*D*m*/owned_neon_admin}"],
      [rows[0].oid, "2200", "S", "{owned_neon_group=r*w*U*/owned_neon_admin}"],
    ]);
    assert.deepEqual(owned.dependencies.map(row => row.slice(1)), [
      ["pg_default_acl", 0, "pg_namespace", "2200", 0, "a"],
      ["pg_default_acl", 0, "pg_namespace", "2200", 0, "a"],
    ]);
    assert.deepEqual(owned.sharedDependencies.map(row => row.slice(1)), [
      ["pg_default_acl", 0, "pg_authid", rows[1].oid, "a"],
      ["pg_default_acl", 0, "pg_authid", rows[1].oid, "a"],
    ]);
    const compare = async options => {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try { await verifyManagedNeonCatalog(client, owned, options); }
      finally { await client.query("ROLLBACK"); }
    };
    const { rows: [counts] } = await client.query(replacementCatalogCountsSql, [db, rows.map(row => row.oid)]);
    assert.deepEqual(counts, selectManagedNeonCatalog(reference, context).expectedCatalogCounts);
    await compare();
    for (const [inject, undo] of [
      ["ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT REFERENCES ON TABLES TO owned_neon_group",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE REFERENCES ON TABLES FROM owned_neon_group"],
      ["GRANT owned_neon_group TO owned_neon_drift WITH SET FALSE", "REVOKE owned_neon_group FROM owned_neon_drift"],
      ["GRANT CREATE ON DATABASE managed_neon_owned TO owned_neon_drift", "REVOKE CREATE ON DATABASE managed_neon_owned FROM owned_neon_drift"],
      ["ALTER ROLE owned_neon_group NOBYPASSRLS", "ALTER ROLE owned_neon_group BYPASSRLS"],
    ]) {
      await client.query(inject);
      await assert.rejects(compare(), refusal);
      await client.query(undo);
      await compare();
    }

    const { owner: ownerName, runtime: runtimeName } = FRONTEND_PREPARATION_ROLES;
    await client.query(`SET ROLE owned_neon_migration;
      CREATE ROLE ${ownerName} NOLOGIN;
      CREATE ROLE ${runtimeName} LOGIN;
      GRANT CREATE ON DATABASE managed_neon_owned TO ${ownerName};
      GRANT CONNECT ON DATABASE managed_neon_owned TO ${runtimeName};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${runtimeName};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${runtimeName};
      RESET ROLE`);
    const { rows: prepared } = await client.query("SELECT rolname AS name,oid::text FROM pg_roles WHERE rolname=ANY($1::name[])",
      [[ownerName, runtimeName]]);
    const preparedRoles = { owner: prepared.find(row => row.name === ownerName), runtime: prepared.find(row => row.name === runtimeName) };
    await assert.rejects(compare(), refusal);
    await compare({ preparedRoles });
    await client.query("SET ROLE owned_neon_migration; ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC; RESET ROLE");
    await assert.rejects(compare({ preparedRoles }), refusal);
    await client.query("SET ROLE owned_neon_migration; ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC; RESET ROLE");
    await compare({ preparedRoles });
    await client.query(`SET ROLE owned_neon_migration; GRANT TEMP ON DATABASE managed_neon_owned TO ${runtimeName}; RESET ROLE`);
    await assert.rejects(compare({ preparedRoles }), refusal);
  } finally {
    await client.end();
  }
});

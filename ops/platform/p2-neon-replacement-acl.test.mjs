import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { selectManagedNeonCatalog } from "./frontend-managed-neon-catalog.mjs";
import { applyP2ManagedNeonReplacementAcl, P2_MANAGED_NEON_REPLACEMENT_ACL_ACTION,
  P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG, P2_MANAGED_NEON_REPLACEMENT_ACL_SQL,
  prepareP2ManagedNeonReplacementAcl } from "./p2-neon-replacement-acl.mjs";

const sourceCommit = "a".repeat(40);
const ownedDirectories = [];
test.after(() => { for (const path of ownedDirectories) rmSync(path, { recursive: true, force: true }); });
const provider = {
  kind: "neon", projectId: "noisy-river-83285109", branchId: "br-holy-art-bc3aif1l",
  endpointId: "ep-lingering-meadow-bc80gyj9",
  directHost: "ep-lingering-meadow-bc80gyj9.c-16.us-east-1.aws.neon.tech",
};
const target = {
  host: provider.directHost, port: 5432, database: "neondb", user: "neondb_owner",
  runtimeRole: "lash_her_frontend_staging_runtime_p2", serverMajor: 18,
};
const predecessorTarget = {
  host: "ep-reviewed-predecessor.us-east-1.aws.neon.tech", port: 5432, database: "neondb",
  user: "predecessor_owner", runtimeRole: "lash_her_frontend_staging_runtime", serverMajor: 16,
};
const administrativeLogins = [{ name: "cloud_admin", oid: "10" }, { name: "neon_service", oid: "16395" }];
const input = () => ({ version: 1, operation: "apply-managed-neon-replacement-public-acl", environment: "staging",
  actionId: P2_MANAGED_NEON_REPLACEMENT_ACL_ACTION, sourceCommit,
  managedCatalog: { ...P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG }, provider: { ...provider }, target: { ...target },
  predecessorTarget: { ...predecessorTarget }, databaseOid: "16397", migrationRoleOid: "16393",
  administrativeLogins: administrativeLogins.map(value => ({ ...value })) });

function harness(changes = {}) {
  const reviewed = input();
  const results = mkdtempSync(join(realpathSync(tmpdir()), "owned-neon-acl-"));
  ownedDirectories.push(results);
  const readReceipt = name => JSON.parse(readFileSync(join(results, name), "utf8"));
  const selection = selectManagedNeonCatalog(reviewed.managedCatalog, { provider: reviewed.provider, target: reviewed.target,
    databaseOid: reviewed.databaseOid, migrationRoleOid: reviewed.migrationRoleOid,
    administrativeLogins: reviewed.administrativeLogins });
  const queries = [], catalogChecks = [], boundaryCalls = [], sourceChecks = [];
  let identityReads = 0;
  const client = new Client({ host: target.host, port: target.port, database: target.database, user: target.user,
    password: "owned-private-password", ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  client.connection.stream = { encrypted: true, authorized: true, destroy() {} };
  client.connect = async () => {};
  client.end = async () => {};
  client.query = async (query, values) => {
    const text = typeof query === "string" ? query : query.text;
    queries.push({ text, values });
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ held: changes.lockHeld !== false }] };
    if (text.includes("current_user AS username")) {
      identityReads++;
      return { rows: [{ pid: changes.identityDrift && identityReads > 1 ? 778 : 777,
      backend_start: "2026-11-09T12:00:00.000000Z", username: target.user, session_username: target.user,
      database: target.database, database_oid: reviewed.databaseOid, role_oid: reviewed.migrationRoleOid,
      owns_database: true, major: 18, read_only: "off", migration_lock: true }] };
    }
    if (text.startsWith("BEGIN")) return { command: "BEGIN", rows: [] };
    if (text === "ROLLBACK") return { command: "ROLLBACK", rows: [] };
    if (text.includes("public_connect")) return { rows: [{ public_connect: text.includes("previous_or_fixed_role"),
      public_temp: text.includes("previous_or_fixed_role"), public_create: false,
      public_schema_create: false, previous_or_fixed_role: false, other_client: false }] };
    if (text.includes("rolcanlogin AND")) return { rows: [...administrativeLogins, { name: target.user, oid: reviewed.migrationRoleOid }] };
    if (text.includes("AS pg_am")) return { rows: [{ ...selection.expectedCatalogCounts }] };
    if (text === P2_MANAGED_NEON_REPLACEMENT_ACL_SQL) {
      assert.equal(readReceipt("acl-intent.json").status, "P2_MANAGED_NEON_REPLACEMENT_ACL_INTENT");
      if (changes.revokeLost) { client.emit("error", new Error("connection lost")); throw new Error("ambiguous fixture"); }
      if (changes.revokeError) throw new Error("ambiguous fixture");
      return { command: changes.revokeCommand ?? "REVOKE", rows: [] };
    }
    if (text === "COMMIT") {
      if (changes.commitLost) { client.emit("error", new Error("commit lost")); throw new Error("commit uncertain"); }
      if (changes.commitError) throw new Error("commit uncertain");
      return { command: changes.commitCommand ?? "COMMIT", rows: [] };
    }
    if (text.includes("pg_advisory_unlock")) {
      if (changes.unlockError) throw new Error("unlock uncertain");
      return { rows: [{ released: true }] };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const dependencies = {
    results,
    getUrl: async () => `postgresql://${target.user}:owned-private-password@${target.host}:${target.port}/${target.database}?sslmode=verify-full`,
    assertSource: commit => { sourceChecks.push(commit); if (changes.sourceError) throw new Error("source"); },
    withEnvironmentLock: async task => task(async () => { if (changes.environmentError) throw new Error("environment"); },
      new AbortController().signal),
    createClient: options => {
      assert.equal(options.host, target.host); assert.equal(options.user, target.user);
      assert.deepEqual(options.ssl, { rejectUnauthorized: true }); assert.equal(options.application_name,
        "lash-her-p2-managed-neon-replacement-acl"); return client;
    },
    verifyCatalog: async (actualClient, actualSelection, options) => {
      assert.equal(actualClient, client); assert.equal(actualSelection.databaseOid, reviewed.databaseOid);
      catalogChecks.push(options);
      if (changes.catalogError || changes.catalogChangedBeforeWrite && catalogChecks.length === 2 ||
        changes.postCatalogError && options.databaseAcl === "after") throw new Error("catalog");
    },
    verifyBoundary: async (actualClient, options) => {
      assert.equal(actualClient, client); boundaryCalls.push(options);
      await options.verifyEnvironment(); await options.verifySession();
      if (changes.boundaryError) throw new Error("post-boundary");
      return { version: 1, status: "FRONTEND_REPLACEMENT_BOUNDARY_VERIFIED",
        catalogScope: "postgresql-18-managed-neon-replacement-v1", databaseOid: reviewed.databaseOid,
        migrationRoleOid: reviewed.migrationRoleOid, managedCatalog: reviewed.managedCatalog,
        authorityIssued: false, observedAt: "2026-11-09T12:00:00.000Z" };
    },
  };
  return { reviewed, selection, queries, catalogChecks, boundaryCalls, sourceChecks, dependencies, readReceipt };
}

test("plan pins the one reviewed catalog, target, statement and owner confirmation without authority", () => {
  const plan = prepareP2ManagedNeonReplacementAcl(input());
  assert.equal(plan.status, "P2_MANAGED_NEON_REPLACEMENT_ACL_PREPARED");
  assert.deepEqual(plan.managedCatalog, P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG);
  assert.equal(plan.target.host, provider.directHost);
  assert.equal(plan.target.database, "neondb");
  assert.equal(plan.target.user, "neondb_owner");
  assert.equal(plan.statement, "REVOKE CONNECT, TEMPORARY ON DATABASE neondb FROM PUBLIC");
  assert.equal(plan.ownerConfirmation,
    `staging/${P2_MANAGED_NEON_REPLACEMENT_ACL_ACTION}/${sourceCommit}/${P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG.sha256}`);
  assert.equal(plan.applicationSqlAuthorized, false);
  assert.equal(plan.rolePreparationAuthorized, false);
  assert.equal(plan.releaseAuthorized, false);
  assert.equal(plan.automaticRetryAllowed, false);
});

test("plan refuses extra input, catalog drift and any target other than exact direct neondb_owner", () => {
  const variants = [value => { value.extra = true; }, value => { value.managedCatalog.sha256 = "b".repeat(64); },
    value => { value.target.host = value.target.host.replace("ep-lingering", "ep-other"); },
    value => { value.target.user = "other_owner"; }, value => { value.target.database = "other"; },
    value => { value.provider.directHost += ".invalid"; }, value => { value.actionId += "-other"; },
    value => { value.predecessorTarget.host = value.target.host; value.predecessorTarget.port = value.target.port;
      value.predecessorTarget.database = value.target.database; },
    value => { value.predecessorTarget.runtimeRole = "cloud_admin"; }];
  for (const mutate of variants) {
    const value = input(); mutate(value);
    assert.throws(() => prepareP2ManagedNeonReplacementAcl(value), { message: "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED" });
  }
});

test("apply holds the migration lock, verifies the exact before state, mutates once and verifies the full post boundary", async () => {
  const fixture = harness(), plan = prepareP2ManagedNeonReplacementAcl(fixture.reviewed);
  const result = await applyP2ManagedNeonReplacementAcl(fixture.reviewed, plan.ownerConfirmation, fixture.dependencies);
  assert.equal(result.status, "P2_MANAGED_NEON_REPLACEMENT_ACL_APPLIED");
  assert.deepEqual(fixture.sourceChecks, [sourceCommit]);
  assert.deepEqual(fixture.catalogChecks, [{ databaseAcl: "before" }, { databaseAcl: "before" }, { databaseAcl: "after" }]);
  assert.equal(fixture.boundaryCalls.length, 1);
  assert.deepEqual(fixture.boundaryCalls[0].managedCatalog, P2_MANAGED_NEON_REPLACEMENT_ACL_CATALOG);
  assert.equal(fixture.queries.filter(({ text }) => text === P2_MANAGED_NEON_REPLACEMENT_ACL_SQL).length, 1);
  assert.equal(fixture.queries.filter(({ text }) => text === "BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE").length, 1);
  assert.equal(fixture.queries.filter(({ text }) => text === "COMMIT").length, 1);
  assert.equal(fixture.queries.filter(({ text }) => text.includes("pg_try_advisory_lock")).length, 1);
  assert.equal(fixture.queries.filter(({ text }) => text.includes("pg_advisory_unlock")).length, 1);
  assert.equal(result.publicConnectRevoked, true);
  assert.equal(result.publicTemporaryRevoked, true);
  assert.equal(result.rolesAndGrantsUnchanged, true);
  assert.equal(result.backendPid, 777);
  assert.equal(result.backendStart, "2026-11-09T12:00:00.000000Z");
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(JSON.stringify(result).includes("owned-private-password"), false);
  assert.deepEqual(fixture.readReceipt("acl-outcome.json"), result);
  fixture.dependencies.getUrl = () => assert.fail("used results directory reached the credential");
  await assert.rejects(applyP2ManagedNeonReplacementAcl(fixture.reviewed, plan.ownerConfirmation, fixture.dependencies),
    { message: "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED" });
});

test("apply requires the exact owner confirmation before resolving credentials", async () => {
  const fixture = harness(); let resolved = 0;
  fixture.dependencies.getUrl = async () => { resolved++; return "not-used"; };
  await assert.rejects(applyP2ManagedNeonReplacementAcl(fixture.reviewed, "staging/wrong", fixture.dependencies),
    { message: "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED" });
  assert.equal(resolved, 0);
  assert.equal(fixture.queries.length, 0);
});

test("precondition failures execute no ACL statement", async () => {
  for (const changes of [{ lockHeld: false }, { catalogError: true }, { catalogChangedBeforeWrite: true }, { environmentError: true }, { sourceError: true },
    { identityDrift: true }]) {
    const fixture = harness(changes), plan = prepareP2ManagedNeonReplacementAcl(fixture.reviewed);
    await assert.rejects(applyP2ManagedNeonReplacementAcl(fixture.reviewed, plan.ownerConfirmation, fixture.dependencies),
      { message: "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED" });
    assert.equal(fixture.queries.filter(({ text }) => text === P2_MANAGED_NEON_REPLACEMENT_ACL_SQL).length, 0);
  }
});

test("ambiguous mutation, commit, cleanup and failed post-verification never replay the fixed statement", async () => {
  for (const changes of [{ revokeError: true }, { revokeLost: true }, { postCatalogError: true }, { commitError: true },
    { commitLost: true }, { commitCommand: "UPDATE" }, { boundaryError: true }, { unlockError: true },
    { revokeCommand: "UPDATE" }]) {
    const fixture = harness(changes), plan = prepareP2ManagedNeonReplacementAcl(fixture.reviewed);
    await assert.rejects(applyP2ManagedNeonReplacementAcl(fixture.reviewed, plan.ownerConfirmation, fixture.dependencies),
      { message: "P2_MANAGED_NEON_REPLACEMENT_ACL_REFUSED" });
    assert.equal(fixture.queries.filter(({ text }) => text === P2_MANAGED_NEON_REPLACEMENT_ACL_SQL).length, 1);
    assert.equal(fixture.readReceipt("acl-outcome.json").status, "P2_MANAGED_NEON_REPLACEMENT_ACL_FAILED_REVIEW_REQUIRED");
  }
});

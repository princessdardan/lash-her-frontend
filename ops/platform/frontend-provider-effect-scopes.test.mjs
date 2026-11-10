import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frontendScopedProviderQueryPlan, normalizeFrontendScopedProviderSnapshot, observeFrontendScopedProviderDatabase } from "./frontend-provider-effect-scopes.mjs";

const source = `def database_queries(reviewed):
 return [('ownedRows','SELECT id,private_payload FROM owned_scope WHERE tenant=$1 ORDER BY id LIMIT 4097',[reviewed['tenant']])]
def normalize_snapshot(rows):
 if set(rows) != {'ownedRows'}: raise ValueError('FIXED_ROWS_REQUIRED')
 return {'ownedRows':[{'id':row['id'],'privatePayloadPresent':bool(row['private_payload'])} for row in rows['ownedRows']]}
`;
async function fixture(task) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-scoped-query-plan-")));
  try {
    const file = join(directory, "frontend_resend_marketing_scope.py");
    writeFileSync(file, source);
    await task({ hostDirectory: directory }, file);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("actual source-owned Resend and Chit Chats query plans remain fixed and bounded without duplicated JavaScript SQL", () => {
  const ids = Object.fromEntries(["booking", "course_signup", "contact_popup", "general_inquiry", "sanity_backfill", "training_contact"].map(key => [key, []]));
  const resend = { resendMarketing: { environment: "staging", databaseSnapshotSha256: "a".repeat(64), sourceInventorySha256: "b".repeat(64),
    requirementsSha256: "c".repeat(64), configurationSha256: "d".repeat(64), sourceCommit: "a".repeat(40), surfaceSha256: "e".repeat(64), segmentIdsBySource: ids, topicIdsBySource: ids } };
  const first = frontendScopedProviderQueryPlan("resend", resend);
  assert.equal(first.queries.length, 6);
  assert.deepEqual(frontendScopedProviderQueryPlan("resend", { ...resend, sql: "DELETE FROM customer_email_outbox" }), first);
  const shipping = { environment: "staging", credentialKind: "personal-access-token", sourceBindingSha256: "a".repeat(64),
    databaseSnapshotSha256: "b".repeat(64), retiredCredentialBindingSha256: "c".repeat(64), replacementCredentialBindingSha256: "d".repeat(64),
    clientId: "ownedClient", expectedProviderShipmentIds: [], sourceCommit: "a".repeat(40), sourceInventorySha256: "e".repeat(64), requirementsSha256: "f".repeat(64) };
  const second = frontendScopedProviderQueryPlan("chitchats", shipping);
  assert.deepEqual(second.queries.map(row => row.name), ["shipments", "jobs", "rateCache", "events"]);
  assert.equal(second.queries.every(row => row.sql.endsWith("LIMIT 4097")), true);
});

test("private fixed rows pass only through safe source normalization in one verified read-only snapshot", async () => {
  await fixture(async dependencies => {
    const queries = [], rows = [{ id: "owned", private_payload: "private-body-marker" }];
    const client = { async query(sql, params) { queries.push({ sql, params }); return { rows: sql.startsWith("SELECT") ? rows : [] }; } };
    let verified = 0;
    const result = await observeFrontendScopedProviderDatabase(client, "resend", { tenant: "ownedTenant" }, async () => { verified++; }, dependencies);
    assert.deepEqual(result.actualRows.ownedRows, rows);
    assert.deepEqual(result.normalizedSnapshot, { ownedRows: [{ id: "owned", privatePayloadPresent: true }] });
    assert.equal(JSON.stringify(result.normalizedSnapshot).includes("private-body-marker"), false);
    assert.equal(result.snapshotSha256, normalizeFrontendScopedProviderSnapshot("resend", result.actualRows, dependencies).snapshotSha256);
    assert.equal(queries[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.deepEqual(queries[1].params, ["ownedTenant"]);
    assert.equal(queries.at(-1).sql, "ROLLBACK");
    assert.equal(verified >= 4, true);
  });
});

test("overflow, verification loss, changed source and non-SELECT/unbounded plans cannot become completed observations", async () => {
  await fixture(async (dependencies, file) => {
    const queries = [];
    const client = { async query(sql) { queries.push(sql); return { rows: sql.startsWith("SELECT") ? Array.from({ length: 4097 }, () => ({})) : [] }; } };
    await assert.rejects(observeFrontendScopedProviderDatabase(client, "resend", { tenant: "owned" }, async () => {}, dependencies), /FRONTEND_PROVIDER_EFFECT_SCOPE_REFUSED/u);
    assert.equal(queries.at(-1), "ROLLBACK");
    const changed = { async query(sql) {
      if (sql.startsWith("SELECT")) writeFileSync(file, source + "\n# changed-source\n");
      return { rows: [] };
    } };
    await assert.rejects(observeFrontendScopedProviderDatabase(changed, "resend", { tenant: "owned" }, async () => {}, dependencies));
    for (const sql of ["DELETE FROM owned_scope LIMIT 4097", "SELECT * FROM owned_scope", "SELECT * FROM owned_scope; DELETE FROM owned_scope LIMIT 4097"]) {
      writeFileSync(file, `def database_queries(reviewed):\n return [('ownedRows',${JSON.stringify(sql)},[])]\n`);
      assert.throws(() => frontendScopedProviderQueryPlan("resend", {}, dependencies));
    }
    writeFileSync(file, source);
    let calls = 0;
    await assert.rejects(observeFrontendScopedProviderDatabase({ async query() { return { rows: [] }; } }, "resend", { tenant: "owned" }, async () => {
      if (++calls === 2) throw new Error("private-verification-marker");
    }, dependencies), error => error.message === "FRONTEND_PROVIDER_EFFECT_SCOPE_REFUSED");
  });
});

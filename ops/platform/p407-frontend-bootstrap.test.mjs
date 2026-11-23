import assert from "node:assert/strict";
import test from "node:test";
import { prepareP407FrontendScope, P407_FRONTEND_TARGET, verifyP407FrontendSession } from "./p407-frontend-bootstrap.mjs";

const witness = { version: 1, databaseOid: "16393", migrationRoleOid: "16389", runtimeRoleOid: "16390", systemIdentifier: "7711125212182925360" };
const tags = ["0000_first", "0001_second"];
const prepared = (bootstrap = true) => ({
  job: { environment: "staging", recoveryRef: "p4-07/lightsail/empty-schema/" + "a".repeat(64),
    target: { ...P407_FRONTEND_TARGET, allowEmptyBootstrap: bootstrap, approvedPendingTags: bootstrap ? [...tags] : [] } },
  artifact: { migrations: tags.map((tag) => ({ tag })) },
});

test("P4-07 selects only an exact fresh chain", () => {
  assert.deepEqual(prepareP407FrontendScope(prepared(), witness), witness);
  assert.throws(() => prepareP407FrontendScope(prepared(false), witness), /P407_ISOLATED_FRONTEND_REFUSED/);
  const failures = [
    { host: "shared.example.com" }, { port: 6432 }, { serverMajor: 17 }, { database: "lash_her_p407_course" },
    { user: P407_FRONTEND_TARGET.runtimeRole }, { runtimeRole: "postgres" },
    { allowEmptyBootstrap: false }, { approvedPendingTags: [tags[1]] }, { approvedPendingTags: [...tags].reverse() },
  ];
  for (const modification of failures) {
    const input = prepared();
    Object.assign(input.job.target, modification);
    assert.throws(() => prepareP407FrontendScope(input, witness), /P407_ISOLATED_FRONTEND_REFUSED/);
  }
  const input = prepared();
  assert.throws(() => prepareP407FrontendScope({ ...input, job: { ...input.job, environment: "production" } }, witness));
  assert.throws(() => prepareP407FrontendScope({ ...input, job: { ...input.job, recoveryRef: "staging/shared" } }, witness));
  assert.throws(() => prepareP407FrontendScope(input, { ...witness, migrationRoleOid: witness.runtimeRoleOid }));
  assert.throws(() => prepareP407FrontendScope(input, { ...witness, systemIdentifier: 1 }));
});

test("P4-07 checks physical identity and write containment on the actual locked session", async () => {
  const row = { ...witness, serverAddress: "172.29.40.2", clientAddress: "172.29.40.11", otherSessions: 0, empty: true };
  const client = (result) => ({
    query(sql, args) {
      assert.match(sql, /pg_control_system\(\)/u);
      assert.match(sql, /pg_stat_activity/u);
      assert.deepEqual(args, [P407_FRONTEND_TARGET.runtimeRole]);
      return { rows: [result] };
    },
  });
  await verifyP407FrontendSession(client(row), witness);
  await verifyP407FrontendSession(client({ ...row, empty: false }), witness);
  for (const modification of [
    { empty: false }, { clientAddress: "172.29.40.10" }, { serverAddress: "172.29.40.3" },
    { systemIdentifier: "2" }, { databaseOid: "3" }, { migrationRoleOid: "4" }, { runtimeRoleOid: "5" },
    { otherSessions: 1 },
  ]) {
    await assert.rejects(verifyP407FrontendSession(client({ ...row, ...modification }), witness, true),
      /P407_ISOLATED_FRONTEND_REFUSED/);
  }
});

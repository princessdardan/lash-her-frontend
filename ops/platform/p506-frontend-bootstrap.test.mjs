import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareP506FrontendScope, P506_FRONTEND_TARGET, verifyP506FrontendSession } from "./p506-frontend-bootstrap.mjs";

const foundation = Buffer.from([
  "candidate_postgres_major=18", "candidate_system_id=7711876906181357618",
  "shared_system_id=7707405189281873963", "databases=3", "roles_held=7", "networks=2", "published_ports=0", "",
].join("\n"));
const backup = Buffer.from("Synthetic empty schema backup for input guards only\n");
const backupSha256 = createHash("sha256").update(backup).digest("hex");
const sourceCommit = "a".repeat(40);
const releaseId = "p5-06-test";
const witness = { version: 1, databaseOid: "16393", migrationRoleOid: "16389", runtimeRoleOid: "16390", systemIdentifier: "7711876906181357618" };
const tags = ["0000_first", "0001_second"];
const confirmation = `staging/${releaseId}/p5-06/${sourceCommit}/${backupSha256}`;
const mode = "--execute-p506-bootstrap";
const current = "--execute-p506-current";
const prepared = (bootstrap = true) => ({
  candidate: { sources: {
    frontend: { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: sourceCommit, requiredChecks: "passed" },
    course: { repository: "https://github.com/princessdardan/lash-her-course-api.git", commit: "b".repeat(40), requiredChecks: "passed" },
    community: { repository: "https://github.com/princessdardan/lash-her-community-api.git", commit: "c".repeat(40), requiredChecks: "passed" },
  } },
  job: { environment: "staging", releaseId, sourceCommit, recoveryRef: `p5-06/lightsail/empty-schema/${backupSha256}`,
    target: { ...P506_FRONTEND_TARGET, allowEmptyBootstrap: bootstrap, approvedPendingTags: bootstrap ? [...tags] : [] } },
  artifact: { migrations: tags.map((tag) => ({ tag })) },
});
const select = (value = prepared(), identity = witness, receipt = foundation, prior = backup, operation = mode, confirm = confirmation) =>
  prepareP506FrontendScope(value, identity, receipt, prior, operation, confirm);
const refused = /P506_ISOLATED_FRONTEND_REFUSED/u;

test("P5-06 selects the isolated target and exact migration chain separately from current-only verification", () => {
  assert.deepEqual(select().witness, witness);
  assert.equal(select().backupSha256, backupSha256);
  assert.deepEqual(select(prepared(false), witness, foundation, backup, current).witness, witness);
  assert.throws(() => select(prepared(false)), refused);
  assert.throws(() => select(prepared(), witness, foundation, backup, current), refused);
  for (const target of [
    { host: "p4-07-db.lashher.com" }, { database: "lash_her_p506_course" },
    { user: P506_FRONTEND_TARGET.runtimeRole }, { runtimeRole: "postgres" },
    { port: 6432 }, { serverMajor: 16 }, { approvedPendingTags: [...tags].reverse() },
  ]) {
    const input = prepared();
    Object.assign(input.job.target, target);
    assert.throws(() => select(input), refused);
  }
  for (const metadata of [{ environment: "production" }, { releaseId: "p4-07-test" }, { recoveryRef: "unrelated" }, { sourceCommit: "0".repeat(40) }]) {
    const input = prepared();
    Object.assign(input.job, metadata);
    assert.throws(() => select(input), refused);
  }
  const pending = prepared();
  pending.candidate.sources.community.requiredChecks = "pending";
  assert.throws(() => select(pending), refused);
});

test("P5-06 requires its foundation, backup digest, physical IDs, and full operator confirmation", () => {
  assert.throws(() => select(prepared(), witness, Buffer.from("other foundation")), refused);
  assert.throws(() => select(prepared(), witness, foundation, Buffer.from("different backup")), refused);
  assert.throws(() => select(prepared(), witness, foundation, backup, mode, `staging/${releaseId}`), refused);
  assert.throws(() => select(prepared(), witness, foundation, backup, mode, confirmation.replace(sourceCommit, "b".repeat(40))), refused);
  assert.throws(() => select(prepared(), { ...witness, systemIdentifier: "7707405189281873963" }), refused);
  assert.throws(() => select(prepared(), { ...witness, migrationRoleOid: witness.runtimeRoleOid }), refused);
});

test("P5-06 binds each successor receipt to its own physical database", async () => {
  for (const successorId of ["7712635123417854000", "7712662041236086833"]) {
    const successor = { ...witness, systemIdentifier: successorId };
    const receipt = Buffer.from(foundation.toString().replace(witness.systemIdentifier, successorId));
    assert.deepEqual(select(prepared(), successor, receipt).witness, successor);
    assert.throws(() => select(prepared(), successor, foundation), refused);
    assert.throws(() => select(prepared(), witness, receipt), refused);
    const seen = { ...successor, serverAddress: "172.30.56.2", clientAddress: "172.30.56.11",
      otherSessions: 0, empty: true, runtimeHeld: true, migrationRestricted: true };
    const session = (row) => ({ query: async () => ({ rows: [row] }) });
    await verifyP506FrontendSession(session(seen), successor, true);
    await assert.rejects(verifyP506FrontendSession(session(seen), witness, true), refused);
    await assert.rejects(verifyP506FrontendSession(session({ ...seen, serverAddress: "172.30.57.2" }), successor, true), refused);
    await assert.rejects(verifyP506FrontendSession(session({ ...seen, clientAddress: "172.30.57.11" }), successor, true), refused);
  }
});

test("P5-06 refuses an uncompiled foundation before querying the session", async () => {
  const client = { query() { assert.fail("Unknown foundation must be refused before querying"); } };
  await assert.rejects(verifyP506FrontendSession(client, {
    ...witness, systemIdentifier: "7707405189281873963",
  }), refused);
});

test("P5-06 checks the hold and every physical target field on the migration session", async () => {
  const row = { ...witness, serverAddress: "172.30.56.2", clientAddress: "172.30.56.11",
    otherSessions: 0, empty: true, runtimeHeld: true, migrationRestricted: true };
  const verify = async (sample, empty = true) => verifyP506FrontendSession({
    query(sql, args) {
      assert.match(sql, /pg_control_system\(\)/u);
      assert.match(sql, /not rolcanlogin/u);
      assert.deepEqual(args, [P506_FRONTEND_TARGET.runtimeRole]);
      return { rows: [sample] };
    },
  }, witness, empty);
  await verify(row);
  await verify({ ...row, empty: false }, false);
  for (const change of [
    { serverAddress: "172.29.40.2" }, { clientAddress: "172.30.56.10" },
    { systemIdentifier: "7707405189281873963" }, { runtimeHeld: false }, { migrationRestricted: false },
    { databaseOid: "123" }, { migrationRoleOid: "123" }, { runtimeRoleOid: "123" }, { otherSessions: 1 }, { empty: false },
  ]) {
    await assert.rejects(verify({ ...row, ...change }), refused);
  }
});

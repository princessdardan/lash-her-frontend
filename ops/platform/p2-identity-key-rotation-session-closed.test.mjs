import assert from "node:assert/strict";
import test from "node:test";
import { observeP2IdentityRotationFrontendClosed } from "./p2-identity-key-rotation-session-closed.mjs";

const probe = { version: 1, marker: "a".repeat(64), backendPid: 321,
  backendStart: "2026-11-06 12:00:00+00", applicationName: "lash-her-p2-recovery-current",
  targetSha256: "b".repeat(64), owner: { name: "frontend_migration_owner", oid: "42" },
  job: { sourceCommit: "c".repeat(40), target: { host: "db.example", port: 5432,
    database: "frontend_staging", user: "frontend_operator", serverMajor: 16, approvedPendingTags: [] } },
  receipt: { status: "P2_RECOVERY_DATABASE_CURRENT", candidateSha256: "d".repeat(64), trafficAuthorized: false } };
const input = { version: 1, operation: "verify-closed", actionId: "p2-key-rotation-owned", probe };

class FakeClient {
  constructor(options, changes = {}) { this.options = options; this.changes = changes;
    this.connection = { stream: { encrypted: true, authorized: true } }; this.ended = false; }
  on() {}
  async connect() {}
  async end() { this.ended = true; }
  async query(sql) {
    if (sql.startsWith("SELECT current_user")) return { rows: [{ username: probe.job.target.user,
      database: probe.job.target.database, major: probe.job.target.serverMajor }] };
    if (sql.includes("FROM pg_stat_activity")) return { rows: [{ count: this.changes.backendPresent ? 1 : 0 }] };
    if (sql.includes("FROM pg_locks")) return { rows: [{ count: 0 }] };
    if (sql.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ locked: !this.changes.lockUnavailable }] };
    if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
    if (sql.startsWith("SELECT oid::text FROM pg_roles")) return { rows: [{ oid: probe.owner.oid }] };
    if (sql.includes("FROM frontend_admission.control")) return { rows: [{ environment: "staging",
      target_sha256: probe.targetSha256, epoch: "9", new_work: this.changes.open === true, recovery: false }] };
    if (sql.includes("FROM frontend_admission.operations")) return { rows: [{ active: 0, uncertain: 0 }] };
    return { rows: [] };
  }
}

async function observe(changes = {}) {
  let client;
  const result = await observeP2IdentityRotationFrontendClosed(input, {
    getUrl: async () => "postgresql://frontend_operator:secret@db.example:5432/frontend_staging?sslmode=verify-full",
    createClient: options => (client = new FakeClient(options, changes)),
  });
  return { result, client };
}

test("post-session proof requires backend absence, both released locks, and closed admission", async () => {
  const { result, client } = await observe();
  assert.equal(result.status, "P2_IDENTITY_ROTATION_FRONTEND_SESSION_CLOSED");
  assert.equal(result.backendAbsent, true);
  assert.equal(result.migrationLockReleased, true);
  assert.equal(result.nonceLockReleased, true);
  assert.equal(result.active, 0);
  assert.equal(result.uncertain, 0);
  assert.equal(client.options.application_name, "lash-her-p2-identity-rotation-close");
  assert.equal(client.ended, true);
});

for (const [name, changes] of [["original backend remains", { backendPresent: true }],
  ["an advisory lock cannot be acquired", { lockUnavailable: true }],
  ["frontend admission reopened", { open: true }]]) {
  test(`post-session proof refuses when ${name}`, async () => {
    await assert.rejects(() => observe(changes), /P2_IDENTITY_ROTATION_SESSION_CLOSE_REFUSED/u);
  });
}

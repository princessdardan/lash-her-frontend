import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, like } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "@/lib/private-db/schema";
import type { getPrivateDb } from "@/lib/private-db/client";
import { hashCustomerSession } from "./policy";
import { issueLockedCustomerToken } from "./session-issuance";

const url = process.env.TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url, max: 6 }) : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
const skipped = { skip: !db && "set TEST_DATABASE_URL for session issuance lock tests" };
const prefix = `issuance-${randomUUID()}`;
after(async () => { if (db) await db.delete(schema.customerUsers).where(like(schema.customerUsers.email, `${prefix}%`)); await pool?.end(); });
async function seed() {
  const [user] = await db!.insert(schema.customerUsers).values({ email: `${prefix}-${randomUUID()}@example.invalid`, name: "Learner" }).returning();
  const sessionToken = randomUUID();
  await db!.insert(schema.customerSessions).values({ userId: user.id, tokenHash: hashCustomerSession(sessionToken), expires: new Date(Date.now() + 60_000) });
  return { user, sessionToken };
}
function latch() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }

test("suspension committed first denies issuance after waiting for the customer row", skipped, async () => {
  const { user, sessionToken } = await seed();
  const hold = await pool!.connect();
  let minted = 0;
  try {
    const backendId = (await hold.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    await hold.query("BEGIN");
    await hold.query("UPDATE customer_users SET status='suspended' WHERE id=$1", [user.id]);
    const pending = issueLockedCustomerToken(sessionToken, () => { minted++; return "token"; }, { database: () => db! });
    // Observe an actual blocked backend, not just elapsed wall time.
    for (let index = 0; index < 100; index++) {
      const found = await pool!.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [backendId]);
      if (found.rowCount) break;
      if (index === 99) assert.fail("issuance did not wait on the held customer lock");
    }
    await hold.query("COMMIT");
    assert.equal(await pending, null); assert.equal(minted, 0);
  } finally { await hold.query("ROLLBACK"); hold.release(); }
});

test("issuance holds SHARE through the local mint and commits before suspension/session revocation", skipped, async () => {
  const { user, sessionToken } = await seed();
  const issued = latch(), finish = latch();
  let minted = 0;
  const wrapped = Object.create(db) as ReturnType<typeof getPrivateDb>;
  wrapped.transaction = work => db!.transaction(async tx => {
    const result = await work(tx); issued.release(); await finish.promise; return result;
  });
  const pending = issueLockedCustomerToken(sessionToken, customerId => { assert.equal(customerId, user.id); minted++; return "local.token"; }, { database: () => wrapped });
  await issued.promise;
  const updater = await pool!.connect();
  let suspensionCompleted = false;
  try {
    const backendId = (await updater.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    await updater.query("BEGIN");
    const update = updater.query("UPDATE customer_users SET status='suspended' WHERE id=$1", [user.id]).then(() => { suspensionCompleted = true; });
    for (let index = 0; index < 100; index++) {
      const found = await pool!.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND cardinality(pg_blocking_pids(pid))>0", [backendId]);
      if (found.rowCount) break;
      if (index === 99) assert.fail("suspension did not wait on issuance SHARE lock");
    }
    assert.equal(suspensionCompleted, false); assert.equal(minted, 1);
    finish.release();
    assert.deepEqual(await pending, { customerId: user.id, token: "local.token" });
    await update;
    await updater.query("DELETE FROM customer_sessions WHERE user_id=$1", [user.id]);
    await updater.query("COMMIT");
    assert.equal(await issueLockedCustomerToken(sessionToken, () => assert.fail("mint after revocation"), { database: () => db! }), null);
  } finally { finish.release(); await updater.query("ROLLBACK"); updater.release(); }
});

test("pure issuance preserves absolute sessions and rejects expiration and sign-out", skipped, async () => {
  const { user, sessionToken } = await seed();
  const before = await db!.select().from(schema.customerSessions).where(eq(schema.customerSessions.userId, user.id));
  assert.ok(await issueLockedCustomerToken(sessionToken, () => "token", { database: () => db! }));
  assert.deepEqual(await db!.select().from(schema.customerSessions).where(eq(schema.customerSessions.userId, user.id)), before);
  assert.equal(await issueLockedCustomerToken(sessionToken, () => assert.fail("expired mint"), { database: () => db!, now: () => new Date(Date.now() + 120_000) }), null);
  await db!.delete(schema.customerSessions).where(eq(schema.customerSessions.userId, user.id));
  assert.equal(await issueLockedCustomerToken(sessionToken, () => assert.fail("signed out mint"), { database: () => db! }), null);
});

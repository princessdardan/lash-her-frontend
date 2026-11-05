import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/private-db/schema";
import { customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "@/lib/customer-auth/schema";
import { customerAccountCommands as commands, customerAccountDeliveries as deliveries, customerAccountExports as exports, customerAccountPreferences as preferences } from "./schema";
import { runAccountWriter } from "./context";
import { createAccountLifecycleStore } from "./store";
import { processAccountLifecycle } from "./worker";
import type { AccountCommand } from "./policy";

const url = process.env.TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url, max: 8 }) : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
const skipped = { skip: !db && "set TEST_DATABASE_URL to an owned disposable loopback database" };
let instant = new Date();
const store = createAccountLifecycleStore(() => db!, () => instant);
const admin = { kind: "admin" as const, adminId: randomUUID() };
const admitted = <T>(task: () => Promise<T>) => runAccountWriter("new-work", task);
before(() => { if (url && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Lifecycle tests require disposable loopback PostgreSQL"); });
after(async () => { await pool?.end(); });
async function createUser() {
  const [user] = await db!.insert(customerUsers).values({ email: `lifecycle-${randomUUID()}@example.com`, name: "Private Customer", emailVerified: instant }).returning();
  const tokenHash = randomUUID();
  await db!.insert(customerSessions).values({ tokenHash, userId: user.id, expires: new Date(instant.getTime() + 86_400_000), createdAt: instant });
  return { user, session: { userId: user.id, tokenHash } };
}
async function acknowledgeAll() {
  for (let index = 0; index < 100; index++) {
    const claim = await store.claimDelivery();
    if (!claim) return;
    await store.settleDelivery(claim, "acknowledged");
  }
  throw new Error("Fixture delivery drain exceeded bound");
}
async function issue(userId: string, action: AccountCommand["action"], idempotencyKey = randomUUID()) {
  return store.request({ userId, action, idempotencyKey, requester: admin });
}

test("suspension revokes every session atomically; ordered restore waits for both receivers and ignores stale acknowledgments", skipped, async () => admitted(async () => {
  const { user } = await createUser();
  await db!.insert(customerSessions).values({ tokenHash: randomUUID(), userId: user.id, expires: new Date(instant.getTime() + 86_400_000) });
  const key = randomUUID();
  const suspended = await issue(user.id, "suspend", key);
  assert.deepEqual(await issue(user.id, "suspend", key), suspended);
  await assert.rejects(() => issue(user.id, "restore", key), /idempotency_conflict/u);
  assert.equal((await db!.select().from(customerSessions).where(eq(customerSessions.userId, user.id))).length, 0);
  assert.equal((await db!.select().from(deliveries).where(eq(deliveries.commandId, suspended.commandId))).length, 2);
  const restore = await issue(user.id, "restore");
  assert.equal(restore.accountVersion, 2);
  const first = await store.claimDelivery(); assert.equal(first?.command.commandId, suspended.commandId);
  const second = await store.claimDelivery(); assert.equal(second?.command.commandId, suspended.commandId);
  assert.equal(await store.claimDelivery(), null);
  await store.settleDelivery(first!, "acknowledged");
  const earlyRestore = await store.claimDelivery(); assert.equal(earlyRestore?.command.commandId, restore.commandId);
  await store.settleDelivery(earlyRestore!, "acknowledged");
  assert.equal((await db!.select().from(customerUsers).where(eq(customerUsers.id, user.id)))[0].status, "suspended");
  await store.settleDelivery(second!, "acknowledged");
  await acknowledgeAll();
  assert.equal((await db!.select().from(customerUsers).where(eq(customerUsers.id, user.id)))[0].status, "active");
  const later = await issue(user.id, "suspend");
  await store.settleDelivery(earlyRestore!, "acknowledged");
  assert.equal((await db!.select().from(customerUsers).where(eq(customerUsers.id, user.id)))[0].status, "suspended");
  assert.equal(later.accountVersion, 3);
  await acknowledgeAll();
}));

test("concurrent idempotency creates one command and sequence; a failed transaction leaves no revocation or partial delivery", skipped, async () => admitted(async () => {
  const { user } = await createUser();
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => issue(user.id, "export", key)));
  assert.equal(new Set(results.map(row => row.commandId)).size, 1);
  assert.equal((await db!.select().from(commands).where(eq(commands.userId, user.id))).length, 1);
  // Database constraints reject a duplicate command identity without changing
  // existing command bytes; the surrounding SQL transaction must roll back.
  await assert.rejects(() => db!.transaction(async tx => {
    await tx.delete(customerSessions).where(eq(customerSessions.userId, user.id));
    await tx.insert(commands).values({ ...results[0], command: results[0], idempotencyKey: randomUUID(), issuedAt: instant });
  }));
  assert.equal((await db!.select().from(customerSessions).where(eq(customerSessions.userId, user.id))).length, 1);
  await acknowledgeAll();
}));

test("private exports bind immutable ownership, expire without replay extension, and never contain session/provider credentials", skipped, async () => admitted(async () => {
  const { user, session } = await createUser();
  const key = randomUUID();
  const command = await store.request({ userId: user.id, action: "export", idempotencyKey: key, requester: { kind: "customer", session } });
  const [snapshot] = await db!.select().from(exports).where(eq(exports.commandId, command.commandId));
  assert.equal(JSON.stringify(snapshot.frontendData).includes(session.tokenHash), false);
  assert.equal(await store.getExport(user.id, command.commandId), null);
  await acknowledgeAll();
  const expires = new Date(instant.getTime() + 86_400_000);
  await store.completeExport(command, { private: "owned" }, [expires]);
  assert.deepEqual(await store.getExport(user.id, command.commandId), { private: "owned" });
  assert.equal(await store.getExport(randomUUID(), command.commandId), null);
  instant = new Date(instant.getTime() + 60_000);
  assert.deepEqual(await issue(user.id, "export", key), command);
  await store.completeExport(command, { private: "must-not-replace" }, [new Date(instant.getTime() + 86_400_000)]);
  const [retained] = await db!.select().from(exports).where(eq(exports.commandId, command.commandId));
  assert.equal(retained.expiresAt?.getTime(), expires.getTime());
  assert.deepEqual(retained.data, { private: "owned" });
  instant = new Date(expires.getTime());
  assert.equal(await store.getExport(user.id, command.commandId), null);
  assert.ok(await store.expireExports() >= 1);
  const [expired] = await db!.select().from(exports).where(eq(exports.commandId, command.commandId));
  assert.equal(expired.data, null); assert.equal(expired.frontendData, null);
}));

test("deletion removes new account PII, preserves immutable commands/tombstone, and cannot be restored or revived by SQL", skipped, async () => admitted(async () => {
  const { user, session } = await createUser();
  await db!.insert(customerProviderLinks).values({ userId: user.id, provider: "google", providerAccountId: randomUUID(), type: "oidc" });
  await db!.insert(customerVerificationTokens).values({ token: randomUUID(), identifier: user.email, expires: new Date(instant.getTime() + 60_000) });
  await store.updatePreferences(session, true);
  const exported = await issue(user.id, "export");
  const deleteKey = randomUUID();
  const command = await store.request({ userId: user.id, action: "delete", idempotencyKey: deleteKey, requester: { kind: "customer", session } });
  const [deleted] = await db!.select().from(customerUsers).where(eq(customerUsers.id, user.id));
  assert.equal(deleted.status, "deleted"); assert.equal(deleted.name, null); assert.equal(deleted.emailVerified, null);
  assert.equal(deleted.email, `deleted+${user.id}@account.invalid`);
  for (const table of [customerProviderLinks, customerSessions, preferences]) assert.equal((await db!.select().from(table).where(eq(table.userId, user.id))).length, 0);
  assert.equal((await db!.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.identifier, user.email))).length, 0);
  const [scrubbed] = await db!.select().from(exports).where(eq(exports.commandId, exported.commandId));
  assert.equal(scrubbed.frontendData, null); assert.equal(scrubbed.data, null);
  assert.deepEqual(await issue(user.id, "delete", deleteKey), command);
  await assert.rejects(() => issue(user.id, "restore"), /account_deleted/u);
  await assert.rejects(() => db!.update(customerUsers).set({ status: "active" }).where(eq(customerUsers.id, user.id)));
  await assert.rejects(() => db!.delete(customerUsers).where(eq(customerUsers.id, user.id)));
  await assert.rejects(() => db!.update(commands).set({ action: "restore" }).where(eq(commands.commandId, command.commandId)));
  await assert.rejects(() => db!.delete(commands).where(eq(commands.commandId, command.commandId)));
  await acknowledgeAll();
}));

test("fresh authentication, cross-account requests and stale preferences are checked inside the account lock", skipped, async () => admitted(async () => {
  const { user, session } = await createUser();
  await db!.update(customerSessions).set({ createdAt: new Date(instant.getTime() - 900_001) }).where(eq(customerSessions.tokenHash, session.tokenHash));
  await assert.rejects(() => store.request({ userId: user.id, action: "delete", idempotencyKey: randomUUID(), requester: { kind: "customer", session } }), /fresh_sign_in_required/u);
  await assert.rejects(() => store.request({ userId: user.id, action: "export", idempotencyKey: randomUUID(), requester: { kind: "customer", session: { ...session, userId: randomUUID() } } }), /account_action_denied/u);
  assert.equal((await db!.select().from(commands).where(eq(commands.userId, user.id))).length, 0);
  await issue(user.id, "suspend");
  await assert.rejects(() => store.updatePreferences(session, true), /sign_in_required/u);
  await acknowledgeAll();
}));

test("receiver outages retain ordered durable retry, lease expiry replays exact command, and exports assemble only after both acknowledgments", skipped, async () => admitted(async () => {
  const { user } = await createUser();
  const command = await issue(user.id, "export");
  const abandoned = await store.claimDelivery(); assert.ok(abandoned);
  instant = new Date(instant.getTime() + 90_001);
  const recovered = await store.claimDelivery(); assert.ok(recovered);
  assert.deepEqual(recovered.command, abandoned.command); assert.notEqual(recovered.leaseId, abandoned.leaseId);
  await store.settleDelivery(abandoned, "acknowledged");
  const [unsettled] = await db!.select().from(deliveries).where(and(eq(deliveries.commandId, recovered.command.commandId), eq(deliveries.receiver, recovered.receiver)));
  assert.equal(unsettled.status, "delivering");
  await store.settleDelivery(recovered, "retry");
  const result = await processAccountLifecycle({ store, client: receiver => ({
    async deliverCommand(input) { if (receiver === recovered.receiver) throw new Error("synthetic outage"); return { commandId: input.commandId, accountVersion: input.accountVersion, status: "accepted" }; },
    async getExport() { throw new Error("must not retrieve before both acknowledgments"); },
  }) });
  assert.equal(result.exportsReady, 0);
  instant = new Date(instant.getTime() + 3_600_001);
  const ready = await processAccountLifecycle({ store, client: () => ({
    async deliverCommand(input) { return { commandId: input.commandId, accountVersion: input.accountVersion, status: "duplicate" }; },
    async getExport(input) { return { commandId: input.commandId, userId: input.userId, accountVersion: input.accountVersion, expiresAt: new Date(instant.getTime() + 86_400_000).toISOString(), data: { scope: "synthetic UUID-owned learning data" } }; },
  }) });
  assert.ok(ready.exportsReady >= 1);
  assert.ok(await store.getExport(user.id, command.commandId));
  const count = (await db!.execute<{ count: string }>(sql`select count(*)::text as count from customer_account_commands where user_id = ${user.id}::uuid`)).rows[0];
  assert.equal(count.count, "1");
}));

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/private-db/schema";
import { customerProviderLinks, customerSessions, customerUsers, customerVerificationTokens } from "@/lib/customer-auth/schema";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { runAccountWriter } from "./context";
import { AccountLifecycleError, type AccountCommand } from "./policy";
import { customerAccountCommands as commands, customerAccountDeliveries as deliveries, customerAccountExports as exports, customerAccountPreferences as preferences } from "./schema";
import { createAccountLifecycleStore } from "./store";
import { processAccountLifecycle } from "./worker";

const url = process.env.TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url), databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const segments = databaseName.toLowerCase().split(/[^a-z0-9]+/u);
  const ownedParent = databaseName === "frontend_admission_owned" && process.env.FRONTEND_CUSTOMER_LIFECYCLE_OWNED_TEST === "true";
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      segments.some(segment => ["prod", "production", "staging", "stage", "live", "main"].includes(segment)) ||
      (!ownedParent && !segments.some(segment => ["test", "ci", "integration", "audit", "roundtrip", "scratch"].includes(segment))))
    throw new Error("Lifecycle fault tests require an owned disposable loopback database");
}
const pool = url ? new Pool({ connectionString: url, max: 8 }) : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
const skipped = { skip: !db && "set TEST_DATABASE_URL to an owned disposable loopback database" };
const originalAdmissionMode = process.env.FRONTEND_WRITER_ADMISSION_MODE;
before(() => { process.env.FRONTEND_WRITER_ADMISSION_MODE = "off"; });
after(async () => {
  await pool?.end();
  if (originalAdmissionMode === undefined) delete process.env.FRONTEND_WRITER_ADMISSION_MODE;
  else process.env.FRONTEND_WRITER_ADMISSION_MODE = originalAdmissionMode;
});
const admitted = <T>(task: () => Promise<T>) => runAccountWriter("new-work", task);
type Database = NonNullable<typeof db>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
function transactionFault(intercept: (tx: Transaction, member: PropertyKey) => unknown): Database {
  assert.ok(db);
  return new Proxy(db, { get(target, property) {
    if (property === "transaction") return <T>(task: (tx: Transaction) => Promise<T>) => target.transaction(tx => task(new Proxy(tx, { get(transaction, member) {
      const overridden = intercept(transaction, member);
      if (overridden !== undefined) return overridden;
      const value: unknown = Reflect.get(transaction, member);
      return typeof value === "function" ? value.bind(transaction) : value;
    } })));
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function noOpMutation() {
  const query = { where() { return query; }, set() { return query; }, returning() { return query; },
    then(fulfilled?: (rows: unknown[]) => unknown, rejected?: (error: unknown) => unknown) { return Promise.resolve([]).then(fulfilled, rejected); } };
  return query;
}
function invoke(tx: Transaction, member: PropertyKey, argument: unknown): unknown {
  const method: unknown = Reflect.get(tx, member);
  if (typeof method !== "function") throw new Error("Missing owned fault mutation");
  const value: unknown = Reflect.apply(method, tx, [argument]);
  return value;
}
async function uncertainRefusal(task: () => Promise<unknown>) {
  await assert.rejects(withWriterOperationContext(async () => { await assert.rejects(admitted(task)); }), /WRITER_OPERATION_REQUIRES_REVIEW/u);
}


async function fixture() {
  assert.ok(db);
  let instant = new Date();
  const [user] = await db.insert(customerUsers).values({ email: `lifecycle-fault-${randomUUID()}@example.test`, name: "Owned Fault Fixture", emailVerified: instant }).returning();
  assert.ok(user);
  const tokenHash = randomUUID(), session = { userId: user.id, tokenHash };
  await db.insert(customerSessions).values({ tokenHash, userId: user.id, expires: new Date(instant.getTime() + 86_400_000), createdAt: instant });
  const store = createAccountLifecycleStore(() => db!, () => instant);
  const admin = { kind: "admin" as const, adminId: randomUUID() };
  return { user, session, store, now: () => instant, advance: (ms: number) => { instant = new Date(instant.getTime() + ms); },
    issue: (action: AccountCommand["action"], key = randomUUID()) => admitted(() => store.request({ userId: user.id, action, idempotencyKey: key, requester: admin })),
    customerExport: (key = randomUUID()) => admitted(() => store.request({ userId: user.id, action: "export", idempotencyKey: key, requester: { kind: "customer", session } })),
    async quarantine() {
      // Only mutable synthetic fixture rows are quarantined. Immutable command
      // history/tombstones remain until this owned database is destroyed. This
      // prevents global claim scans in other test files inheriting our faults.
      const rows = await db!.select({ commandId: commands.commandId }).from(commands).where(eq(commands.userId, user.id));
      if (rows.length) await db!.update(deliveries).set({ status: "blocked", leaseId: null, leaseUntil: null, lastError: "owned_fixture_quarantined" }).where(inArray(deliveries.commandId, rows.map(row => row.commandId)));
      await db!.update(exports).set({ status: "failed", frontendData: null, data: null }).where(eq(exports.userId, user.id));
    },
  };
}
async function acknowledge(command: AccountCommand, store: ReturnType<typeof createAccountLifecycleStore>, receivers = 2) {
  for (let index = 0; index < receivers; index++) {
    const claim = await store.claimDelivery();
    assert.ok(claim); assert.equal(claim.command.commandId, command.commandId);
    await store.settleDelivery(claim, "acknowledged");
  }
}

test("missing restore receiver does not reopen frontend access after the remaining acknowledgment", skipped, async () => {
  const f = await fixture();
  try { await admitted(async () => {
    const suspended = await f.issue("suspend"); await acknowledge(suspended, f.store);
    const restored = await f.issue("restore");
    await db!.delete(deliveries).where(and(eq(deliveries.commandId, restored.commandId), eq(deliveries.receiver, "community")));
    await acknowledge(restored, f.store, 1);
    const [denied] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id));
    assert.equal(denied.status, "suspended", "a missing receiver is not an acknowledgment");
    await db!.insert(deliveries).values({ commandId: restored.commandId, receiver: "community", nextRunAt: f.now() });
    await acknowledge(restored, f.store, 1);
    const [active] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id)); assert.equal(active.status, "active");
  }); } finally { await f.quarantine(); }
});

test("missing predecessor receiver denies its later command and prevents restoration", skipped, async () => {
  const f = await fixture();
  try { await admitted(async () => {
    const suspended = await f.issue("suspend");
    await db!.delete(deliveries).where(and(eq(deliveries.commandId, suspended.commandId), eq(deliveries.receiver, "community")));
    await acknowledge(suspended, f.store, 1);
    const restored = await f.issue("restore");
    const course = await f.store.claimDelivery(); assert.ok(course); assert.equal(course.command.commandId, restored.commandId); assert.equal(course.receiver, "course");
    await f.store.settleDelivery(course, "acknowledged");
    assert.equal(await f.store.claimDelivery(), null, "Community restore cannot skip a missing predecessor receipt");
    const [user] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id)); assert.equal(user.status, "suspended");
  }); } finally { await f.quarantine(); }
});

test("missing export receiver prevents assembly until both expected receivers acknowledge", skipped, async () => {
  const f = await fixture();
  let exportFetches = 0;
  const client = () => ({
    async deliverCommand(input: AccountCommand) { return { commandId: input.commandId, accountVersion: input.accountVersion, status: "accepted" as const }; },
    async getExport(input: AccountCommand) { exportFetches++; return { commandId: input.commandId, userId: input.userId, accountVersion: input.accountVersion, expiresAt: new Date(f.now().getTime() + 86_400_000).toISOString(), data: { scope: "owned synthetic receiver" } }; },
  });
  try { await admitted(async () => {
    const exported = await f.customerExport();
    await db!.delete(deliveries).where(and(eq(deliveries.commandId, exported.commandId), eq(deliveries.receiver, "community")));
    await acknowledge(exported, f.store, 1);
    assert.equal((await f.store.pendingExports()).some(row => row.command.commandId === exported.commandId), false);
    assert.equal((await processAccountLifecycle({ store: f.store, client })).exportsReady, 0); assert.equal(exportFetches, 0);
    assert.equal(await f.store.getExport(f.user.id, exported.commandId), null);
    await db!.insert(deliveries).values({ commandId: exported.commandId, receiver: "community", nextRunAt: f.now() });
    await acknowledge(exported, f.store, 1);
    assert.equal((await processAccountLifecycle({ store: f.store, client })).exportsReady, 1); assert.equal(exportFetches, 2);
    assert.ok(await f.store.getExport(f.user.id, exported.commandId));
  }); } finally { await f.quarantine(); }
});

test("a one-row delivery insertion receipt rolls back state, session revocation and command allocation", skipped, async () => {
  const f = await fixture();
  assert.ok(db);
  const interceptedDatabase = new Proxy(db, { get(target, property) {
    if (property === "transaction") return <T>(task: (tx: Transaction) => Promise<T>) => target.transaction(tx => task(new Proxy(tx, { get(transaction, member) {
      if (member === "insert") return (table: unknown) => {
        if (table === deliveries) return { values: (rows: typeof deliveries.$inferInsert[]) => transaction.insert(deliveries).values(rows.slice(0, 1)) };
        if (table === commands) return transaction.insert(commands);
        if (table === exports) return transaction.insert(exports);
        throw new Error("Unexpected lifecycle fault insertion");
      };
      const value: unknown = Reflect.get(transaction, member);
      return typeof value === "function" ? value.bind(transaction) : value;
    } })));
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const faultyStore = createAccountLifecycleStore(() => interceptedDatabase, f.now);
  try {
    await assert.rejects(withWriterOperationContext(async () => {
      await assert.rejects(admitted(() => faultyStore.request({ userId: f.user.id, action: "suspend", idempotencyKey: randomUUID(), requester: { kind: "admin", adminId: randomUUID() } })));
    }), /WRITER_OPERATION_REQUIRES_REVIEW/u);
    assert.equal((await db.select().from(commands).where(eq(commands.userId, f.user.id))).length, 0);
    const [user] = await db.select().from(customerUsers).where(eq(customerUsers.id, f.user.id)); assert.equal(user.status, "active"); assert.equal(user.accountVersion, 0);
    assert.equal((await db.select().from(customerSessions).where(eq(customerSessions.userId, f.user.id))).length, 1);
  } finally { await f.quarantine(); }
});

test("suppressed session deletion rolls back suspension instead of preserving a restorable old session", skipped, async () => {
  const f = await fixture();
  const intercepted = transactionFault((tx, member) => member === "delete" ? (table: unknown) => table === customerSessions ? noOpMutation() : invoke(tx, member, table) : undefined);
  const faultyStore = createAccountLifecycleStore(() => intercepted, f.now);
  try {
    await uncertainRefusal(() => faultyStore.request({ userId: f.user.id, action: "suspend", idempotencyKey: randomUUID(), requester: { kind: "admin", adminId: randomUUID() } }));
    const [user] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id));
    assert.equal(user.status, "active"); assert.equal(user.accountVersion, 0);
    assert.equal((await db!.select().from(commands).where(eq(commands.userId, f.user.id))).length, 0);
    assert.equal((await db!.select().from(customerSessions).where(eq(customerSessions.userId, f.user.id))).length, 1);
  } finally { await f.quarantine(); }
});

test("suppressed eligible PII deletion or export redaction rolls back terminal deletion", skipped, async () => {
  for (const fault of ["provider-link-delete", "export-redaction"]) {
    const f = await fixture();
    try {
      await db!.insert(customerProviderLinks).values({ userId: f.user.id, provider: "google", providerAccountId: randomUUID(), type: "oidc" });
      await db!.insert(customerVerificationTokens).values({ token: randomUUID(), identifier: f.user.email, expires: new Date(f.now().getTime() + 900_000) });
      await db!.insert(preferences).values({ userId: f.user.id, learningUpdates: true });
      const exported = await f.customerExport();
      await admitted(() => acknowledge(exported, f.store));
      await admitted(() => f.store.completeExport(exported, { private: "owned-profile-bytes" }, [new Date(f.now().getTime() + 86_400_000)]));
      const intercepted = transactionFault((tx, member) => {
        if (fault === "provider-link-delete" && member === "delete") return (table: unknown) => table === customerProviderLinks ? noOpMutation() : invoke(tx, member, table);
        if (fault === "export-redaction" && member === "update") return (table: unknown) => table === exports ? noOpMutation() : invoke(tx, member, table);
        return undefined;
      });
      const faultyStore = createAccountLifecycleStore(() => intercepted, f.now);
      await uncertainRefusal(() => faultyStore.request({ userId: f.user.id, action: "delete", idempotencyKey: randomUUID(), requester: { kind: "admin", adminId: randomUUID() } }));
      const [user] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id));
      assert.equal(user.status, "active"); assert.equal(user.accountVersion, 1); assert.equal(user.email, f.user.email); assert.equal(user.name, f.user.name);
      assert.equal((await db!.select().from(commands).where(eq(commands.userId, f.user.id))).length, 1);
      for (const table of [customerSessions, customerProviderLinks, preferences]) assert.equal((await db!.select().from(table).where(eq(table.userId, f.user.id))).length, 1);
      assert.equal((await db!.select().from(customerVerificationTokens).where(eq(customerVerificationTokens.identifier, f.user.email))).length, 1);
      assert.deepEqual(await f.store.getExport(f.user.id, exported.commandId), { private: "owned-profile-bytes" });
    } finally { await f.quarantine(); }
  }
});

test("concurrent fresh export keys allocate one pending command while exact replay bypasses quota", skipped, async () => {
  const f = await fixture();
  const keys = Array.from({ length: 12 }, () => randomUUID());
  try {
    const results = await Promise.allSettled(keys.map(key => f.customerExport(key)));
    const successes = results.flatMap((result, index) => result.status === "fulfilled" ? [{ command: result.value, key: keys[index]! }] : []);
    assert.equal(successes.length, 1);
    for (const result of results) if (result.status === "rejected") assert.ok(result.reason instanceof AccountLifecycleError && result.reason.status === 429);
    assert.deepEqual(await f.customerExport(successes[0].key), successes[0].command);
    assert.equal((await db!.select().from(commands).where(eq(commands.userId, f.user.id))).length, 1);
    assert.equal((await db!.select().from(deliveries).where(eq(deliveries.commandId, successes[0].command.commandId))).length, 2);
    assert.equal((await db!.select().from(exports).where(eq(exports.userId, f.user.id))).length, 1);
    const settled = await withWriterOperationContext(async () => {
      await assert.rejects(f.customerExport(), error => error instanceof AccountLifecycleError && error.status === 429);
      return "known quota denial";
    }); assert.equal(settled, "known quota denial");
  } finally { await f.quarantine(); }
});

test("export cooldown remains after pending completion and opens at fifteen minutes", skipped, async () => {
  const f = await fixture();
  try {
    const first = await f.customerExport();
    await db!.update(exports).set({ status: "failed", frontendData: null, data: null }).where(eq(exports.commandId, first.commandId));
    f.advance(899_999);
    await assert.rejects(f.customerExport(), error => error instanceof AccountLifecycleError && error.status === 429);
    f.advance(1); const second = await f.customerExport(); assert.notEqual(second.commandId, first.commandId); assert.equal(second.accountVersion, 2);
  } finally { await f.quarantine(); }
});

test("pending export quota does not delay owner suspension or terminal deletion", skipped, async () => {
  const f = await fixture();
  try {
    await f.customerExport();
    assert.equal((await f.issue("suspend")).accountVersion, 2);
    assert.equal((await f.issue("delete")).accountVersion, 3);
    const [user] = await db!.select().from(customerUsers).where(eq(customerUsers.id, f.user.id)); assert.equal(user.status, "deleted");
    assert.equal((await db!.select().from(customerSessions).where(eq(customerSessions.userId, f.user.id))).length, 0);
  } finally { await f.quarantine(); }
});

test("export command-history snapshot contains only the most recent one hundred commands", skipped, async () => {
  const f = await fixture();
  try {
    const history = Array.from({ length: 120 }, (_, index) => {
      const command: AccountCommand = { version: 1, commandId: randomUUID(), userId: f.user.id, accountVersion: index + 1, action: index % 2 ? "restore" : "suspend", issuedAt: new Date(f.now().getTime() - (120 - index) * 1000).toISOString() };
      return { ...command, issuedAt: new Date(command.issuedAt), idempotencyKey: randomUUID(), command };
    });
    await db!.insert(commands).values(history);
    await db!.insert(deliveries).values(history.flatMap(row => ["course", "community"].map(receiver => ({ commandId: row.commandId, receiver, status: "acknowledged", acknowledgedAt: f.now() }))));
    await db!.update(customerUsers).set({ accountVersion: 120 }).where(eq(customerUsers.id, f.user.id));
    const requested = await f.customerExport(); assert.equal(requested.accountVersion, 121);
    const [snapshot] = await db!.select().from(exports).where(eq(exports.commandId, requested.commandId));
    const exportedHistory: unknown = snapshot.frontendData?.recentCommands;
    assert.equal(snapshot.frontendData?.recentCommandLimit, 100);
    assert.ok(Array.isArray(exportedHistory)); assert.equal(exportedHistory.length, 100);
    const versions = exportedHistory.map((row: unknown) => {
      assert.ok(row && typeof row === "object" && "accountVersion" in row && typeof row.accountVersion === "number"); return row.accountVersion;
    }).sort((left, right) => left - right);
    assert.deepEqual(versions, Array.from({ length: 100 }, (_, index) => index + 22));
  } finally { await f.quarantine(); }
});

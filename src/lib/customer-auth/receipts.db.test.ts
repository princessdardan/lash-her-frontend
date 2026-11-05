import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/private-db/schema";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { withCustomerWriterContext } from "./context";
import { hashCustomerSession } from "./policy";
import { createCustomerAuthStore } from "./store";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) throw new Error("Customer receipt faults require isolated loopback PostgreSQL");
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 6 }) : null;
const db = pool ? drizzle({ client: pool, schema }) : null;
const skipped = { skip: !db && "set TEST_DATABASE_URL for real PostgreSQL receipt faults" };
const prefix = `receipt-${randomUUID()}`;
const store = createCustomerAuthStore(() => db!);
after(async () => {
  if (db) {
    await db.delete(schema.customerUsers).where(like(schema.customerUsers.email, `${prefix}%`));
    await db.delete(schema.customerVerificationTokens).where(like(schema.customerVerificationTokens.identifier, `${prefix}%`));
  }
  await pool?.end();
});
async function user() { return withCustomerWriterContext(async () => store.adapter.createUser!({ id: randomUUID(), email: `${prefix}-${randomUUID()}@example.invalid`, emailVerified: null })); }
async function uncertain(work: () => unknown | Promise<unknown>) {
  await assert.rejects(withWriterOperationContext(() => withCustomerWriterContext(async () => { try { await work(); } catch { /* Auth.js catches adapter failures. */ } })), /WRITER_OPERATION_REQUIRES_REVIEW/u);
}
async function fault(table: string, event: string, body: string) {
  const name = `receipt_${randomUUID().replaceAll("-", "")}`;
  await pool!.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${body} END$$`);
  await pool!.query(`CREATE TRIGGER ${name} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  return async () => { await pool!.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`); await pool!.query(`DROP FUNCTION IF EXISTS public.${name}()`); };
}

test("verification persistence is physical before issuance and suppressed INSERT cannot masquerade as a receipt", skipped, async () => {
  const identifier = `${prefix}-proof@example.invalid`, token = hashCustomerSession(randomUUID());
  const cleanup = await fault("customer_verification_tokens", "BEFORE INSERT", `IF NEW.token='${token}' THEN RETURN NULL; END IF; RETURN NEW;`);
  try {
    await uncertain(() => store.adapter.createVerificationToken!({ identifier, token, expires: new Date(Date.now() + 900_000) }));
    assert.equal((await db!.select().from(schema.customerVerificationTokens).where(eq(schema.customerVerificationTokens.token, token))).length, 0);
  } finally { await cleanup(); }
});

test("session creation cannot issue a bearer receipt without an exact persisted session", skipped, async () => {
  const customer = await user(), sessionToken = randomUUID();
  const cleanup = await fault("customer_sessions", "BEFORE INSERT", `IF NEW.user_id='${customer.id}'::uuid THEN RETURN NULL; END IF; RETURN NEW;`);
  try {
    await uncertain(() => store.adapter.createSession!({ userId: customer.id, sessionToken, expires: new Date(Date.now() + 60_000) }));
    assert.equal((await db!.select().from(schema.customerSessions).where(eq(schema.customerSessions.userId, customer.id))).length, 0);
  } finally { await cleanup(); }
});

test("sign-out refuses success when the original database session survives its DELETE", skipped, async () => {
  const customer = await user(), sessionToken = randomUUID();
  await withCustomerWriterContext(async () => store.adapter.createSession!({ userId: customer.id, sessionToken, expires: new Date(Date.now() + 60_000) }));
  const cleanup = await fault("customer_sessions", "BEFORE DELETE", `IF OLD.user_id='${customer.id}'::uuid THEN RETURN NULL; END IF; RETURN OLD;`);
  try {
    await uncertain(() => store.adapter.deleteSession!(sessionToken));
    assert.ok(await store.adapter.getSessionAndUser!(sessionToken));
  } finally { await cleanup(); }
});

test("a proof reinserted after DELETE cannot produce a successful single-use consumption", skipped, async () => {
  const identifier = `${prefix}-consumption@example.invalid`, token = hashCustomerSession(randomUUID());
  await withCustomerWriterContext(async () => store.adapter.createVerificationToken!({ identifier, token, expires: new Date(Date.now() + 60_000) }));
  const cleanup = await fault("customer_verification_tokens", "AFTER DELETE", `IF OLD.token='${token}' THEN INSERT INTO customer_verification_tokens(token,identifier,expires) VALUES(OLD.token,OLD.identifier,OLD.expires); END IF; RETURN OLD;`);
  try {
    await uncertain(() => store.adapter.useVerificationToken!({ identifier, token }));
    assert.equal((await db!.select().from(schema.customerVerificationTokens).where(eq(schema.customerVerificationTokens.token, token))).length, 1);
  } finally { await cleanup(); }
  assert.ok(await withCustomerWriterContext(async () => store.adapter.useVerificationToken!({ identifier, token })));
  assert.equal(await withCustomerWriterContext(async () => store.adapter.useVerificationToken!({ identifier, token })), null);
});

test("provider ownership and verified-email changes require a persisted matching provider link", skipped, async () => {
  const customer = await user(), providerAccountId = randomUUID();
  const cleanup = await fault("customer_provider_links", "BEFORE INSERT", `IF NEW.user_id='${customer.id}'::uuid THEN RETURN NULL; END IF; RETURN NEW;`);
  try {
    await uncertain(() => store.adapter.linkAccount!({ userId: customer.id, provider: "google", type: "oidc", providerAccountId }));
    assert.equal((await db!.select().from(schema.customerProviderLinks).where(eq(schema.customerProviderLinks.userId, customer.id))).length, 0);
    assert.equal((await store.adapter.getUser!(customer.id))?.emailVerified, null, "the failed linking transaction must roll back its verification change");
  } finally { await cleanup(); }
});

test("throttle success requires the physical counter to match its atomic upsert receipt", skipped, async () => {
  const key = hashCustomerSession(randomUUID());
  const cleanup = await fault("customer_auth_throttle", "AFTER INSERT OR UPDATE", `IF pg_trigger_depth()=1 AND NEW.key='${key}' THEN UPDATE customer_auth_throttle SET attempts=0 WHERE key=NEW.key; END IF; RETURN NEW;`);
  try {
    await uncertain(() => store.consumeThrottle(key, 5, 900));
    assert.equal((await db!.select().from(schema.customerAuthThrottle).where(eq(schema.customerAuthThrottle.key, key))).length, 0, "failed receipt rolls back the corrupted increment");
  } finally { await cleanup(); await db!.delete(schema.customerAuthThrottle).where(eq(schema.customerAuthThrottle.key, key)); }
});

test("Auth.js concurrent duplicate proof persistence shares the original receipt and never resurrects a consumed proof", skipped, async () => {
  const input = { identifier: `${prefix}-duplicate@example.invalid`, token: hashCustomerSession(randomUUID()), expires: new Date(Date.now() + 900_000) };
  await withCustomerWriterContext(async () => {
    const results = await Promise.all([store.adapter.createVerificationToken!(input), store.adapter.createVerificationToken!(input)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal((await db!.select().from(schema.customerVerificationTokens).where(eq(schema.customerVerificationTokens.token, input.token))).length, 1);
    // A callback may consume the proof while the original email request awaits
    // its provider. Auth.js's delayed duplicate adapter call cannot recreate it.
    await withCustomerWriterContext(async () => store.adapter.useVerificationToken!({ identifier: input.identifier, token: input.token }));
    assert.deepEqual(await store.adapter.createVerificationToken!(input), results[0]);
    assert.equal((await db!.select().from(schema.customerVerificationTokens).where(and(eq(schema.customerVerificationTokens.token, input.token), eq(schema.customerVerificationTokens.identifier, input.identifier)))).length, 0);
  });
});

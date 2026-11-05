import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test, { after, before } from "node:test";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import * as schema from "@/lib/private-db/schema";
import { customerProviderLinks, customerSessions, customerUsers } from "./schema";
import { createCustomerAuthStore } from "./store";
import { withCustomerWriterContext } from "./context";
import { createCustomerAuthHandler } from "./handler";
import { customerSessionCookieName, hashCustomerSession, type CustomerAuthConfiguration } from "./policy";

const url = process.env.TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url, max: 5 }) : null;
const database = pool ? drizzle({ client: pool, schema }) : null;
const skipped = { skip: !database && "set TEST_DATABASE_URL to run customer identity tests" };
const prefix = `customer-auth-test-${randomUUID()}`;
const email = (suffix: string) => `${prefix}-${suffix}@example.com`;
const config: CustomerAuthConfiguration = { origin: "https://customer.example.com", secret: "c".repeat(32), googleId: "test-google", googleSecret: "test-google-secret", resendKey: "test-resend", emailFrom: "account@example.com", secure: true };

before(async () => { if (url && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Customer auth DB tests require isolated loopback PostgreSQL"); });
after(async () => { await database?.delete(customerUsers).where(like(customerUsers.email, `${prefix}%`)); await pool?.end(); });

test("database sessions retain canonical UUIDs, hash bearer tokens, deny inactive users and never silently extend", skipped, async () => {
  const store = createCustomerAuthStore(() => database!);
  const adapter = store.adapter;
  await withCustomerWriterContext(async () => {
    const user = await adapter.createUser!({ id: "provider-subject", email: email("session"), emailVerified: new Date(), name: "Customer", image: null });
    assert.match(user.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    assert.notEqual(user.id, "provider-subject");
    const sessionToken = randomUUID();
    const expires = new Date(Date.now() + 60_000);
    await adapter.createSession!({ userId: user.id, sessionToken, expires });
    const [stored] = await database!.select().from(customerSessions).where(eq(customerSessions.userId, user.id));
    assert.equal(stored.tokenHash, hashCustomerSession(sessionToken));
    assert.equal(Object.values(stored).includes(sessionToken), false);
    assert.equal((await adapter.getSessionAndUser!(sessionToken))?.user.id, user.id);
    await adapter.updateSession!({ sessionToken, expires: new Date(Date.now() + 90_000) });
    assert.equal((await adapter.getSessionAndUser!(sessionToken))?.session.expires.getTime(), expires.getTime());
    await database!.update(customerUsers).set({ status: "suspended" }).where(eq(customerUsers.id, user.id));
    assert.equal(await adapter.getSessionAndUser!(sessionToken), null);
    await assert.rejects(async () => adapter.createSession!({ userId: user.id, sessionToken: randomUUID(), expires }));
    await database!.update(customerUsers).set({ status: "active" }).where(eq(customerUsers.id, user.id));
    await adapter.deleteSession!(sessionToken);
    assert.equal(await adapter.getSessionAndUser!(sessionToken), null);
  });
  await assert.rejects(async () => adapter.createVerificationToken!({ identifier: email("unguarded"), token: randomUUID(), expires: new Date() }), /REQUIRES_ADMISSION/u);
});

test("email token consumption is atomic across concurrent callbacks, bounded and expired proofs are denied", skipped, async () => {
  const store = createCustomerAuthStore(() => database!);
  await withCustomerWriterContext(async () => {
    const identifier = email("token");
    const token = randomUUID();
    const stored = await store.adapter.createVerificationToken!({ identifier, token, expires: new Date(Date.now() + 86_400_000) });
    assert.ok(stored!.expires.getTime() <= Date.now() + 900_000);
    assert.equal(await store.adapter.useVerificationToken!({ identifier: email("wrong-account"), token }), null);
    const used = await Promise.all(Array.from({ length: 5 }, () => store.adapter.useVerificationToken!({ identifier, token })));
    assert.equal(used.filter(Boolean).length, 1);
    const expired = randomUUID();
    await store.adapter.createVerificationToken!({ identifier, token: expired, expires: new Date(Date.now() - 1) });
    assert.equal(await store.adapter.useVerificationToken!({ identifier, token: expired }), null);
  });
});

test("provider identities are uniquely owned and provider credentials are discarded", skipped, async () => {
  const adapter = createCustomerAuthStore(() => database!).adapter;
  await withCustomerWriterContext(async () => {
    const first = await adapter.createUser!({ id: randomUUID(), email: email("first"), emailVerified: null });
    const second = await adapter.createUser!({ id: randomUUID(), email: email("second"), emailVerified: null });
    const providerAccountId = randomUUID();
    await adapter.linkAccount!({ userId: first.id, provider: "google", type: "oidc", providerAccountId, access_token: "must-not-be-stored", refresh_token: "must-not-be-stored" });
    assert.equal((await adapter.getUserByAccount!({ provider: "google", providerAccountId }))?.id, first.id);
    const [stored] = await database!.select().from(customerProviderLinks).where(eq(customerProviderLinks.userId, first.id));
    assert.equal(JSON.stringify(stored).includes("must-not-be-stored"), false);
    await assert.rejects(async () => adapter.linkAccount!({ userId: second.id, provider: "google", type: "oidc", providerAccountId }));
    await assert.rejects(async () => adapter.updateUser!({ id: first.id, email: second.email }));
    assert.ok((await adapter.getUser!(first.id))?.emailVerified);
  });
});

test("durable throttle counters enforce concurrent limits and reopen only after expiry", skipped, async () => {
  let now = new Date();
  const store = createCustomerAuthStore(() => database!, () => now);
  await withCustomerWriterContext(async () => {
    const key = randomUUID();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => store.consumeThrottle(key, 5, 900)));
    assert.equal(outcomes.filter(Boolean).length, 5);
    now = new Date(now.getTime() + 900_001);
    assert.equal(await store.consumeThrottle(key, 5, 900), true);
  });
});

test("expired credential maintenance deletes at most one bounded batch per throttle call", skipped, async () => {
  const store = createCustomerAuthStore(() => database!);
  const keyPrefix = `${prefix}-expired-`;
  await database!.insert(schema.customerAuthThrottle).values(Array.from({ length: 250 }, (_, index) => ({
    key: `${keyPrefix}${index}`, attempts: 1, resetsAt: new Date(0),
  })));
  const activeKey = `${prefix}-active`;
  await database!.insert(schema.customerAuthThrottle).values({ key: activeKey, attempts: 100, resetsAt: new Date(Date.now() - 1) });
  try {
    assert.equal(await withCustomerWriterContext(async () => store.consumeThrottle(activeKey, 5, 900)), true,
      "an expired selected bucket resets even when older rows consume the cleanup batch");
    const retained = await database!.select().from(schema.customerAuthThrottle).where(like(schema.customerAuthThrottle.key, `${keyPrefix}%`));
    assert.equal(retained.length, 150);
  } finally { await database!.delete(schema.customerAuthThrottle).where(like(schema.customerAuthThrottle.key, `${prefix}%`)); }
});

test("actual Auth.js email flow signs in once, strips secrets, isolates admin cookies and revokes on suspension", skipped, async () => {
  const store = createCustomerAuthStore(() => database!);
  const handler = createCustomerAuthHandler({ configuration: () => config, store: () => store, run: async (_kind, work) => work() });
  const get = (path: string, cookie = "") => handler(new NextRequest(`${config.origin}/api/customer-auth${path}`, { headers: { cookie } }));
  const originalFetch = globalThis.fetch;
  let verificationUrl = "";
  const originalEnv = process.env.APP_ENV;
  process.env.APP_ENV = "local";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    const body = JSON.parse(String(init?.body));
    verificationUrl = body.text.split("\n\n")[1];
    const tokenHash = hashCustomerSession(new URL(verificationUrl).searchParams.get("token")! + config.secret);
    const [durable] = await database!.select().from(schema.customerVerificationTokens).where(eq(schema.customerVerificationTokens.token, tokenHash));
    assert.ok(durable, "email must never leave before its proof is durable");
    return Response.json({ id: "synthetic-resend-receipt" });
  };
  try {
    const csrf = await get("/csrf");
    const { csrfToken } = await csrf.json();
    const cookie = csrf.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const requested = await handler(new NextRequest(`${config.origin}/api/customer-auth/signin/resend`, {
      method: "POST", headers: { origin: config.origin, cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: email("flow"), csrfToken, callbackUrl: "/academy" }),
    }));
    assert.equal(requested.status, 303);
    assert.ok(verificationUrl, "provider was called");
    const completed = await handler(new NextRequest(verificationUrl, { headers: { cookie } }));
    assert.equal(completed.status, 302);
    assert.equal(completed.headers.get("location"), `${config.origin}/academy`);
    const sessionCookie = completed.headers.getSetCookie().find(value => value.startsWith(`${customerSessionCookieName(true)}=`))!.split(";", 1)[0];
    assert.ok(sessionCookie);
    const session = await (await get("/session", sessionCookie)).json();
    assert.equal(session.user.email, email("flow"));
    assert.match(session.user.id, /^[a-f0-9-]{36}$/u);
    assert.deepEqual(Object.keys(session).sort(), ["expires", "user"]);
    assert.equal(JSON.stringify(session).includes("sessionToken"), false);
    const replay = await handler(new NextRequest(verificationUrl, { headers: { cookie } }));
    assert.equal(replay.headers.getSetCookie().some(value => value.startsWith(`${customerSessionCookieName(true)}=`) && !value.includes("Max-Age=0")), false);
    const rawToken = sessionCookie.split("=", 2)[1];
    assert.equal(await (await get("/session", `authjs.session-token=${rawToken}`)).json(), null);
    await database!.update(customerUsers).set({ status: "suspended" }).where(eq(customerUsers.id, session.user.id));
    assert.equal(await (await get("/session", sessionCookie)).json(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = originalEnv;
  }
});

test("actual Google OIDC callbacks require verified proof and a customer session before linking an existing email", skipped, async () => {
  const store = createCustomerAuthStore(() => database!);
  const handler = createCustomerAuthHandler({ configuration: () => config, store: () => store, run: async (_kind, work) => work() });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "customer-auth-test-key", alg: "RS256", use: "sig" };
  const originalFetch = globalThis.fetch;
  let nonce = "";
  let profileEmail = email("google-existing");
  let providerSubject = `${prefix}-google`;
  let verified = true;
  let wrongNonce = false;
  globalThis.fetch = async input => {
    const target = String(input);
    if (target.includes(".well-known/openid-configuration")) return Response.json({ issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (target === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] });
    assert.equal(target, "https://oauth2.googleapis.com/token", "unexpected provider request must never escape the fixture");
    const payload = { iss: "https://accounts.google.com", aud: config.googleId, sub: providerSubject, email: profileEmail, email_verified: verified, nonce: wrongNonce ? "wrong-nonce" : nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
    const encoded = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    return Response.json({ access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 300, id_token: `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}` });
  };
  const googleLogin = async (sessionCookie = "", wrongState = false) => {
    const csrfResponse = await handler(new NextRequest(`${config.origin}/api/customer-auth/csrf`));
    const { csrfToken } = await csrfResponse.json();
    const csrfCookies = csrfResponse.headers.getSetCookie().map(value => value.split(";", 1)[0]);
    const requestCookie = [...csrfCookies, sessionCookie].filter(Boolean).join("; ");
    const start = await handler(new NextRequest(`${config.origin}/api/customer-auth/signin/google`, { method: "POST", headers: { origin: config.origin, cookie: requestCookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken, callbackUrl: "/account/sign-in-methods" }) }));
    const authorization = new URL(start.headers.get("location")!);
    assert.equal(authorization.origin, "https://accounts.google.com");
    nonce = authorization.searchParams.get("nonce")!;
    assert.ok(nonce);
    const callbackCookies = Array.from(new Map([...csrfCookies, ...start.headers.getSetCookie().map(value => value.split(";", 1)[0]), sessionCookie].filter(Boolean).map(value => [value.split("=", 1)[0], value])).values()).join("; ");
    return handler(new NextRequest(`${config.origin}/api/customer-auth/callback/google?${new URLSearchParams({ code: "synthetic-code", state: wrongState ? "wrong-state" : authorization.searchParams.get("state")! })}`, { headers: { cookie: callbackCookies } }));
  };
  try {
    const existing = await withCustomerWriterContext(async () => store.adapter.createUser!({ id: randomUUID(), email: profileEmail, emailVerified: new Date() }));
    const denied = await googleLogin();
    assert.match(denied.headers.get("location")!, /OAuthAccountNotLinked/u);
    assert.equal(await store.adapter.getUserByAccount!({ provider: "google", providerAccountId: providerSubject }), null);
    const sessionToken = randomUUID();
    await withCustomerWriterContext(async () => store.adapter.createSession!({ sessionToken, userId: existing.id, expires: new Date(Date.now() + 60_000) }));
    const linked = await googleLogin(`${customerSessionCookieName(true)}=${sessionToken}`);
    assert.equal(linked.headers.get("location"), `${config.origin}/account/sign-in-methods`);
    assert.equal((await store.adapter.getUserByAccount!({ provider: "google", providerAccountId: providerSubject }))?.id, existing.id);
    // A later Google sign-in reuses the immutable frontend UUID.
    const signedIn = await googleLogin();
    assert.equal(signedIn.headers.get("location"), `${config.origin}/account/sign-in-methods`);
    const linkedSessionCookie = signedIn.headers.getSetCookie().find(value => value.startsWith(`${customerSessionCookieName(true)}=`))!.split(";", 1)[0];
    const linkedSession = await store.adapter.getSessionAndUser!(linkedSessionCookie.split("=", 2)[1]);
    assert.equal(linkedSession?.user.id, existing.id);
    const other = await withCustomerWriterContext(async () => store.adapter.createUser!({ id: randomUUID(), email: email("google-other"), emailVerified: new Date() }));
    const otherSessionToken = randomUUID();
    await withCustomerWriterContext(async () => store.adapter.createSession!({ sessionToken: otherSessionToken, userId: other.id, expires: new Date(Date.now() + 60_000) }));
    const takeover = await googleLogin(`${customerSessionCookieName(true)}=${otherSessionToken}`);
    assert.match(takeover.headers.get("location")!, /OAuthAccountNotLinked/u);
    assert.equal((await store.adapter.getUserByAccount!({ provider: "google", providerAccountId: providerSubject }))?.id, existing.id);
    profileEmail = email("google-unverified"); providerSubject = `${prefix}-unverified`; verified = false;
    const unverified = await googleLogin();
    assert.match(unverified.headers.get("location")!, /AccessDenied/u);
    assert.equal(await store.adapter.getUserByEmail!(profileEmail), null);
    verified = true;
    const invalidState = await googleLogin("", true);
    assert.notEqual(invalidState.headers.get("location"), `${config.origin}/account/sign-in-methods`);
    assert.equal(await store.adapter.getUserByEmail!(profileEmail), null);
    wrongNonce = true;
    const invalidNonce = await googleLogin();
    assert.notEqual(invalidNonce.headers.get("location"), `${config.origin}/account/sign-in-methods`);
    assert.equal(await store.adapter.getUserByEmail!(profileEmail), null);
  } finally { globalThis.fetch = originalFetch; }
});

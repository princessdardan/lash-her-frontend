// Child of the owned identity launcher only. Synthetic providers and loopback
// TLS/SCRAM PostgreSQL; no configured URL or external connection is accepted.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { frontendWriterInventory } from "../frontend-writer-inventory.mjs";
import { changeFrontendAdmission, observeFrontendDrain, reconcileFrontendOperation } from "../frontend-admission.mjs";

let phase = "configuration";
const completedChecks = [];
async function main() {
  assert.equal(process.env.FRONTEND_IDENTITY_OWNED_TEST, "true");
  const port = Number(process.env.OWNED_RECONCILIATION_PORT), password = process.env.OWNED_RECONCILIATION_PASSWORD;
  const major = Number(process.env.OWNED_RECONCILIATION_MAJOR);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.ok(/^owned-[a-f0-9-]{36}$/u.test(password ?? "")); assert.ok([16, 18].includes(major));
  const target = { environment: "staging", host: "127.0.0.1", port, database: "frontend_admission_owned",
    user: "frontend_admission_protocol", serverMajor: major, targetSha256: "a".repeat(64) };
  const url = `postgresql://${target.user}:${password}@127.0.0.1:${port}/${target.database}?sslmode=verify-full`;
  const origin = "https://customer.example.invalid", secret = "owned-customer-auth-fixture-secret-32";
  const { VERCEL_PROJECT_BINDINGS } = await import("../../../src/lib/env/application-environment.mjs");
  Object.assign(process.env, {
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify(target), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64), VERCEL_GIT_COMMIT_SHA: "c".repeat(40),
    APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    CUSTOMER_AUTH_ENABLED: "true", INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true", CUSTOMER_ACCOUNT_LIFECYCLE_ENABLED: "true",
    AUTH_URL: origin, AUTH_SECRET: "owned-admin-auth-fixture-distinct-secret-32", AUTH_TRUST_HOST: "true",
    AUTH_GOOGLE_ID: "owned-admin-google-client", AUTH_GOOGLE_SECRET: "owned-admin-google-fixture-secret",
    CUSTOMER_ACCOUNT_LIFECYCLE_RECOVERY_ENABLED: "true", CRON_SECRET: "owned-identity-lifecycle-cron-secret-32",
    API_GATEWAY_STAGING_ORIGIN: "https://gateway.owned.invalid",
    COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: "owned-course-lifecycle-fixture-distinct-key-32",
    COMMUNITY_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET: "owned-community-lifecycle-fixture-distinct-key-32",
    VERCEL_OIDC_TOKEN: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.owned`,
    CUSTOMER_AUTH_URL: origin, CUSTOMER_AUTH_SECRET: secret, CUSTOMER_AUTH_GOOGLE_ID: "owned-google-client",
    CUSTOMER_AUTH_GOOGLE_SECRET: "owned-google-secret", CUSTOMER_AUTH_RESEND_KEY: "owned-resend-key", CUSTOMER_AUTH_EMAIL_FROM: "owned@example.invalid",
    STAGING_EMAIL_RECIPIENT_ALLOWLIST: "owned@example.invalid", NEXT_PUBLIC_SANITY_PROJECT_ID: "test-project", NEXT_PUBLIC_SANITY_DATASET: "test-dataset",
  });
  // Next installs this before loading its request storage. Use its real storage
  // implementation for exported account routes, without claiming native-server
  // or browser transport/cookie certification.
  globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
  const { NextRequest } = await import("next/server");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store.js");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const operator = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin", password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } });
  await operator.connect();
  const connections = [operator], requests = [], checks = completedChecks, evidence = [], findings = [], nativeFetch = globalThis.fetch;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const sourceBefore = frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url)));
  let server, closePool, gate, providerMode = "success", verificationUrl, providerCalls = [], unexpectedFetches = 0, logCount = 0;
  let expectedLifecycleCommand, lifecycleMode = "success", adminDiagnostic;
  const diagnosticLogTypes = [];
  const lifecycleSeen = new Map();
  let nonce, googleEmail = "owned@example.invalid", googleSubject = "owned-google-subject", invariantFailure;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "owned-identity-key", alg: "RS256", use: "sig" };
  console.log = console.warn = console.error = (...args) => {
    logCount++;
    for (const value of args) {
      if (typeof value === "string") diagnosticLogTypes.push(...["MissingSecret", "UntrustedHost", "MissingAdapter", "InvalidCallbackUrl", "JWTSessionError", "SessionTokenError", "UnsupportedStrategy", "InvalidProvider", "Configuration", "AccessDenied", "Error", "warn"].filter(name => value.includes(name)));
      else if (value && typeof value === "object") diagnosticLogTypes.push(...[value.name, value.type, value.code, value.cause?.err?.name, value.cause?.err?.code].filter(v => typeof v === "string" && /^[A-Z_a-z]+$/u.test(v)));
    }
  };
  try {
    let epoch = (await operator.query("SELECT epoch::text FROM frontend_admission.control")).rows[0].epoch;
    const change = async (enabled, recovery = false) => { epoch = (await changeFrontendAdmission(operator, target, epoch, { newWork: enabled, recovery })).epoch; };
    const drain = () => observeFrontendDrain(operator, target, epoch);
    const operations = async () => (await operator.query("SELECT id,kind,state FROM frontend_admission.operations ORDER BY started_at,id")).rows;
    const since = async before => (await operations()).filter(row => !before.some(old => old.id === row.id));
    const entries = async (before, states, kinds = states.map(() => "new-work")) => { const rows = await since(before); assert.deepEqual(rows.map(row => row.state), states); assert.deepEqual(rows.map(row => row.kind), kinds); return rows; };
    const counts = async () => {
      const result = {};
      for (const table of ["customer_users", "customer_provider_links", "customer_sessions", "customer_verification_tokens", "customer_auth_throttle", "customer_account_commands", "customer_account_deliveries", "customer_account_exports", "customer_account_preferences", "admin_users"])
        result[table] = (await operator.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count;
      return result;
    };
    const fingerprint = async () => {
      const result = {};
      for (const table of ["customer_users", "customer_provider_links", "customer_sessions", "customer_verification_tokens", "customer_auth_throttle", "customer_account_commands", "customer_account_deliveries", "customer_account_exports", "customer_account_preferences", "admin_users"])
        result[table] = (await operator.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return createHash("sha256").update(JSON.stringify(result)).digest("hex");
    };
    const reconcile = async () => {
      await Promise.allSettled(requests); await change(false);
      const rows = await operations(), unresolved = rows.filter(row => row.state !== "completed");
      if (unresolved.length) { assert.equal((await drain()).ledgerDrained, false); await assert.rejects(change(true)); }
      const digest = createHash("sha256").update(JSON.stringify({ operations: rows, business: await fingerprint(), providerCalls })).digest("hex");
      evidence.push(digest);
      for (const row of unresolved) await reconcileFrontendOperation(operator, target, epoch, row.id, digest);
      assert.equal((await drain()).ledgerDrained, true);
      assert.equal((await drain()).historicalWritersFenced, false); assert.equal((await drain()).migrationAuthorized, false);
    };
    const reset = async () => { await operator.query("TRUNCATE customer_users,customer_auth_throttle,customer_verification_tokens,admin_users CASCADE");
      providerCalls = []; providerMode = "success"; verificationUrl = undefined; invariantFailure = undefined; gate = undefined;
      expectedLifecycleCommand = undefined; lifecycleMode = "success"; lifecycleSeen.clear(); };
    const until = async predicate => { for (let n = 0; n < 250; n++) { if (await predicate()) return; await delay(20); } throw new Error("OWNED_IDENTITY_OBSERVATION_TIMEOUT"); };
    const hold = stage => {
      let entered, release; const started = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
      gate = { stage, entered, release, wait, used: false };
      return { entered: () => Promise.race([started, delay(8000, undefined, { ref: false }).then(() => { throw new Error("OWNED_IDENTITY_PROVIDER_TIMEOUT"); })]), release };
    };
    const connect = async () => { const client = new Client({ host: target.host, port, database: target.database, user: "frontend_test_admin", password,
      ssl: { rejectUnauthorized: true, ca: readFileSync(process.env.NODE_EXTRA_CA_CERTS, "utf8") } }); connections.push(client); await client.connect(); return client; };
    const killLedger = async () => { const sessions = (await operator.query("SELECT pid FROM pg_stat_activity WHERE usename=$1 AND application_name='lash-her-frontend-writer-admission'", [target.user])).rows;
      assert.equal(sessions.length, 1); await operator.query("SELECT pg_terminate_backend($1,1000)", [sessions[0].pid]); await delay(25); };
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init), selected = new URL(req.url);
      if (server && selected.origin === `http://127.0.0.1:${server.address().port}`) return nativeFetch(req);
      let stage;
      if (selected.href === "https://api.resend.com/emails" && req.method === "POST") stage = "resend";
      else if (selected.href === "https://accounts.google.com/.well-known/openid-configuration") stage = "google-discovery";
      else if (selected.href === "https://www.googleapis.com/oauth2/v3/certs") stage = "google-keys";
      else if (selected.href === "https://oauth2.googleapis.com/token" && req.method === "POST") stage = "google-token";
      else if (selected.origin === "https://gateway.owned.invalid" && /^\/(course|community)\/v1\/internal\/accounts\/commands$/u.test(selected.pathname) && req.method === "POST") stage = `lifecycle-${selected.pathname.split("/")[1]}`;
      else { unexpectedFetches++; throw new Error("OWNED_IDENTITY_UNEXPECTED_PROVIDER"); }
      try {
        const active = (await operations()).filter(row => row.state === "active");
        assert.equal(active.length, 1); assert.equal(active[0].kind, stage.startsWith("lifecycle-") ? "recovery" : "new-work");
        const sessions = (await operator.query("SELECT ssl FROM pg_stat_ssl JOIN pg_stat_activity USING(pid) WHERE usename=$1", [target.user])).rows;
        assert.ok(sessions.length >= 2 && sessions.every(row => row.ssl));
      } catch (error) { invariantFailure = error; throw error; }
      if (stage.startsWith("lifecycle-")) {
        const receiver = stage.slice("lifecycle-".length), command = await req.json();
        assert.deepEqual(command, expectedLifecycleCommand);
        assert.equal(req.headers.get("x-idempotency-key"), command.commandId);
        assert.equal(req.headers.get("x-lash-workload-token"), process.env.VERCEL_OIDC_TOKEN);
        const bearer = req.headers.get("authorization").slice(7), parts = bearer.split(".");
        const key = process.env[`${receiver.toUpperCase()}_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET`];
        assert.equal(parts[2], createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest("base64url"));
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        assert.equal(claims.aud, `lash-her-${receiver}-api:account-lifecycle`); assert.equal(claims.sub, "frontend-account-lifecycle");
        assert.equal(claims.exp - claims.iat, 300);
        const identity = `${receiver}:${command.commandId}`, digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
        const previous = lifecycleSeen.get(identity); if (previous) assert.equal(previous, digest);
        lifecycleSeen.set(identity, digest);
        providerCalls.push({ stage, commandSha256: digest, method: req.method, path: selected.pathname });
        if (gate?.stage === stage && !gate.used) { gate.used = true; gate.entered(); await gate.wait; }
        if (lifecycleMode === "outage") return Response.json({ error: { code: "UNAVAILABLE", message: "owned-private-provider-detail" } }, { status: 500 });
        if (lifecycleMode === "missing-receipt") return Response.json({});
        return Response.json({ commandId: command.commandId, accountVersion: command.accountVersion, status: previous ? "duplicate" : "accepted" });
      }
      if (stage === "resend") {
        const body = await req.json(); assert.equal(body.to, "owned@example.invalid");
        verificationUrl = body.text.split("\n\n")[1];
        const token = new URL(verificationUrl).searchParams.get("token");
        const hash = createHash("sha256").update(token + secret).digest("hex");
        const durable = (await operator.query("SELECT identifier,expires FROM customer_verification_tokens WHERE token=$1", [hash])).rows;
        providerCalls.push({ stage, durableTokenBeforeProvider: durable.length === 1, method: req.method, path: selected.pathname });
      } else providerCalls.push({ stage, method: req.method, path: selected.pathname });
      if (gate?.stage === stage && !gate.used) { gate.used = true; gate.entered(); await gate.wait; }
      if (stage === "resend") return providerMode === "reject" ? Response.json({ error: "owned-private-provider-detail" }, { status: 500 }) : Response.json(providerMode === "missing-receipt" ? {} : { id: "owned-resend-receipt" });
      if (stage === "google-discovery") return Response.json({ issuer: "https://accounts.google.com", authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token", userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo", jwks_uri: "https://www.googleapis.com/oauth2/v3/certs", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
      if (stage === "google-keys") return Response.json({ keys: [jwk] });
      const payload = { iss: "https://accounts.google.com", aud: process.env.CUSTOMER_AUTH_GOOGLE_ID, sub: googleSubject, email: googleEmail, email_verified: true, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
      const encoded = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
      return Response.json({ access_token: "owned-unused-access-token", token_type: "Bearer", expires_in: 300, id_token: `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}` });
    };
    phase = "import-actual-exports";
    const auth = await import("../../../src/app/api/customer-auth/[...nextauth]/route.ts");
    const { POST: accountCommand } = await import("../../../src/app/api/account/commands/route.ts");
    const { POST: accountPreferences } = await import("../../../src/app/api/account/preferences/route.ts");
    const { POST: adminAccountCommand } = await import("../../../src/app/api/admin/customer-accounts/[userId]/commands/route.ts");
    const { GET: lifecycleCron } = await import("../../../src/app/api/cron/account-lifecycle/route.ts");
    const { encode, decode } = await import("next-auth/jwt");
    ({ closePrivateDbPool: closePool } = await import("../../../src/lib/private-db/client.ts"));
    server = createServer(async (incoming, outgoing) => {
      try {
        const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
        const body = Buffer.concat(chunks), headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
        // This bridge maps loopback transport onto one fixed synthetic HTTPS origin.
        headers.set("host", new URL(origin).host);
        const req = new NextRequest(`${origin}${incoming.url}`, { method: incoming.method, headers, ...(body.length ? { body } : {}) });
        let result;
        if (incoming.url.startsWith("/api/customer-auth/")) result = await auth[incoming.method](req);
        else if (incoming.url === "/api/cron/account-lifecycle") result = await lifecycleCron(req);
        else {
          const adminMatch = /^\/api\/admin\/customer-accounts\/([a-f0-9-]+)\/commands$/u.exec(incoming.url);
          assert.ok(adminMatch || ["/api/account/commands", "/api/account/preferences"].includes(incoming.url));
          const route = adminMatch ? request => adminAccountCommand(request, { params: Promise.resolve({ userId: adminMatch[1] }) }) : incoming.url === "/api/account/commands" ? accountCommand : accountPreferences;
          const store = createRequestStoreForAPI(req, new URL(req.url));
          result = await workAsyncStorage.run({ route: incoming.url, isStaticGeneration: false }, () => workUnitAsyncStorage.run(store, async () => {
            if (adminMatch) {
              const { auth: readAdminAuth } = await import("../../../src/auth.ts");
              const session = await readAdminAuth();
              adminDiagnostic = { present: !!session, hasSubject: typeof session?.user?.providerUserId === "string", verified: session?.user?.isEmailVerified === true,
                fresh: typeof session?.user?.authenticatedAt === "number" && Date.now() / 1000 - session.user.authenticatedAt < 300,
                cookieNames: headers.get("cookie")?.split("; ").map(pair => pair.split("=", 1)[0]) };
            }
            return route(req);
          }));
        }
        for (const [name, value] of result.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
        outgoing.setHeader("set-cookie", result.headers.getSetCookie()); outgoing.writeHead(result.status); outgoing.end(await result.text());
      } catch { outgoing.writeHead(500); outgoing.end("OWNED_IDENTITY_BRIDGE_FAILED"); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const perform = async (path, { method = "GET", cookie = "", body, requestOrigin = origin, clientIp = "198.51.100.1", authorization } = {}) => {
      const headers = { host: new URL(origin).host, cookie, ...(clientIp ? { "x-vercel-forwarded-for": clientIp } : {}) };
      if (authorization) headers.authorization = authorization;
      if (method === "POST") { headers.origin = requestOrigin; headers["content-type"] = body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json"; }
      const response = await nativeFetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers, redirect: "manual", ...(body === undefined ? {} : { body: body instanceof URLSearchParams ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      const text = await response.text(); assert.equal(text.includes(password), false); assert.equal(text.includes("owned-private-provider-detail"), false);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
      return { status: response.status, headers: response.headers, text };
    };
    const request = (path, options) => { const pending = perform(path, options); requests.push(pending); pending.catch(() => {}); return pending; };
    const cookieJoin = (...sets) => Array.from(new Map(sets.flat().filter(Boolean).map(value => { const pair = value.split(";", 1)[0]; return [pair.split("=", 1)[0], pair]; })).values()).join("; ");
    const csrf = async () => { const result = await request("/api/customer-auth/csrf"); assert.equal(result.status, 200); return { token: JSON.parse(result.text).csrfToken, cookie: cookieJoin(result.headers.getSetCookie()) }; };
    const emailStart = (proof, cookie = "") => request("/api/customer-auth/signin/resend", { method: "POST", cookie: cookieJoin(proof.cookie, cookie), body: new URLSearchParams({ email: "owned@example.invalid", csrfToken: proof.token, callbackUrl: "/academy" }) });
    const callback = (proof, cookie = "") => request(new URL(verificationUrl).pathname + new URL(verificationUrl).search, { cookie: cookieJoin(proof.cookie, cookie) });
    const sessionCookie = result => result.headers.getSetCookie().find(value => value.startsWith("__Host-lash-customer.session-token=") && !value.includes("Max-Age=0"))?.split(";", 1)[0];
    const issueEmail = async () => { const proof = await csrf(); assert.equal((await emailStart(proof)).status, 303); assert.ok(verificationUrl); return proof; };
    const seedAccount = async () => { const user = (await operator.query("INSERT INTO customer_users(email,name,email_verified) VALUES('owned@example.invalid','Owned fixture',now()) RETURNING id")).rows[0];
      const token = randomUUID(), tokenHash = createHash("sha256").update(token).digest("hex");
      await operator.query("INSERT INTO customer_sessions(token_hash,user_id,expires) VALUES($1,$2,now()+interval '1 day')", [tokenHash, user.id]);
      return { id: user.id, tokenHash, cookie: `__Host-lash-customer.session-token=${token}` }; };
    const account = (path, fixture, body) => request(`/api/account/${path}`, { method: "POST", cookie: fixture.cookie, body });
    const seedAdmin = async (role = "owner", ageSeconds = 0) => {
      const id = randomUUID(), providerUserId = `owned-admin-${id}`, email = `${id}@example.invalid`;
      await operator.query("INSERT INTO admin_users(id,provider_user_id,email,email_normalized,display_name,role,status) VALUES($1,$2,$3,$3,'Owned admin fixture',$4,'active')", [id, providerUserId, email, role]);
      const token = await encode({ secret: process.env.AUTH_SECRET, salt: "__Secure-authjs.session-token", maxAge: 3600,
        token: { sub: providerUserId, providerUserId, email, name: "Owned admin fixture", googleEmailVerified: true, adminAuthenticatedAt: Math.floor(Date.now() / 1000) - ageSeconds } });
      const decoded = await decode({ token, secret: process.env.AUTH_SECRET, salt: "__Secure-authjs.session-token" });
      assert.equal(decoded.providerUserId, providerUserId); assert.equal(decoded.googleEmailVerified, true);
      return { id, cookie: `__Secure-authjs.session-token=${token}` };
    };
    const adminCommand = (fixture, customer, action = "suspend") => request(`/api/admin/customer-accounts/${customer.id}/commands`, { method: "POST", cookie: fixture.cookie, body: { action, idempotencyKey: randomUUID() } });
    const recovery = (authorized = true) => request("/api/cron/account-lifecycle", { authorization: authorized ? `Bearer ${process.env.CRON_SECRET}` : undefined });
    const loadLifecycleCommand = async () => {
      const rows = (await operator.query("SELECT command FROM customer_account_commands ORDER BY account_version")).rows;
      assert.equal(rows.length, 1); expectedLifecycleCommand = rows[0].command;
      assert.equal((await counts()).customer_account_deliveries, 2); return expectedLifecycleCommand;
    };


    phase = "closed-auth-routes";
    await reset(); await seedAccount();
    await operator.query("UPDATE customer_sessions SET expires=now()-interval '1 day'");
    await operator.query("INSERT INTO customer_verification_tokens(token,identifier,expires) VALUES('owned-expired-token','owned@example.invalid',now()-interval '1 day')");
    await operator.query("INSERT INTO customer_auth_throttle(key,attempts,resets_at) VALUES('owned-expired-throttle',99,now()-interval '1 day')");
    await change(false); let before = await operations(), beforeBusiness = await fingerprint();
    for (const path of ["/csrf", "/providers", "/session", "/callback/resend?email=owned%40example.invalid&token=owned", "/callback/google?code=owned&state=owned"])
      assert.equal((await request(`/api/customer-auth${path}`)).status, 503, path);
    for (const path of ["/signin/resend", "/signin/google", "/signout"])
      assert.equal((await request(`/api/customer-auth${path}`, { method: "POST", body: new URLSearchParams({ email: "owned@example.invalid", csrfToken: "owned" }) })).status, 503);
    await entries(before, []); assert.equal(await fingerprint(), beforeBusiness); assert.deepEqual(providerCalls, []);
    assert.equal((await request("/api/customer-auth/callback/resend?token=owned", { method: "HEAD" })).status, 405);
    checks.push("actual-auth-exports-closed-before-callback-throttle-cleanup-token-session-or-provider-writes-and-head-never-consumes");

    phase = "auth-origin-csrf-and-email-success";
    await reset(); await change(true); before = await operations();
    assert.equal((await request("/api/customer-auth/signin/resend", { method: "POST", requestOrigin: "https://other.invalid", body: new URLSearchParams() })).status, 403);
    await entries(before, []);
    const proof = await csrf(); before = await operations();
    assert.equal((await emailStart(proof)).status, 303); await entries(before, ["completed"]);
    assert.deepEqual(providerCalls, [{ stage: "resend", durableTokenBeforeProvider: true, method: "POST", path: "/emails" }]);
    let rows = await counts(); assert.equal(rows.customer_auth_throttle, 2); assert.equal(rows.customer_verification_tokens, 1);
    checks.push("actual-auth-email-proof-durable-before-synthetic-resend-and-whole-new-work-completes-on-real-tls-database");
    await change(false); before = await operations(); beforeBusiness = await fingerprint();
    assert.equal((await callback(proof)).status, 503); await entries(before, []); assert.equal(await fingerprint(), beforeBusiness);
    checks.push("closed-real-single-use-callback-retains-its-proof-before-throttle-and-consumption");
    await change(true); before = await operations();
    const signedIn = await callback(proof); assert.equal(signedIn.headers.get("location"), `${origin}/academy`);
    const activeCookie = sessionCookie(signedIn); assert.ok(activeCookie); await entries(before, ["completed"]);
    const set = signedIn.headers.getSetCookie().find(value => value.startsWith("__Host-lash-customer.session-token="));
    assert.match(set, /HttpOnly/u); assert.match(set, /Secure/u); assert.match(set, /SameSite=Lax/u);
    rows = await counts(); assert.equal(rows.customer_users, 1); assert.equal(rows.customer_sessions, 1); assert.equal(rows.customer_verification_tokens, 0);
    const firstSession = JSON.parse((await request("/api/customer-auth/session", { cookie: activeCookie })).text);
    assert.deepEqual(Object.keys(firstSession).sort(), ["expires", "user"]); assert.equal(firstSession.user.email, "owned@example.invalid");
    assert.equal(JSON.stringify(firstSession).includes("sessionToken"), false);
    before = await operations(); const replay = await callback(proof); assert.equal(sessionCookie(replay), undefined); await entries(before, ["completed"]);
    assert.equal((await counts()).customer_sessions, 1); assert.equal(providerCalls.length, 1);
    assert.equal(JSON.parse((await request("/api/customer-auth/session", { cookie: activeCookie.replace("__Host-lash-customer", "authjs") })).text), null);
    before = await operations();
    assert.equal((await request("/api/customer-auth/signout", { method: "POST", cookie: cookieJoin(proof.cookie, activeCookie), body: new URLSearchParams({ csrfToken: proof.token }) })).status, 302);
    await entries(before, ["completed"]); assert.equal((await counts()).customer_sessions, 0);
    await reconcile(); checks.push("actual-auth-email-callback-single-use-canonical-session-private-read-and-signout-accounted-with-admin-cookie-isolation");

    for (const mode of ["reject", "missing-receipt"]) {
      phase = `auth-email-${mode}`; await reset(); await change(true); const proof = await csrf(); providerMode = mode; before = await operations();
      assert.equal((await emailStart(proof)).status, 503); await entries(before, ["uncertain"]);
      assert.equal(providerCalls.length, 1); assert.equal((await counts()).customer_verification_tokens, 1);
      await change(false); assert.equal((await emailStart(proof)).status, 503); assert.equal(providerCalls.length, 1);
      await reconcile(); checks.push(`actual-auth-email-${mode}-retains-proof-and-uncertainty-without-provider-replay`);
    }

    for (const fault of ["close", "ledger-death"]) {
      phase = `auth-delayed-resend-${fault}`; await reset(); await change(true); const proof = await csrf(); before = await operations();
      const held = hold("resend"), pending = emailStart(proof);
      try {
        await held.entered(); await change(false); await entries(before, ["active"]); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await emailStart(proof)).status, 503); assert.equal(providerCalls.length, 1);
        if (fault === "ledger-death") await killLedger();
      } finally { held.release(); }
      assert.equal((await pending).status, fault === "close" ? 303 : 503); gate = undefined;
      await entries(before, [fault === "close" ? "completed" : "active"]); assert.equal(providerCalls.length, 1);
      assert.equal((await counts()).customer_verification_tokens, 1); await reconcile();
      checks.push(`actual-auth-delayed-resend-${fault}-whole-entry-stays-unresolved-until-provider-settles-no-automatic-replay`);
    }

    for (const point of ["begin", "finish"]) {
      phase = `auth-${point}-acknowledgement-loss`; await reset(); await change(true); const proof = await csrf(); before = await operations();
      const originalQuery = Client.prototype.query; let intercepted = false;
      Client.prototype.query = function(...args) {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        const result = Reflect.apply(originalQuery, this, args);
        if (!intercepted && text?.includes(`CALL frontend_admission.${point}_operation`)) {
          intercepted = true; return result.then(() => { throw new Error("OWNED_IDENTITY_LOST_ACKNOWLEDGEMENT"); });
        }
        return result;
      };
      let result;
      try { result = await emailStart(proof); } finally { Client.prototype.query = originalQuery; }
      assert.equal(intercepted, true); assert.equal(result.status, 503); await entries(before, [point === "begin" ? "active" : "completed"]);
      assert.equal(providerCalls.length, point === "begin" ? 0 : 1); await change(false);
      assert.equal((await emailStart(proof)).status, 503); assert.equal(providerCalls.length, point === "begin" ? 0 : 1);
      await reconcile(); checks.push(`actual-auth-${point}-lost-acknowledgement-preserves-original-receipt-and-never-replays`);
    }

    phase = "google-actual-export";
    await reset(); await change(true); const googleProof = await csrf(); before = await operations();
    const googleStart = await request("/api/customer-auth/signin/google", { method: "POST", cookie: googleProof.cookie, body: new URLSearchParams({ csrfToken: googleProof.token, callbackUrl: "/academy" }) });
    const authorization = new URL(googleStart.headers.get("location")); assert.equal(authorization.origin, "https://accounts.google.com");
    nonce = authorization.searchParams.get("nonce"); assert.ok(nonce); await entries(before, ["completed"]);
    const googleCookies = cookieJoin(googleProof.cookie, googleStart.headers.getSetCookie());
    const googlePath = `/api/customer-auth/callback/google?${new URLSearchParams({ code: "owned-synthetic-code", state: authorization.searchParams.get("state") })}`;
    await change(false); before = await operations(); beforeBusiness = await fingerprint(); const callsBefore = providerCalls.length;
    assert.equal((await request(googlePath, { cookie: googleCookies })).status, 503); await entries(before, []); assert.equal(await fingerprint(), beforeBusiness); assert.equal(providerCalls.length, callsBefore);
    await change(true); before = await operations();
    const googleComplete = await request(googlePath, { cookie: googleCookies }); assert.equal(googleComplete.headers.get("location"), `${origin}/academy`); assert.ok(sessionCookie(googleComplete)); await entries(before, ["completed"]);
    rows = await counts(); assert.equal(rows.customer_users, 1); assert.equal(rows.customer_provider_links, 1); assert.equal(rows.customer_sessions, 1);
    assert.equal(providerCalls.filter(row => row.stage === "google-token").length, 1); await reconcile();
    checks.push("actual-google-export-closed-before-token-exchange-and-positive-oidc-callback-owns-profile-link-and-session-through-ledger-settlement");

    for (const fault of ["close", "ledger-death"]) {
      phase = `auth-blocked-session-insert-${fault}`; await reset(); await change(true); const proof = await issueEmail(); before = await operations();
      const blocker = await connect(); await blocker.query("BEGIN"); await blocker.query("LOCK TABLE customer_sessions IN SHARE MODE");
      const pending = callback(proof);
      try {
        await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
        await change(false); await entries(before, ["active"]); assert.equal((await drain()).ledgerDrained, false);
        if (fault === "ledger-death") await killLedger();
      } finally { await blocker.query("ROLLBACK"); }
      const result = await pending; assert.equal(result.status, fault === "close" ? 302 : 503); await entries(before, [fault === "close" ? "completed" : "active"]);
      rows = await counts(); assert.equal(rows.customer_sessions, 1); assert.equal(rows.customer_verification_tokens, 0); assert.equal(providerCalls.length, 1);
      assert.equal((await callback(proof)).status, 503); assert.equal((await counts()).customer_sessions, 1);
      await reconcile(); checks.push(`actual-auth-blocked-session-insert-${fault}-retains-whole-entry-through-real-sql-without-reconsuming-proof`);
    }

    phase = "auth-committed-session-sql-acknowledgement-loss";
    await reset(); await change(true); const sqlProof = await issueEmail(); before = await operations();
    const nativeQuery = Client.prototype.query, sessionClients = new WeakSet(); let lostSessionCommit = false;
    Client.prototype.query = function(...args) {
      const text = (typeof args[0] === "string" ? args[0] : args[0]?.text)?.toLowerCase();
      const result = Reflect.apply(nativeQuery, this, args);
      if (this.connectionParameters.user === target.user && text?.includes('insert into "customer_sessions"')) sessionClients.add(this);
      if (!lostSessionCommit && text === "commit" && sessionClients.has(this)) {
        lostSessionCommit = true; return result.then(() => { throw new Error("OWNED_IDENTITY_SESSION_COMMIT_ACK_LOST"); });
      }
      return result;
    };
    let sessionCommitResult;
    try { sessionCommitResult = await callback(sqlProof); } finally { Client.prototype.query = nativeQuery; }
    assert.equal(lostSessionCommit, true); assert.equal(sessionCommitResult.status, 503); assert.equal(sessionCookie(sessionCommitResult), undefined);
    await entries(before, ["uncertain"]); assert.equal((await counts()).customer_sessions, 1); assert.equal((await counts()).customer_verification_tokens, 0);
    assert.equal(providerCalls.length, 1); await change(false); assert.equal((await callback(sqlProof)).status, 503);
    assert.equal((await counts()).customer_sessions, 1); await reconcile();
    checks.push("actual-auth-lost-session-sql-commit-ack-preserves-committed-session-and-consumed-proof-without-cookie-or-replay");

    // Fault observations below are not converted into a passing qualification.
    // Any missing durable receipt remains a concrete source finding for the
    // integration owner; this fixture does not edit application behavior.
    for (const table of ["customer_verification_tokens", "customer_sessions"]) {
      phase = `auth-missing-${table}-persistence`; await reset(); await change(true); let proof = await csrf();
      if (table === "customer_sessions") { assert.equal((await emailStart(proof)).status, 303); }
      await operator.query("CREATE OR REPLACE FUNCTION pg_temp.skip_owned_identity_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
      await operator.query(`CREATE TRIGGER owned_skip_identity_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_owned_identity_insert()`);
      before = await operations(); let result;
      try { result = table === "customer_sessions" ? await callback(proof) : await emailStart(proof); }
      finally { await operator.query(`DROP TRIGGER owned_skip_identity_insert ON ${table}`); }
      const current = await since(before), business = await counts();
      const unsafeEffect = !!sessionCookie(result) || table === "customer_verification_tokens" && providerCalls.length > 0;
      if (unsafeEffect || result.status !== 503 || current.length !== 1 || current[0].state !== "uncertain") {
        findings.push({ code: `MISSING_${table.toUpperCase()}_RECEIPT`, path: "src/lib/customer-auth/store.ts", table,
          responseStatus: result.status, operationStates: current.map(row => row.state), persistedRows: business[table], providerCalls: providerCalls.length,
          issuedSessionCookie: !!sessionCookie(result), durableTokenBeforeProvider: providerCalls.find(row => row.stage === "resend")?.durableTokenBeforeProvider });
      } else checks.push(`actual-auth-${table}-missing-persistence-refuses-and-retains-uncertainty`);
      await reconcile();
    }

    for (const mode of ["signout-suppressed", "token-restored-after-consumption", "google-link-suppressed", "throttle-reset-after-write"]) {
      phase = `auth-${mode}`; await reset(); await change(true);
      let proof = await csrf(), path, options, table, timing, event, statement;
      if (mode === "signout-suppressed") {
        const fixture = await seedAccount();
        path = "/api/customer-auth/signout";
        options = { method: "POST", cookie: cookieJoin(proof.cookie, fixture.cookie), body: new URLSearchParams({ csrfToken: proof.token }) };
        table = "customer_sessions"; timing = "BEFORE"; event = "DELETE"; statement = "RETURN NULL";
      } else if (mode === "token-restored-after-consumption") {
        assert.equal((await emailStart(proof)).status, 303);
        path = new URL(verificationUrl).pathname + new URL(verificationUrl).search; options = { cookie: proof.cookie };
        table = "customer_verification_tokens"; timing = "AFTER"; event = "DELETE";
        statement = "INSERT INTO customer_verification_tokens(token,identifier,expires) VALUES(OLD.token,OLD.identifier,OLD.expires); RETURN OLD";
      } else if (mode === "google-link-suppressed") {
        const start = await request("/api/customer-auth/signin/google", { method: "POST", cookie: proof.cookie, body: new URLSearchParams({ csrfToken: proof.token, callbackUrl: "/academy" }) });
        const authorization = new URL(start.headers.get("location")); nonce = authorization.searchParams.get("nonce");
        path = `/api/customer-auth/callback/google?${new URLSearchParams({ code: "owned-synthetic-code", state: authorization.searchParams.get("state") })}`;
        options = { cookie: cookieJoin(proof.cookie, start.headers.getSetCookie()) };
        table = "customer_provider_links"; timing = "BEFORE"; event = "INSERT"; statement = "RETURN NULL";
      } else {
        path = "/api/customer-auth/signin/resend";
        options = { method: "POST", cookie: proof.cookie, body: new URLSearchParams({ email: "owned@example.invalid", csrfToken: proof.token }) };
        table = "customer_auth_throttle"; timing = "AFTER"; event = "INSERT OR UPDATE";
        statement = "IF pg_trigger_depth() = 1 THEN UPDATE customer_auth_throttle SET attempts=0 WHERE key=NEW.key; END IF; RETURN NEW";
      }
      await operator.query(`CREATE OR REPLACE FUNCTION pg_temp.fault_owned_identity_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${statement}; END $$`);
      await operator.query(`CREATE TRIGGER owned_fault_identity_receipt ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.fault_owned_identity_receipt()`);
      before = await operations(); let result;
      try { result = await request(path, options); }
      finally { await operator.query(`DROP TRIGGER owned_fault_identity_receipt ON ${table}`); }
      const current = await since(before), business = await counts();
      const unsafeEffect = !!sessionCookie(result) || ["token-restored-after-consumption", "google-link-suppressed"].includes(mode) && business.customer_sessions > 0 || mode === "throttle-reset-after-write" && providerCalls.length > 0;
      if (unsafeEffect || result.status !== 503 || current.length !== 1 || current[0].state !== "uncertain") {
        findings.push({ code: `AUTH_${mode.toUpperCase().replaceAll("-", "_")}_RECEIPT`, path: "src/lib/customer-auth/store.ts", table,
          responseStatus: result.status, operationStates: current.map(row => row.state), persistedRows: business[table], issuedSessionCookie: !!sessionCookie(result),
          tokenRows: business.customer_verification_tokens, sessionRows: business.customer_sessions, linkRows: business.customer_provider_links,
          throttleAttempts: mode === "throttle-reset-after-write" ? (await operator.query("SELECT attempts FROM customer_auth_throttle ORDER BY key")).rows.map(row => row.attempts) : undefined });
      } else checks.push(`actual-auth-${mode}-missing-or-mutated-persistence-refuses-with-whole-operation-uncertainty`);
      await reconcile();
    }

    phase = "account-closed-and-real-session";
    await reset(); const fixture = await seedAccount(); await change(false); before = await operations(); beforeBusiness = await fingerprint();
    assert.equal((await account("preferences", fixture, { learningUpdates: true })).status, 503);
    assert.equal((await account("commands", fixture, { action: "export", idempotencyKey: randomUUID() })).status, 503);
    await entries(before, []); assert.equal(await fingerprint(), beforeBusiness);
    await change(true); before = await operations();
    assert.equal((await account("preferences", { cookie: "authjs.session-token=owned-admin-cookie" }, { learningUpdates: true })).status, 401);
    await entries(before, []);
    assert.equal((await account("preferences", fixture, { learningUpdates: true })).status, 200); await entries(before, ["completed"]);
    assert.deepEqual((await operator.query("SELECT user_id,learning_updates FROM customer_account_preferences")).rows, [{ user_id: fixture.id, learning_updates: true }]);
    const key = randomUUID(); before = await operations();
    const command = await account("commands", fixture, { action: "export", idempotencyKey: key }); assert.equal(command.status, 202); await entries(before, ["completed"]);
    const original = JSON.parse(command.text); beforeBusiness = await fingerprint();
    const replayCommand = await account("commands", fixture, { action: "export", idempotencyKey: key }); assert.equal(replayCommand.status, 202); assert.equal(JSON.parse(replayCommand.text).commandId, original.commandId);
    assert.equal(await fingerprint(), beforeBusiness); rows = await counts(); assert.equal(rows.customer_account_commands, 1); assert.equal(rows.customer_account_deliveries, 2); assert.equal(rows.customer_account_exports, 1);
    assert.equal(providerCalls.length, 0); await reconcile(); checks.push("actual-account-exports-with-next-request-storage-real-active-session-closed-before-writes-and-exact-command-replay");

    for (const table of ["customer_account_preferences", "customer_account_commands", "customer_account_deliveries"]) {
      phase = `account-missing-${table}-receipt`; await reset(); const fixture = await seedAccount(); await change(true); before = await operations(); beforeBusiness = await fingerprint();
      await operator.query("CREATE OR REPLACE FUNCTION pg_temp.skip_owned_account_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$");
      await operator.query(`CREATE TRIGGER owned_skip_account_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_owned_account_insert()`);
      let result;
      try { result = await account(table === "customer_account_preferences" ? "preferences" : "commands", fixture, table === "customer_account_preferences" ? { learningUpdates: true } : { action: "export", idempotencyKey: randomUUID() }); }
      finally { await operator.query(`DROP TRIGGER owned_skip_account_insert ON ${table}`); }
      assert.equal(result.status, 503); await entries(before, ["uncertain"]); assert.equal(await fingerprint(), beforeBusiness); await reconcile();
      checks.push(`actual-account-${table}-missing-receipt-rolls-back-completely-and-preserves-whole-uncertainty`);
    }

    for (const fault of ["close", "ledger-death"]) {
      phase = `account-blocked-preferences-${fault}`; await reset(); const fixture = await seedAccount(); await change(true); before = await operations();
      const blocker = await connect(); await blocker.query("BEGIN"); await blocker.query("SELECT id FROM customer_users WHERE id=$1 FOR UPDATE", [fixture.id]);
      const pending = account("preferences", fixture, { learningUpdates: true });
      try {
        await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
        await change(false); await entries(before, ["active"]); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await account("preferences", fixture, { learningUpdates: false })).status, 503);
        if (fault === "ledger-death") await killLedger();
      } finally { await blocker.query("ROLLBACK"); }
      assert.equal((await pending).status, fault === "close" ? 200 : 503); await entries(before, [fault === "close" ? "completed" : "active"]);
      assert.equal((await operator.query("SELECT learning_updates FROM customer_account_preferences WHERE user_id=$1", [fixture.id])).rows[0].learning_updates, true);
      await reconcile(); checks.push(`actual-account-blocked-preferences-${fault}-whole-admission-awaits-real-transaction-and-preserves-committed-state`);
    }

    for (const state of ["expired-session", "suspended-user"]) {
      phase = `account-${state}-preentry-denial`; await reset(); const fixture = await seedAccount(); await change(true);
      await operator.query(state === "expired-session" ? "UPDATE customer_sessions SET expires=now()-interval '1 day'" : "UPDATE customer_users SET status='suspended'");
      before = await operations(); beforeBusiness = await fingerprint();
      assert.equal((await account("preferences", fixture, { learningUpdates: true })).status, 401);
      assert.equal((await account("commands", fixture, { action: "export", idempotencyKey: randomUUID() })).status, 401);
      await entries(before, []); assert.equal(await fingerprint(), beforeBusiness); await reconcile();
      checks.push(`actual-account-${state}-real-cookie-and-store-deny-both-writers-before-admission`);
    }

    phase = "account-signout-race-before-locked-preferences";
    await reset(); const raceFixture = await seedAccount(); await change(true); before = await operations();
    const sessionBlocker = await connect(); await sessionBlocker.query("BEGIN");
    await sessionBlocker.query("SELECT id FROM customer_users WHERE id=$1 FOR UPDATE", [raceFixture.id]);
    const racedPreferences = account("preferences", raceFixture, { learningUpdates: true });
    try {
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
      await entries(before, ["active"]);
      await sessionBlocker.query("DELETE FROM customer_sessions WHERE user_id=$1", [raceFixture.id]); await sessionBlocker.query("COMMIT");
    } finally { await sessionBlocker.query("ROLLBACK"); }
    assert.equal((await racedPreferences).status, 401); await entries(before, ["completed"]);
    assert.equal((await counts()).customer_account_preferences, 0); await reconcile();
    checks.push("actual-account-session-revoked-after-route-read-is-rechecked-under-customer-lock-with-clean-denial");

    phase = "account-command-ledger-death-after-admission";
    await reset(); const commandFixture = await seedAccount(); await change(true); before = await operations();
    const commandKey = randomUUID(), commandBody = { action: "export", idempotencyKey: commandKey };
    const commandBlocker = await connect(); await commandBlocker.query("BEGIN");
    await commandBlocker.query("SELECT id FROM customer_users WHERE id=$1 FOR UPDATE", [commandFixture.id]);
    const uncertainCommand = account("commands", commandFixture, commandBody);
    try {
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
      await change(false); await entries(before, ["active"]); await killLedger();
    } finally { await commandBlocker.query("ROLLBACK"); }
    assert.equal((await uncertainCommand).status, 503); await entries(before, ["active"]);
    const persistedCommand = (await operator.query("SELECT command_id FROM customer_account_commands WHERE idempotency_key=$1", [commandKey])).rows;
    assert.equal(persistedCommand.length, 1); assert.equal((await counts()).customer_account_deliveries, 2);
    beforeBusiness = await fingerprint(); assert.equal((await account("commands", commandFixture, commandBody)).status, 503);
    assert.equal(await fingerprint(), beforeBusiness); await reconcile();
    // Only this deliberate owner reconciliation permits a new exact request.
    // It returns the original command without replaying committed mutations.
    await change(true); before = await operations();
    const recovered = await account("commands", commandFixture, commandBody); assert.equal(recovered.status, 202);
    assert.equal(JSON.parse(recovered.text).commandId, persistedCommand[0].command_id);
    assert.equal(await fingerprint(), beforeBusiness); await entries(before, ["completed"]); await reconcile();
    checks.push("actual-account-command-ledger-death-preserves-committed-command-and-both-deliveries-owner-reconciled-exact-retry-does-not-rewrite");

    phase = "account-revoked-and-stale-sessions-and-delete";
    await reset(); const deleted = await seedAccount(); await change(true); before = await operations();
    await operator.query("UPDATE customer_sessions SET created_at=now()-interval '1 hour'");
    assert.equal((await account("commands", deleted, { action: "delete", idempotencyKey: randomUUID() })).status, 403); await entries(before, ["completed"]);
    await operator.query("UPDATE customer_sessions SET created_at=now()-interval '1 second'"); before = await operations();
    assert.equal((await account("commands", deleted, { action: "delete", idempotencyKey: randomUUID() })).status, 202); await entries(before, ["completed"]);
    assert.equal((await operator.query("SELECT status FROM customer_users WHERE id=$1", [deleted.id])).rows[0].status, "deleted");
    assert.equal((await counts()).customer_sessions, 0); before = await operations();
    assert.equal((await account("preferences", deleted, { learningUpdates: true })).status, 401); await entries(before, []); await reconcile();
    checks.push("actual-account-delete-requires-fresh-real-session-creates-both-receiver-commands-and-revoked-session-cannot-write");

    phase = "admin-lifecycle-closed-before-authorization-writes";
    await reset(); const adminCustomer = await seedAccount(), owner = await seedAdmin(); await change(false); before = await operations(); beforeBusiness = await fingerprint();
    assert.equal((await adminCommand(owner, adminCustomer)).status, 503); await entries(before, []); assert.equal(await fingerprint(), beforeBusiness);
    await change(true, true); before = await operations();
    const ownerCommand = await adminCommand(owner, adminCustomer); assert.equal(ownerCommand.status, 202, JSON.stringify({ response: JSON.parse(ownerCommand.text), entries: await since(before), unexpectedFetches, adminDiagnostic, logCount, diagnosticLogTypes }));
    await entries(before, ["completed", "completed", "completed"], ["new-work", "recovery", "recovery"]);
    assert.equal((await operator.query("SELECT status FROM customer_users WHERE id=$1", [adminCustomer.id])).rows[0].status, "suspended");
    assert.equal((await counts()).customer_sessions, 0); await loadLifecycleCommand();
    assert.ok((await operator.query("SELECT last_signed_in_at FROM admin_users WHERE id=$1", [owner.id])).rows[0].last_signed_in_at);
    await reconcile(); checks.push("actual-admin-lifecycle-command-closed-before-auth-refresh-fresh-owner-whole-authorization-and-session-revocation-accounted");

    for (const denied of ["nonowner", "stale-google-proof", "disabled-owner"]) {
      phase = `admin-lifecycle-${denied}`; await reset(); const customer = await seedAccount();
      const actor = await seedAdmin(denied === "nonowner" ? "admin" : "owner", denied === "stale-google-proof" ? 3600 : 0);
      if (denied === "disabled-owner") await operator.query("UPDATE admin_users SET status='disabled' WHERE id=$1", [actor.id]);
      await change(true, true); before = await operations();
      const result = await adminCommand(actor, customer); assert.ok([403, 503].includes(result.status));
      const current = await since(before); assert.ok(current.length >= 2); assert.equal(current[0].kind, "new-work");
      assert.ok(current.every(row => row.state !== "active")); assert.equal((await counts()).customer_account_commands, 0);
      assert.equal((await counts()).customer_sessions, 1);
      assert.equal((await operator.query("SELECT status FROM customer_users WHERE id=$1", [customer.id])).rows[0].status, "active");
      await reconcile(); checks.push(`actual-admin-lifecycle-${denied}-real-auth-js-and-persistent-guard-deny-command-without-session-revocation`);
    }

    phase = "admin-lifecycle-blocked-authorization-refresh";
    await reset(); const blockedCustomer = await seedAccount(), blockedOwner = await seedAdmin(); await change(true, true); before = await operations();
    const adminBlocker = await connect(); await adminBlocker.query("BEGIN"); await adminBlocker.query("SELECT id FROM admin_users WHERE id=$1 FOR UPDATE", [blockedOwner.id]);
    const blockedAdmin = adminCommand(blockedOwner, blockedCustomer);
    try {
      await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
      await entries(before, ["active", "active", "active"], ["new-work", "recovery", "recovery"]);
      await change(false); assert.equal((await drain()).ledgerDrained, false); assert.equal((await adminCommand(blockedOwner, blockedCustomer)).status, 503);
    } finally { await adminBlocker.query("ROLLBACK"); }
    assert.equal((await blockedAdmin).status, 202); await entries(before, ["completed", "completed", "completed"], ["new-work", "recovery", "recovery"]);
    assert.equal((await counts()).customer_sessions, 0); await reconcile();
    checks.push("actual-admin-lifecycle-parent-and-full-authorization-stay-active-through-blocked-refresh-and-final-command");

    phase = "lifecycle-cron-auth-and-closed-entry";
    await reset(); await seedAccount(); await change(false); before = await operations(); beforeBusiness = await fingerprint();
    assert.equal((await recovery(false)).status, 401); assert.equal((await recovery()).status, 503);
    await entries(before, []); assert.equal(await fingerprint(), beforeBusiness); assert.deepEqual(providerCalls, []);
    await change(false, true); before = await operations(); assert.equal((await recovery()).status, 200);
    await entries(before, ["completed"], ["recovery"]); await reconcile();
    checks.push("actual-lifecycle-cron-bearer-and-closed-recovery-refuse-before-claims-empty-positive-entry-completes");

    for (const mode of ["success", "outage", "missing-receipt"]) {
      phase = `lifecycle-cron-${mode}`; await reset(); const customer = await seedAccount(), actor = await seedAdmin(); await change(true, true);
      assert.equal((await adminCommand(actor, customer)).status, 202); await loadLifecycleCommand(); lifecycleMode = mode; before = await operations();
      const result = await recovery(); assert.equal(result.status, mode === "success" ? 200 : 503);
      await entries(before, [mode === "success" ? "completed" : "uncertain"], ["recovery"]);
      let deliveries = (await operator.query("SELECT receiver,status,attempts,lease_id FROM customer_account_deliveries ORDER BY receiver")).rows;
      if (mode === "success") { assert.equal(providerCalls.length, 2); assert.ok(deliveries.every(row => row.status === "acknowledged" && row.attempts === 1 && row.lease_id === null)); }
      else {
        assert.equal(providerCalls.length, 1); assert.equal(deliveries.filter(row => row.status === "pending" && row.attempts === 1 && row.lease_id === null).length, 1);
        const originalDigest = providerCalls[0].commandSha256;
        await reconcile(); lifecycleMode = "success";
        await operator.query("UPDATE customer_account_deliveries SET next_run_at=now() WHERE status='pending'");
        await change(false, true); before = await operations(); assert.equal((await recovery()).status, 200); await entries(before, ["completed"], ["recovery"]);
        assert.equal(providerCalls.length, 3); assert.ok(providerCalls.every(row => row.commandSha256 === originalDigest));
        deliveries = (await operator.query("SELECT status FROM customer_account_deliveries")).rows; assert.ok(deliveries.every(row => row.status === "acknowledged"));
      }
      assert.equal((await counts()).customer_account_commands, 1); await reconcile();
      checks.push(`actual-lifecycle-cron-${mode}-whole-claim-delivery-settlement-and-owner-reconciled-exact-command-recovery`);
    }

    for (const fault of ["close", "ledger-death"]) {
      phase = `lifecycle-cron-blocked-settlement-${fault}`; await reset(); const customer = await seedAccount(), actor = await seedAdmin(); await change(true, true);
      assert.equal((await adminCommand(actor, customer)).status, 202); await loadLifecycleCommand(); before = await operations();
      const held = hold("lifecycle-community"), pending = recovery(), blocker = await connect();
      try {
        await held.entered(); await blocker.query("BEGIN"); await blocker.query("SELECT command_id FROM customer_account_deliveries WHERE receiver='community' FOR UPDATE"); held.release();
        await until(async () => (await operator.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [target.user])).rows.length === 1);
        await entries(before, ["active"], ["recovery"]); await change(false); assert.equal((await drain()).ledgerDrained, false);
        assert.equal((await recovery()).status, 503); assert.equal(providerCalls.length, 1);
        if (fault === "ledger-death") await killLedger();
      } finally { held.release(); await blocker.query("ROLLBACK"); }
      assert.equal((await pending).status, fault === "close" ? 200 : 503); gate = undefined;
      await entries(before, [fault === "close" ? "completed" : "active"], ["recovery"]);
      assert.equal(providerCalls.length, 2); assert.ok((await operator.query("SELECT status,lease_id FROM customer_account_deliveries")).rows.every(row => row.status === "acknowledged" && row.lease_id === null));
      await reconcile(); checks.push(`actual-lifecycle-cron-blocked-settlement-${fault}-awaits-all-receiver-effects-and-preserves-original-receipts`);
    }

    assert.equal(unexpectedFetches, 0); if (invariantFailure) throw invariantFailure;
    assert.equal(frontendWriterInventory(fileURLToPath(new URL("../../../", import.meta.url))).sourceManifestSha256, sourceBefore.sourceManifestSha256);
    return { status: findings.length ? "FRONTEND_IDENTITY_OWNED_FINDINGS" : "FRONTEND_IDENTITY_OWNED_PASS", postgresMajor: major, checks, findings, reconciliationEvidenceSha256: evidence,
      applicationSourceManifestSha256: sourceBefore.sourceManifestSha256, syntheticLedgerSourceIdentity: true, actualAuthRouteExport: true, actualAccountRouteExports: true,
      actualAuthJs: true, actualAdminLifecycleRouteExport: true, actualLifecycleCronExport: true, constructedNextRequestStorage: true, nativeNextServer: false, loopbackHttp: true, verifiedPostgresTls: true, realBusinessDatabase: true,
      providersIntercepted: true, providerTouched: false, historicalWritersFenced: false, migrationAuthorized: false, applicationLogsSuppressed: logCount > 0 };
  } finally {
    gate?.release(); await Promise.allSettled(requests);
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await closePool?.(); for (const client of connections) { try { await client.end(); } catch { /* Owned cleanup only. */ } }
    globalThis.fetch = nativeFetch; Object.assign(console, originalConsole);
  }
}
main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ status: "FRONTEND_IDENTITY_OWNED_FAILED", phase, completedChecks, code: /^[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : undefined,
    assertion: error instanceof assert.AssertionError ? error.message : undefined,
    frames: error.stack?.split("\n").filter(line => /owned-frontend-identity-admission\.mjs/u.test(line)) })}\n`); process.exitCode = 1;
});

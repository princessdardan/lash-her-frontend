import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createCustomerAuthHandler } from "./handler";
import { createCustomerAuthConfig } from "./config";
import type { CustomerAuthConfiguration } from "./policy";
import { createCustomerAuthStore, type CustomerAuthStore } from "./store";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { assertCustomerWriterContext, withCustomerWriterContext } from "./context";

const configuration: CustomerAuthConfiguration = { origin: "https://example.com", secret: "s".repeat(32), googleId: "google", googleSecret: "google-secret", resendKey: "resend-secret", emailFrom: "account@example.com", secure: true };
const request = (path: string, options: ConstructorParameters<typeof NextRequest>[1] = {}) => new NextRequest(`${configuration.origin}/api/customer-auth${path}`, options);
const post = (email: string) => ({ method: "POST", headers: { origin: configuration.origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email, csrfToken: "csrf" }) });

test("auth operation encloses adapter/provider work and rejects admission failures before starting", async () => {
  const observations: string[] = [];
  const run: WriterAdmissionRunner = async (kind, work) => { observations.push(kind); const result = await work(); observations.push("complete"); return result; };
  const handler = createCustomerAuthHandler({ configuration: () => configuration, store: () => ({}) as CustomerAuthStore, run, handle: async () => { assertCustomerWriterContext(); observations.push("provider"); return Response.json({}); } });
  const response = await handler(request("/csrf"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/u);
  assert.deepEqual(observations, ["new-work", "provider", "complete"]);
  const closed = createCustomerAuthHandler({ configuration: () => configuration, run: async () => { throw new WriterAdmissionError("unavailable"); }, handle: async () => { assert.fail("closed admission called provider"); } });
  assert.equal((await closed(request("/csrf"))).status, 503);
  assert.throws(assertCustomerWriterContext);
});

test("disabled, cross-origin, unsupported and HEAD requests never start auth work", async () => {
  const handler = createCustomerAuthHandler({ configuration: () => configuration, run: async () => { assert.fail("invalid request entered admission"); } });
  assert.equal((await handler(request("/signin/google", { method: "POST" }))).status, 403);
  assert.equal((await handler(request("/signin/google", { ...post("a@example.com"), headers: { origin: "https://evil.test" } }))).status, 403);
  assert.equal((await handler(request("/callback/resend", { method: "HEAD" }))).status, 404);
  assert.equal((await handler(request("/callback/unknown"))).status, 404);
  const disabled = createCustomerAuthHandler({ configuration: () => null });
  assert.equal((await disabled(request("/csrf"))).status, 404);
});

test("email requests are generic across identity, malformed input and throttling", async () => {
  let calls = 0;
  for (const allowed of [true, false]) {
    const handler = createCustomerAuthHandler({ configuration: () => configuration, store: () => ({ consumeThrottle: async () => allowed }) as unknown as CustomerAuthStore,
      run: async (_kind, work) => work(), handle: async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://private.example/new-user", "set-cookie": "customer=test; HttpOnly" } }); } });
    for (const email of ["new@example.com", "existing@example.com", "invalid"]) {
      const response = await handler(request("/signin/resend", post(email)));
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("location"), "https://example.com/sign-in?check-email=1");
      assert.equal(await response.text(), "");
    }
  }
  assert.equal(calls, 2);
});

test("customer configuration isolates all cookies and explicitly forbids email-only Google linking", () => {
  const config = createCustomerAuthConfig(configuration, { adapter: {}, isActive: async () => true } as unknown as CustomerAuthStore);
  assert.equal(config.basePath, "/api/customer-auth");
  assert.equal(config.session?.strategy, "database");
  for (const value of Object.values(config.cookies!)) {
    assert.match(value!.name!, /^__Host-lash-customer\./u);
    assert.equal(value!.options!.httpOnly, true);
    assert.equal(value!.options!.secure, true);
    assert.equal(value!.options!.path, "/");
  }
  const google = config.providers[0] as { options: { allowDangerousEmailAccountLinking: boolean; checks: string[] } };
  assert.equal(google.options.allowDangerousEmailAccountLinking, false);
  assert.deepEqual(google.options.checks, ["pkce", "state", "nonce"]);
});

test("an exhausted client cannot allocate new email throttle buckets", async () => {
  let throttleCalls = 0;
  const handler = createCustomerAuthHandler({ configuration: () => configuration,
    store: () => ({ consumeThrottle: async () => { throttleCalls++; return false; } }) as unknown as CustomerAuthStore,
    run: async (_kind, work) => work(), handle: async () => { assert.fail("exhausted client reached Auth.js"); } });
  const response = await handler(request("/signin/resend", post("another-new-email@example.com")));
  assert.equal(response.status, 303);
  assert.equal(throttleCalls, 1, "only the client bucket is visited");
});

const selectedCustomerId = "33a4ad34-9e01-407b-82db-d32bb1067ce1";
const foreignCustomerId = "de425257-3165-4da6-b53b-e6bbab53586d";
const inSelectedIdentity = <T>(task: () => Promise<T>) => withWriterOperationContext(task, undefined, undefined, selectedCustomerId);

test("scoped email initiation reaches Auth.js only for the selected active address and retains the generic response", async () => {
  const seen: string[] = [];
  const handler = createCustomerAuthHandler({
    configuration: () => configuration,
    store: () => ({
      adapter: {},
      consumeThrottle: async () => { seen.push("throttle"); return true; },
      isActive: async (email: string) => { seen.push(email); return email === "reviewed@example.com"; },
    }),
    run: async (_kind, work) => inSelectedIdentity(work),
    handle: async () => { seen.push("authjs"); return new Response(null, { status: 302 }); },
  });
  for (const email of [" FOREIGN@EXAMPLE.COM ", " Reviewed@EXAMPLE.COM "]) {
    const response = await handler(request("/signin/resend", post(email)));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://example.com/sign-in?check-email=1");
    assert.equal(await response.text(), "");
  }
  assert.deepEqual(seen, ["throttle", "foreign@example.com", "throttle", "reviewed@example.com", "throttle", "authjs"]);
});

test("scoped Google callback requires the verified subject already linked to the selected user", async () => {
  let linkedId = selectedCustomerId;
  const selectedUser = { id: selectedCustomerId, email: "reviewed@example.com", emailVerified: null };
  const account = { provider: "google", type: "oidc" as const, providerAccountId: "verified-subject" };
  const profile = { sub: account.providerAccountId, email_verified: true };
  const config = createCustomerAuthConfig(configuration, {
    adapter: { async getUserByAccount(input: { provider: string; providerAccountId: string }) {
      assert.deepEqual(input, { provider: account.provider, providerAccountId: profile.sub });
      return { ...selectedUser, id: linkedId };
    } },
    isActive: async () => true,
    consumeThrottle: async () => assert.fail("the callback touched throttling"),
  });
  const allow = config.callbacks!.signIn!;
  await inSelectedIdentity(async () => {
    assert.equal(await allow({ user: selectedUser, account, profile }), true);
    assert.equal(await allow({ user: selectedUser, account, profile: { ...profile, email_verified: false } }), false);
    assert.equal(await allow({ user: selectedUser, account, profile: { ...profile, sub: "foreign-subject" } }), false);
    assert.equal(await allow({ user: { ...selectedUser, id: foreignCustomerId }, account, profile }), false);
    linkedId = foreignCustomerId;
    assert.equal(await allow({ user: selectedUser, account, profile }), false);
  });
});

test("scoped identity denies creation, linking and foreign mutations without database work or uncertainty", async () => {
  const adapter = createCustomerAuthStore(() => assert.fail("denied scoped operation touched the database")).adapter;
  await inSelectedIdentity(() => withCustomerWriterContext(async () => {
    const denied = /CUSTOMER_IDENTITY_SELECTION_DENIED/u;
    await assert.rejects(async () => adapter.createUser!({ id: selectedCustomerId, email: "reviewed@example.com", emailVerified: null }), denied);
    await assert.rejects(async () => adapter.linkAccount!({ userId: selectedCustomerId, provider: "google", type: "oidc", providerAccountId: "new-subject" }), denied);
    await assert.rejects(async () => adapter.updateUser!({ id: foreignCustomerId, name: "unexpected" }), denied);
    await assert.rejects(async () => adapter.createSession!({ userId: foreignCustomerId, sessionToken: "synthetic", expires: new Date() }), denied);
  }));
});

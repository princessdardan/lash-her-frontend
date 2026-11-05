import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { createCustomerAuthHandler } from "./handler";
import { createCustomerAuthConfig } from "./config";
import type { CustomerAuthConfiguration } from "./policy";
import type { CustomerAuthStore } from "./store";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { WriterAdmissionError } from "@/lib/writer-admission/config";
import { assertCustomerWriterContext } from "./context";

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

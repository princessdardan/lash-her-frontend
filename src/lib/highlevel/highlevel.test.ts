import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createHighLevelClient } from "./client";
import { exchange } from "./oauth";
import { encryptCredential, decryptCredential } from "./crypto";
import {
  normalizePhone,
  parseCheckoutMarketing,
  HighLevelError,
} from "./contract";
import {
  selectContact,
  providerBlocked,
  assertMappedIdentity,
} from "./identity";
import {
  createHighLevelWebhookHandler,
  verifyHighLevelSignature,
} from "./webhook";
import { createCrmCronHandler } from "./worker";
import {
  authorizationUrl,
  HIGHLEVEL_SCOPES,
  crmMarketingEnabled,
  highLevelOwnsMarketing,
} from "./config";

test("OAuth exchange pins v3 and rejects agency and wrong-location tokens", async (t) => {
  const values = {
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_CLIENT_SECRET: "test-secret",
    HIGHLEVEL_REDIRECT_URI: "https://website.test/api/admin/highlevel/callback",
    HIGHLEVEL_LOCATION_ID: "test-location",
    VERCEL_ENV: "preview",
    HIGHLEVEL_AGENCY_INSTALLATION_ENABLED: "false",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const token = {
    access_token: "test-access",
    refresh_token: "test-refresh",
    expires_in: 86400,
    userType: "Location",
    locationId: "test-location",
    scope: HIGHLEVEL_SCOPES.join(" "),
  };
  const request: typeof fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("Version"), "v3");
    assert.equal(
      new URLSearchParams(init?.body as URLSearchParams).get("user_type"),
      "Location",
    );
    return Response.json(token);
  };
  assert.deepEqual(
    await exchange(
      { grant_type: "authorization_code", code: "test-code" },
      request,
    ),
    token,
  );
  token.userType = "Company";
  await assert.rejects(
    exchange({ grant_type: "authorization_code" }, request),
    /oauth_location_installation_required/,
  );
  token.userType = "Location";
  token.locationId = "wrong-location";
  await assert.rejects(
    exchange({ grant_type: "authorization_code" }, request),
    /oauth_invalid_location_or_token/,
  );
});

test("agency installation exchanges only the configured company and location and returns only location credentials", async (t) => {
  const values = {
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_CLIENT_SECRET: "test-secret",
    HIGHLEVEL_REDIRECT_URI: "https://website.test/api/admin/highlevel/callback",
    HIGHLEVEL_LOCATION_ID: "test-location",
    HIGHLEVEL_COMPANY_ID: "test-company",
    HIGHLEVEL_AGENCY_INSTALLATION_ENABLED: "true",
    VERCEL_ENV: "preview",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const agencyToken = {
    access_token: "agency-access",
    refresh_token: "agency-refresh",
    expires_in: 86400,
    userType: "Company",
    companyId: "test-company",
    scope: [...HIGHLEVEL_SCOPES, "oauth.write"].join(" "),
  };
  const locationToken = {
    access_token: "location-access",
    refresh_token: "location-refresh",
    expires_in: 86400,
    locationId: "test-location",
    scope: HIGHLEVEL_SCOPES.join(" "),
  };
  let locationRequests = 0;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/oauth/token") return Response.json(agencyToken);
    assert.equal(path, "/oauth/location-token");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Version"), "v3");
    assert.equal(headers.get("Authorization"), "Bearer agency-access");
    assert.equal(init?.redirect, "error");
    assert.deepEqual(Object.fromEntries(init?.body as URLSearchParams), {
      companyId: "test-company",
      locationId: "test-location",
    });
    locationRequests++;
    return Response.json(locationToken);
  };
  const authorization = { grant_type: "authorization_code", code: "test-code" };
  assert.deepEqual(await exchange(authorization, request), {
    ...locationToken,
    userType: "Location",
  });
  assert.equal(locationRequests, 1);
  agencyToken.companyId = "different-company";
  await assert.rejects(
    exchange(authorization, request),
    /oauth_invalid_company_or_token/,
  );
  agencyToken.companyId = "test-company";
  agencyToken.scope = HIGHLEVEL_SCOPES.join(" ");
  await assert.rejects(
    exchange(authorization, request),
    /oauth_missing_agency_exchange_scope/,
  );
  agencyToken.scope += " oauth.write";
  await assert.rejects(
    exchange({ grant_type: "refresh_token" }, request),
    /oauth_location_installation_required/,
  );
  assert.equal(locationRequests, 1);
  locationToken.locationId = "different-location";
  await assert.rejects(
    exchange(authorization, request),
    /oauth_invalid_location_or_token/,
  );
  locationToken.locationId = "test-location";
  locationToken.refresh_token = "";
  await assert.rejects(
    exchange(authorization, request),
    /oauth_invalid_location_or_token/,
  );
  locationToken.refresh_token = "location-refresh";
  locationToken.scope = "contacts.readonly";
  await assert.rejects(
    exchange(authorization, request),
    /oauth_missing_scopes/,
  );
});

test("OAuth installation uses the versioned authorization endpoint and app version with bound state", (t) => {
  const values = {
    HIGHLEVEL_CLIENT_ID: "test-client",
    HIGHLEVEL_APP_VERSION_ID: "test-version",
    HIGHLEVEL_REDIRECT_URI: "https://website.test/api/admin/highlevel/callback",
    HIGHLEVEL_AGENCY_INSTALLATION_ENABLED: "false",
    HIGHLEVEL_COMPANY_ID: "test-company",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const url = authorizationUrl("bound-state");
  assert.equal(url.origin, "https://marketplace.gohighlevel.com");
  assert.equal(url.pathname, "/v2/oauth/chooselocation");
  assert.equal(url.searchParams.get("version_id"), "test-version");
  assert.equal(url.searchParams.get("state"), "bound-state");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    values.HIGHLEVEL_REDIRECT_URI,
  );
  assert.equal(url.searchParams.get("scope"), HIGHLEVEL_SCOPES.join(" "));
  process.env.HIGHLEVEL_AGENCY_INSTALLATION_ENABLED = "true";
  assert.equal(
    authorizationUrl("bound-state").searchParams.get("scope"),
    [...HIGHLEVEL_SCOPES, "oauth.write"].join(" "),
  );
  delete process.env.HIGHLEVEL_COMPANY_ID;
  assert.throws(
    () => authorizationUrl("bound-state"),
    /missing_highlevel_company_id/,
  );
  process.env.HIGHLEVEL_COMPANY_ID = "invalid&company";
  assert.throws(
    () => authorizationUrl("bound-state"),
    /invalid_highlevel_company_id/,
  );
  process.env.HIGHLEVEL_COMPANY_ID = "test-company";
  delete process.env.HIGHLEVEL_APP_VERSION_ID;
  assert.throws(
    () => authorizationUrl("bound-state"),
    /missing_highlevel_app_version_id/,
  );
  process.env.HIGHLEVEL_APP_VERSION_ID = "bad&version=wrong";
  assert.throws(
    () => authorizationUrl("bound-state"),
    /invalid_highlevel_app_version_id/,
  );
});

test("marketing consent requires explicit booleans and a usable SMS destination", () => {
  assert.deepEqual(parseCheckoutMarketing(undefined), {});
  assert.deepEqual(parseCheckoutMarketing({ marketingConsent: false }), {
    marketingConsent: false,
    smsMarketingConsent: false,
  });
  assert.equal(parseCheckoutMarketing({ marketingConsent: "true" }), null);
  assert.equal(parseCheckoutMarketing({ smsMarketingConsent: true }), null);
  assert.equal(
    parseCheckoutMarketing({
      smsMarketingConsent: true,
      phone: "4165550123 ext 123",
    }),
    null,
  );
  assert.equal(
    parseCheckoutMarketing({ smsMarketingConsent: true, phone: "416-555-0123" })
      ?.phone,
    "+14165550123",
  );
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("00442079460958"), null);
});

test("email/phone disagreement, duplicate matches and changed mapped identities never merge", () => {
  const contact = { id: "one", email: "one@example.test", locationId: "test" };
  assert.equal(selectContact(contact.email, [contact], []), contact);
  assert.throws(
    () => selectContact(contact.email, [contact], [{ ...contact, id: "two" }]),
    /identity_conflict/,
  );
  assert.throws(
    () => selectContact(contact.email, [contact, contact], []),
    /identity_conflict/,
  );
  assert.throws(
    () => selectContact("other@example.test", [], [contact]),
    /identity_conflict/,
  );
  assert.throws(
    () => assertMappedIdentity(contact, "different", contact.email),
    /tenant/,
  );
  assert.equal(
    providerBlocked(
      { ...contact, dndSettings: { SMS: { status: "permanent" } } },
      "sms",
    ),
    true,
  );
  assert.equal(
    providerBlocked(
      { ...contact, dndSettings: { Email: { status: "active" } } },
      "email",
    ),
    true,
  );
  assert.equal(
    providerBlocked(
      { ...contact, dndSettings: { sms: { status: "inactive" } } },
      "sms",
    ),
    false,
  );
});

test("OAuth credential encryption is authenticated and location bound", () => {
  process.env.HIGHLEVEL_CREDENTIAL_ENCRYPTION_KEY = "ab".repeat(32);
  const secret = { access_token: "private-token", refresh_token: "single-use" };
  const envelope = encryptCredential(secret, "test");
  assert.equal(envelope.includes("private-token"), false);
  assert.deepEqual(decryptCredential(envelope, "test"), secret);
  assert.throws(() => decryptCredential(envelope, "wrong-location"));
  assert.throws(() =>
    decryptCredential(envelope.slice(0, -4) + "AAAA", "test"),
  );
});

test("HTTP client distinguishes rate limits, safe retries, ambiguous writes and secret-free errors", async () => {
  const request = (status: number, headers?: HeadersInit) =>
    createHighLevelClient(
      async () => "SECRET",
      async () => new Response("provider contact pii", { status, headers }),
    );
  await assert.rejects(
    request(429, { "Retry-After": "180" })("/contacts/x"),
    (e: unknown) =>
      e instanceof HighLevelError &&
      e.retryable &&
      e.retryAfterSeconds === 180 &&
      !e.message.includes("pii"),
  );
  await assert.rejects(
    request(503)("/contacts/x"),
    (e: unknown) => e instanceof HighLevelError && e.retryable,
  );
  await assert.rejects(
    request(503)("/contacts/x/notes", { method: "POST", nonIdempotent: true }),
    (e: unknown) => e instanceof HighLevelError && e.ambiguous && !e.retryable,
  );
  await assert.rejects(
    request(401)("/contacts/x"),
    (e: unknown) => e instanceof HighLevelError && !e.retryable,
  );
  await assert.rejects(request(200)("//untrusted.test"), /invalid_api_path/);
  const network = createHighLevelClient(
    async () => "SECRET",
    async () => {
      throw new Error("contains SECRET");
    },
  );
  await assert.rejects(
    network("/contacts/x/workflow/y", { method: "POST", nonIdempotent: true }),
    (e: unknown) =>
      e instanceof HighLevelError &&
      e.ambiguous &&
      !e.message.includes("SECRET"),
  );
});

test("raw-body Ed25519 webhook verification rejects tampering, invalid signatures and wrong tenants", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const raw = JSON.stringify({
    type: "ContactDndUpdate",
    id: "contact",
    locationId: "test",
    name: "Élodie",
  });
  const signature = sign(null, Buffer.from(raw), privateKey).toString("base64");
  assert.equal(verifyHighLevelSignature(raw, signature, pem), true);
  assert.equal(verifyHighLevelSignature(raw + " ", signature, pem), false);
  assert.equal(verifyHighLevelSignature(raw, "not-base64", pem), false);
  process.env.HIGHLEVEL_LOCATION_ID = "test";
  let persisted = 0;
  const handler = createHighLevelWebhookHandler({
    location: () => "test",
    verify: (body, sig) => verifyHighLevelSignature(body, sig, pem),
    persist: async () => {
      persisted++;
    },
  });
  const post = (body: string, sig = signature) =>
    handler(
      new Request("https://website.test/api/webhooks/highlevel", {
        method: "POST",
        body,
        headers: { "X-GHL-Signature": sig },
      }),
    );
  assert.equal((await post(raw)).status, 200);
  assert.equal((await post(raw + " ")).status, 401);
  const wrong = raw.replace('"test"', '"wrong"');
  assert.equal(
    (
      await post(
        wrong,
        sign(null, Buffer.from(wrong), privateKey).toString("base64"),
      )
    ).status,
    403,
  );
  assert.equal(persisted, 1);
});

test("worker authorization fails closed and marketing pause does not change ownership", async () => {
  let calls = 0;
  const handler = createCrmCronHandler(async () => {
    calls++;
    return {
      enabled: true,
      processed: 0,
      succeeded: 0,
      skipped: 0,
      retry: 0,
      review: 0,
      dead_letter: 0,
    };
  });
  delete process.env.CRON_SECRET;
  assert.equal(
    (await handler(new Request("https://website.test/cron"))).status,
    404,
  );
  process.env.CRON_SECRET = "cron-test";
  assert.equal(
    (
      await handler(
        new Request("https://website.test/cron", {
          headers: { authorization: "Bearer wrong" },
        }),
      )
    ).status,
    401,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await handler(
        new Request("https://website.test/cron", {
          headers: { authorization: "Bearer cron-test" },
        }),
      )
    ).status,
    200,
  );
  process.env.MARKETING_DELIVERY_PROVIDER = "highlevel";
  process.env.HIGHLEVEL_MARKETING_ENABLED = "false";
  assert.equal(crmMarketingEnabled(), false);
  assert.equal(highLevelOwnsMarketing(), true);
});

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createHighLevelClient } from "./client";
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
import { crmMarketingEnabled, highLevelOwnsMarketing } from "./config";

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

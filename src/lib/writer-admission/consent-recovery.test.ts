import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { Resend } from "resend";
import { createResendWebhookPostHandler } from "@/app/api/webhooks/resend/handler";
import { createHighLevelWebhookHandler, verifyHighLevelSignature } from "@/lib/highlevel/webhook";
import { createMarketingUnsubscribeGetHandler, createMarketingUnsubscribePostHandler, unavailableMarketingUnsubscribeResponse } from "@/app/api/marketing/unsubscribe/handler";
import { createMarketingUnsubscribeTokenCodec } from "@/lib/marketing-contact/unsubscribe-token";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { resolveWriterAdmissionConfiguration } from "./config";
import { createWriterAdmissionRunner } from "./runtime";
import { withWriterAdmission } from "./route";

const location = "owned-location", email = "owned-private-email@example.invalid";
let previousLocation: string | undefined;
before(() => { previousLocation = process.env.HIGHLEVEL_LOCATION_ID; process.env.HIGHLEVEL_LOCATION_ID = location; });
after(() => { if (previousLocation === undefined) delete process.env.HIGHLEVEL_LOCATION_ID; else process.env.HIGHLEVEL_LOCATION_ID = previousLocation; });

function admission() {
  const url = "postgresql://protocol_runtime:owned-password@db.owned.invalid/owned?sslmode=verify-full";
  const configuration = resolveWriterAdmissionConfiguration({
    FRONTEND_WRITER_ADMISSION_MODE: "enforce", APP_ENV: "staging", VERCEL: "1", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId, APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId,
    VERCEL_GIT_COMMIT_SHA: "c".repeat(40), FRONTEND_WRITER_PRODUCER_SHA256: "b".repeat(64),
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ environment: "staging", host: "db.owned.invalid", port: 5432,
      database: "owned", user: "protocol_runtime", serverMajor: 18, targetSha256: "a".repeat(64) }),
    DATABASE_URL: url, FRONTEND_WRITER_ADMISSION_DATABASE_URL: url,
  });
  const state = { newWork: false, recovery: true, epoch: "7", uncertain: false, loseSettlement: false };
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = Object.assign(new EventEmitter(), {
    connection: { stream: { encrypted: true, authorized: true } }, async connect() {}, async end() {},
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT current_user")) return { rows: [{ username: "protocol_runtime", database: "owned", major: 18 }] };
      if (sql.includes("current_policy")) return { rows: [{ epoch: state.epoch, new_work: state.newWork, recovery: state.recovery }] };
      if (sql.includes("finish_operation")) {
        state.uncertain = values?.[1] === "uncertain";
        if (state.loseSettlement) throw new Error("owned-private-error");
      }
      return { rows: [] };
    },
  });
  const run = createWriterAdmissionRunner({ getConfiguration: () => configuration, createClient: () => client });
  const off = createWriterAdmissionRunner({ getConfiguration: () => null });
  return { state, calls, run, off };
}

const svixSecretBytes = Buffer.alloc(32, 7);
const svixSecret = `whsec_${svixSecretBytes.toString("base64")}`;
const resend = new Resend("owned-unused-api-key");
const resendRaw = JSON.stringify({ type: "contact.updated", created_at: new Date().toISOString(), data: {
  id: "owned-contact", email, first_name: "Owned", last_name: "Fixture", unsubscribed: true,
  segment_ids: ["owned-segment"], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
} }, null, 2) + "\n";
function resendRequest(valid = true, raw = resendRaw) {
  const timestamp = String(Math.floor(Date.now() / 1000)), id = "owned-svix-message";
  const signature = createHmac("sha256", svixSecretBytes).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return new Request("https://owned.invalid/api/webhooks/resend", { method: "POST", body: raw,
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${valid ? signature : "invalid"}` } });
}
function resendHandler(persist: Parameters<typeof createResendWebhookPostHandler>[0]["recordResendUnsubscribe"], observed: string[] = []) {
  return createResendWebhookPostHandler({ getWebhookSecret: () => svixSecret, logError: () => {}, logWarn: () => {}, recordResendUnsubscribe: persist,
    verifyEvent: input => { observed.push(input.payload); return resend.webhooks.verify(input); } });
}

const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const highlevelRaw = JSON.stringify({ type: "ContactDndUpdate", id: "owned-contact", locationId: location, webhookId: "owned-webhook",
  email, dndSettings: { Email: { status: "active" } }, dateUpdated: new Date().toISOString() }, null, 2) + "\n";
function highlevelRequest(valid = true, raw = highlevelRaw) {
  return new Request("https://owned.invalid/api/webhooks/highlevel", { method: "POST", body: raw,
    headers: { "x-ghl-signature": valid ? sign(null, Buffer.from(raw), keys.privateKey).toString("base64") : "invalid" } });
}
function highlevelHandler(persist: NonNullable<Parameters<typeof createHighLevelWebhookHandler>[0]>["persist"], observed: string[] = []) {
  return createHighLevelWebhookHandler({ location: () => location, persist,
    verify: (raw, signature) => { observed.push(raw); return verifyHighLevelSignature(raw, signature, publicKey); } });
}

const codec = createMarketingUnsubscribeTokenCodec({ getAudience: () => ({ environment: "staging", dataset: "owned-dataset" }), getRootKey: () => Buffer.alloc(32, 9) });
const token = codec.createToken({ email });
function unsubscribeRequest(method = "POST") {
  return new Request(`https://owned.invalid/api/marketing/unsubscribe?token=${encodeURIComponent(token)}`, { method });
}
function unsubscribeDependencies(persist: Parameters<typeof createMarketingUnsubscribePostHandler>[0]["recordInternalUnsubscribe"]) {
  return { buildUrlFromToken: (value: string) => `https://owned.invalid/api/marketing/unsubscribe?token=${encodeURIComponent(value)}`,
    verifyToken: codec.verifyToken, logError: () => {}, recordInternalUnsubscribe: persist };
}

test("closed recovery refuses real webhook handlers before raw body, signature verification or persistence", async () => {
  const f = admission(); f.state.recovery = false; let persisted = 0;
  const observed: string[] = [];
  const handlers = [resendHandler(async () => { persisted++; return { eventId: "owned-event" }; }, observed), highlevelHandler(async () => { persisted++; }, observed)];
  for (const [index, handler] of handlers.entries()) {
    const req = index ? highlevelRequest() : resendRequest();
    assert.equal((await withWriterAdmission("recovery", handler, f.run)(req)).status, 503);
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(persisted, 0); assert.deepEqual(observed, []);
});

test("real Svix and Ed25519 signatures validate unchanged bytes while new work is closed", async () => {
  const f = admission(), observed: string[] = [];
  let persisted = 0;
  const hook = resendHandler(async input => { assert.ok(f.calls.at(-1)?.sql.includes("begin_operation")); assert.equal(input.email, email); persisted++; return { eventId: "owned-event" }; }, observed);
  assert.equal((await withWriterAdmission("recovery", hook, f.run)(resendRequest())).status, 200);
  const highlevel = highlevelHandler(async (event, key) => {
    assert.ok(f.calls.at(-1)?.sql.includes("begin_operation"));
    assert.equal(event.email, email); assert.equal(key, createHash("sha256").update(`${location}:owned-webhook`).digest("hex")); persisted++;
  }, observed);
  assert.equal((await withWriterAdmission("recovery", highlevel, f.run)(highlevelRequest())).status, 200);
  assert.deepEqual(observed, [resendRaw, highlevelRaw]); assert.equal(persisted, 2); assert.equal(f.state.uncertain, false);
  assert.equal(f.calls.filter(call => call.sql.includes("begin_operation")).every(call => call.values?.[1] === "recovery" && call.values?.[4] === "7"), true);
  assert.equal(JSON.stringify(f.calls).includes(email), false);
});

test("bad signatures and oversized webhook bodies never persist or become successful acknowledgements", async () => {
  const f = admission(); let persisted = 0;
  const observed: string[] = [];
  const hooks = [resendHandler(async () => { persisted++; return { eventId: "owned-event" }; }, observed), highlevelHandler(async () => { persisted++; }, observed)];
  for (const [index, handler] of hooks.entries()) {
    const req = index ? highlevelRequest(false) : resendRequest(false);
    assert.equal((await withWriterAdmission("recovery", handler, f.run)(req)).status, 401);
    const before = observed.length, raw = "x".repeat(64_001);
    const oversized = index ? highlevelRequest(true, raw) : resendRequest(true, raw);
    assert.equal((await withWriterAdmission("recovery", handler, f.run)(oversized)).status, 413);
    assert.equal(observed.length, before);
  }
  assert.equal(persisted, 0); assert.equal(f.state.uncertain, false);
});

test("a webhook stays admitted through awaited persistence even after recovery closes", async () => {
  const f = admission(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const handler = withWriterAdmission("recovery", resendHandler(async () => { entered(); await held; return { eventId: "owned-event" }; }), f.run);
  const pending = handler(resendRequest()); await started;
  assert.equal(f.calls.some(call => call.sql.includes("finish_operation")), false);
  f.state.recovery = false;
  const next = resendRequest(); assert.equal((await handler(next)).status, 503); assert.equal(next.bodyUsed, false);
  release(); assert.equal((await pending).status, 200);
});

test("persistence failures in both webhook families retain uncertain executions and sanitized retryable responses", async () => {
  for (const provider of ["resend", "highlevel"]) {
    const f = admission(); let effects = 0;
    const persist = async () => { effects++; throw new Error(`private ${email} ${token}`); };
    const handler = provider === "resend" ? resendHandler(persist) : highlevelHandler(persist);
    const response = await withWriterAdmission("recovery", handler, f.run)(provider === "resend" ? resendRequest() : highlevelRequest());
    assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
    const payload = await response.text(); assert.equal(payload.includes(email), false); assert.equal(payload.includes(token), false);
    assert.equal(effects, 1); assert.equal(f.state.uncertain, true);
  }
});

test("unsubscribe recovery preserves blank privacy-protected responses for closed admission and uncertain persistence", async () => {
  const f = admission(); let effects = 0, fail = false;
  const handler = createMarketingUnsubscribePostHandler(unsubscribeDependencies(async input => {
    assert.equal(input.email, email); effects++; if (fail) throw new Error(email); return { eventId: "owned-event" };
  }));
  const admitted = withWriterAdmission("recovery", handler, f.run, unavailableMarketingUnsubscribeResponse);
  f.state.recovery = false;
  const closed = await admitted(unsubscribeRequest()); assert.equal(effects, 0);
  f.state.recovery = true; fail = true;
  const uncertain = await admitted(unsubscribeRequest()); assert.equal(f.state.uncertain, true); assert.equal(effects, 1);
  for (const response of [closed, uncertain]) {
    assert.equal(response.status, 503); assert.equal(await response.text(), "");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0"); assert.equal(response.headers.get("retry-after"), "30");
  }
  fail = false;
  const success = await admitted(unsubscribeRequest()); assert.equal(success.status, 200); assert.equal(await success.text(), "");
  assert.equal(JSON.stringify(f.calls).includes(token), false); assert.equal(JSON.stringify(f.calls).includes(email), false);
});

test("unsubscribe confirmation GET remains read-only and off mode preserves its normal responses", async () => {
  const f = admission(); f.state.recovery = false; let persisted = 0;
  const deps = unsubscribeDependencies(async () => { persisted++; return { eventId: "owned-event" }; });
  const get = await createMarketingUnsubscribeGetHandler(deps)(unsubscribeRequest("GET"));
  assert.equal(get.status, 200); assert.equal(persisted, 0); assert.equal(f.calls.length, 0);
  assert.ok((await get.text()).includes("<form"));
  const post = await withWriterAdmission("recovery", createMarketingUnsubscribePostHandler(deps), f.off, unavailableMarketingUnsubscribeResponse)(unsubscribeRequest());
  assert.equal(post.status, 200); assert.equal(await post.text(), ""); assert.equal(persisted, 1); assert.equal(f.calls.length, 0);
});

test("a lost webhook settlement acknowledgement never replays persistence or acknowledges success", async () => {
  const f = admission(); f.state.loseSettlement = true; let persisted = 0;
  const handler = withWriterAdmission("recovery", highlevelHandler(async () => { persisted++; }), f.run);
  const response = await handler(highlevelRequest());
  assert.equal(response.status, 503); assert.equal(persisted, 1);
  assert.equal(f.calls.filter(call => call.sql.includes("finish_operation")).length, 1);
});

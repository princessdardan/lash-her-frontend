import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prepareFixture, privateTlsCaller, validateInput } from "./host/staging_fixture.mjs";

const now = 1_800_000_000_000;
function fixture() {
  const actorUserId = randomUUID();
  const claims = { sub: actorUserId, role: "courseAdmin", iat: now / 1000, exp: now / 1000 + 300 };
  const applicationToken = `owned.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.private`;
  return { version: 1, environment: "staging", actionId: "recovery-fixture-test", nonce: "1".repeat(32),
    actorUserId, userIds: [randomUUID(), randomUUID()], applicationToken };
}
function caller(input, calls) {
  const courseId = randomUUID();
  return async (method, path, token, body, key) => {
    calls.push({ method, path, token, body, key });
    if (path === "/v1/admin/courses") return { status: 201, body: { course: { id: courseId, slug: body.slug, status: body.status } } };
    return { status: 201, body: { action: "grant", outcome: "applied", commandId: randomUUID(), actorUserId: input.actorUserId,
      userId: body.userId, courseId: body.courseId, affectedGrantCount: 1,
      effects: [{ grantId: randomUUID(), effectType: "grant_created", resultingStatus: "active" }] } };
  };
}

test("staging fixture uses three existing authenticated APIs and retains only synthetic identifiers", async () => {
  const input = fixture(), calls = [], progress = [];
  const result = await prepareFixture(input, { call: caller(input, calls), now: () => now, onProgress: value => progress.push(value) });
  assert.equal(result.status, "STAGING_FIXTURE_TWO_GRANTS_CREATED");
  assert.equal(calls.length, 3); assert.equal(progress.length, 3);
  assert.equal(calls[0].body.status, "draft"); assert.equal(calls[0].body.priceCents, 0);
  assert.ok(calls.every(call => call.token === input.applicationToken && call.method === "POST"));
  assert.ok(calls.slice(1).every(call => call.key === call.body.idempotencyKey));
  assert.notEqual(calls[1].key, calls[2].key);
  assert.equal(result.coursePublished, false); assert.equal(result.publicGatewayWritesAdmitted, false);
  assert.equal(result.migrationsExecuted, false);
  assert.ok(!JSON.stringify([result, progress]).includes(input.applicationToken));
  assert.ok(!JSON.stringify([result, progress]).includes("Bearer"));
});

test("production, alternate input fields and non-synthetic identities refuse before HTTP", async () => {
  for (const modify of [input => { input.environment = "production"; }, input => { input.email = "forbidden"; },
    input => { input.userIds[1] = input.userIds[0]; }, input => { input.nonce = "other"; },
    input => { input.userIds[0] = input.actorUserId; }]) {
    const input = fixture(); modify(input);
    await assert.rejects(prepareFixture(input, { call: () => assert.fail("HTTP called"), now: () => now }), /STAGING_FIXTURE_/u);
  }
});

test("application token must be short-lived, bound to the synthetic actor and contain no personal claims", () => {
  for (const changes of [{ exp: now / 1000 + 301 }, { iat: now / 1000 + 1 }, { exp: now / 1000 + 30 },
    { role: "learner" }, { sub: randomUUID() }, { email: "forbidden" }]) {
    const input = fixture(), claims = JSON.parse(Buffer.from(input.applicationToken.split(".")[1], "base64url"));
    input.applicationToken = `owned.${Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url")}.private`;
    assert.throws(() => validateInput(input, now), /BOUNDED_ADMIN_TOKEN/u);
  }
});

test("unverified creation stops before grants and never retries", async () => {
  const input = fixture(); let calls = 0;
  await assert.rejects(prepareFixture(input, { now: () => now, call: async () => { calls++; return { status: 500, body: {} }; } }), /COURSE_CREATION_UNVERIFIED/u);
  assert.equal(calls, 1);
});

test("a grant refusal or replay preserves prior progress without claiming completion", async () => {
  for (const replay of [false, true]) {
    const input = fixture(), calls = [], progress = [], base = caller(input, calls);
    await assert.rejects(prepareFixture(input, { now: () => now, onProgress: value => progress.push(value),
      call: async (...args) => {
        const value = await base(...args);
        if (calls.length === 3) { if (replay) value.body.idempotentReplay = true; else value.body.userId = randomUUID(); }
        return value;
      } }), /AUDITED_GRANT_UNVERIFIED/u);
    assert.equal(calls.length, 3); assert.equal(progress.length, 2);
    assert.equal(progress[1].status, "STAGING_FIXTURE_GRANT_CREATED");
  }
});

test("private TLS caller refuses caller-selected routes or destinations", async () => {
  const call = privateTlsCaller("owned-not-a-real-ca");
  for (const [method, path] of [["GET", "/v1/admin/courses"], ["POST", "https://other.invalid"],
    ["POST", "/v1/webhooks/mux"], ["POST", "/v1/admin/courses/other"]]) {
    await assert.rejects(call(method, path, "private", {}), /ROUTE_REFUSED/u);
  }
});

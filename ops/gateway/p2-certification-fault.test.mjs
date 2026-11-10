import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createP2CertificationFault, parseP2MuxCreatedAt, p2GatewayProcessBinding } from "./p2-certification-fault.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
function fixture(mode = "drop-after-ack", profile = "lifecycle-known-command-v1") {
  const config = { appEnv: "staging", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", publicHost: "api-staging.lashher.com",
    admission: { file: "/admission/state.json", releaseId: "owned-release", candidateSha256: "1".repeat(64) } };
  const gateway = Buffer.from(JSON.stringify(config)), command = { version: 1, commandId: uuid(1), userId: uuid(2), accountVersion: 4, action: "suspend", issuedAt: "2026-11-06T12:00:00.000Z" };
  const clock = { now: Date.parse("2026-11-06T12:00:00.000Z"), tick: 1000000n }, receipts = [];
  const process = p2GatewayProcessBinding({ bootId: uuid(3), pid: 1, startTicks: "1000" });
  const lease = { version: 1, environment: "staging", profile, stageId: "owned-one-record", releaseId: "owned-release", candidateSha256: "1".repeat(64),
    configurationSha256: "2".repeat(64), gatewayConfigurationSha256: hash(gateway), gatewayProcessSha256: process, gatewayImageSha256: "3".repeat(64),
    sourceWitnessSha256: "4".repeat(64), issuedAt: new Date(clock.now).toISOString(), expiresAt: new Date(clock.now + 120000).toISOString(), maxMatches: 1, mode, receiver: "course",
    record: profile === "lifecycle-known-command-v1" ? { commandId: command.commandId, accountVersion: 4, canonicalSha256: hash(canonical(command)) }
      : { attemptId: uuid(10), lessonId: uuid(11), generation: 2, environmentId: "owned-environment", assetId: "owned-asset", uploadId: "owned-upload", eventType: "video.asset.track.ready" } };
  const context = { method: "POST", target: "/course/v1/internal/accounts/commands", route: { method: "POST", path: "/v1/internal/accounts/commands", auth: "application", admission: "recovery" },
    headers: { "x-idempotency-key": command.commandId, authorization: "Bearer PRIVATE-TOKEN-MUST-NOT-BE-LOGGED" }, body: Buffer.from(JSON.stringify(command)) };
  let present = true;
  const options = { readLease: () => { if (!present) throw new Error("ABSENT"); return Buffer.from(JSON.stringify(lease)); }, readGateway: () => gateway,
    processBinding: () => process, now: () => clock.now, monotonic: () => clock.tick, emit: value => receipts.push(value) };
  const component = createP2CertificationFault(config, options);
  return { config, command, context, lease, clock, options, receipts, component, remove: () => { present = false; } };
}
const response = () => ({ statusCode: 200, headersSent: false, writableEnded: false, destroyed: false, destroy() { this.destroyed = true; } });
const accepted = fixture => ({ status: 200, body: Buffer.from(JSON.stringify({ commandId: fixture.command.commandId, accountVersion: 4, status: "accepted" })) });

test("staging/project/team/host/candidate/process/TTL/closed shape are mandatory", () => {
  for (const mutate of [value => { value.config.appEnv = "production"; }, value => { value.config.projectId = "other"; },
    value => { value.config.ownerId = "other"; }, value => { value.config.publicHost = "lashher.com"; },
    value => { value.lease.candidateSha256 = "f".repeat(64); }, value => { value.lease.gatewayProcessSha256 = "f".repeat(64); },
    value => { value.lease.maxMatches = 2; }, value => { value.lease.expiresAt = new Date(value.clock.now + 120001).toISOString(); },
    value => { value.lease.mode = "arbitrary-command"; }, value => { value.lease.url = "https://foreign.invalid"; }]) {
    const item = fixture(); mutate(item);
    assert.equal(createP2CertificationFault(item.config, item.options).select(item.context), null); assert.equal(item.receipts.length, 0);
  }
});

test("only exact method/route/receiver/idempotency/canonical record matches", () => {
  for (const mutate of [value => { value.context.method = "GET"; }, value => { value.context.target += "?fault=true"; },
    value => { value.context.target = "/community/v1/internal/accounts/commands"; }, value => { value.context.route.auth = "webhook"; },
    value => { value.context.headers["x-idempotency-key"] = uuid(99); }, value => { value.context.body = Buffer.from(JSON.stringify({ ...value.command, action: "restore" })); },
    value => { value.context.body = Buffer.from("not-json-private-marker"); }]) {
    const item = fixture(); mutate(item); assert.equal(item.component.select(item.context), null);
  }
});

test("pre-await fuse reserves exactly one concurrent request and never rearms an upstream failure", () => {
  const item = fixture();
  const tokens = Array.from({ length: 64 }, () => item.component.select(item.context));
  assert.equal(tokens.filter(Boolean).length, 1);
  assert.equal(item.component.afterUpstream(tokens[0], { status: 503, body: Buffer.from("{}") }, response()), false);
  assert.equal(item.component.select(item.context), null); assert.equal(item.receipts.length, 0);
});

test("503 mode completes before upstream and emits only a matching actual response effect", () => {
  const item = fixture("503-before-upstream"), token = item.component.select(item.context), reply = response(); let calls = 0;
  assert.equal(item.component.beforeUpstream(token, reply, () => { calls++; reply.statusCode = 503; reply.headersSent = true; reply.writableEnded = true; }), true);
  assert.equal(calls, 1); assert.equal(item.receipts.length, 1); assert.equal(item.receipts[0].upstreamStarted, false);
  assert.equal(item.component.beforeUpstream(token, response(), () => { calls++; }), false); assert.equal(calls, 1);
  const raw = JSON.stringify(item.receipts); assert.equal(raw.includes(item.command.commandId), false); assert.equal(raw.includes(item.command.userId), false);
  assert.equal(raw.includes("PRIVATE-TOKEN"), false);
});

test("ACK loss requires complete typed200 with no downstream bytes and drops only once", () => {
  const item = fixture(), reply = response(), token = item.component.select(item.context);
  assert.equal(item.component.afterUpstream(token, accepted(item), reply), true); assert.equal(reply.destroyed, true);
  assert.equal(item.receipts[0].downstreamDisposition, "dropped-before-any-response-bytes");
  assert.equal(item.component.afterUpstream(token, accepted(item), reply), false); assert.equal(item.receipts.length, 1);
  for (const mutate of [value => { value.status = 409; }, value => { value.body = Buffer.from("{"); },
    value => { value.body = Buffer.from(JSON.stringify({ commandId: uuid(99), accountVersion: 4, status: "accepted" })); }]) {
    const other = fixture(), upstream = accepted(other), responseValue = response(); mutate(upstream);
    assert.equal(other.component.afterUpstream(other.component.select(other.context), upstream, responseValue), false); assert.equal(responseValue.destroyed, false);
  }
  const started = fixture(), responseValue = response(); responseValue.headersSent = true;
  assert.equal(started.component.afterUpstream(started.component.select(started.context), accepted(started), responseValue), false);
  assert.equal(responseValue.destroyed, false);
});

test("expiry, monotonic expiry and removal cancel an already reserved drop", () => {
  for (const change of [item => { item.clock.now += 120000; }, item => { item.clock.tick += 120000000000n; item.clock.now -= 5000; }, item => item.remove()]) {
    const item = fixture(), token = item.component.select(item.context), reply = response(); change(item);
    assert.equal(item.component.afterUpstream(token, accepted(item), reply), false); assert.equal(reply.destroyed, false); assert.equal(item.receipts.length, 0);
  }
});

test("same stage cannot be replaced or gateway process identity reused after restart", () => {
  const item = fixture(), token = item.component.select(item.context);
  item.lease.record.canonicalSha256 = "f".repeat(64);
  assert.equal(item.component.afterUpstream(token, accepted(item), response()), false);
  assert.equal(item.component.select(item.context), null);
  const restarted = fixture(); restarted.options.processBinding = () => "f".repeat(64);
  assert.equal(createP2CertificationFault(restarted.config, restarted.options).select(restarted.context), null);
});

function muxContext(item, id, createdAt) {
  return { method: "POST", target: "/course/v1/webhooks/mux", route: { method: "POST", path: "/v1/webhooks/mux", auth: "webhook" },
    headers: { "mux-signature": "PRIVATE-SIGNATURE-NEVER-LOG" }, body: Buffer.from(JSON.stringify({ id, type: "video.asset.track.ready", created_at: createdAt,
      environment: { id: item.lease.record.environmentId }, data: { id: "owned-track-" + id, asset_id: item.lease.record.assetId,
        passthrough: `lash-her-course:${item.lease.record.environmentId}:${item.lease.record.attemptId}`, privateExtra: "RAW-BODY-MARKER-NEVER-LOG" } })) };
}
const managed200 = item => ({ status: 200, body: Buffer.from(JSON.stringify({ videoAsset: { id: item.lease.record.attemptId, lessonId: item.lease.record.lessonId, status: "ready" } })) });
test("closed Mux profile emits only after exact managed200 and retains a fixed old/new/same-event metadata sequence", () => {
  const item = fixture("drop-after-ack", "mux-managed-track-ready-v1"), older = muxContext(item, "old-event", "2026-11-06T11:59:59.123456Z"), newer = muxContext(item, "new-event", "2026-11-06T11:59:59.123457Z");
  const oldToken = item.component.select(older), newToken = item.component.select(newer);
  assert.equal(item.component.afterUpstream(oldToken, managed200(item), response()), true);
  item.clock.tick += 1n;
  assert.equal(item.component.afterUpstream(newToken, managed200(item), response()), false);
  item.clock.tick += 1n;
  assert.equal(item.component.afterUpstream(item.component.select(older), managed200(item), response()), false);
  const observations = item.receipts.filter(row => row.status === "P2_MUX_VERIFIED_INGRESS_OBSERVED");
  assert.deepEqual(observations.map(row => row.eventId), ["old-event", "new-event", "old-event"]);
  assert.ok(observations.every(row => row.sourceManagedRowJoinRequired === true));
  assert.equal(item.receipts.filter(row => row.status === "P2_TRANSPORT_FAULT_INJECTED").length, 1);
  const raw = JSON.stringify(item.receipts); assert.equal(raw.includes("PRIVATE-SIGNATURE"), false); assert.equal(raw.includes("RAW-BODY-MARKER"), false);
  assert.ok(parseP2MuxCreatedAt(observations[0].createdAt) < parseP2MuxCreatedAt(observations[1].createdAt));
});

test("unmatched/ignored/legacy-identity Mux replies never establish verified managed ingress", () => {
  for (const mutate of [value => { value.status = 204; }, value => { value.body = Buffer.from(JSON.stringify({ videoAsset: { id: uuid(99), lessonId: uuid(11), status: "ready" } })); },
    value => { value.body = Buffer.from(JSON.stringify({ videoAsset: { id: uuid(10), lessonId: uuid(99), status: "ready" } })); }]) {
    const item = fixture("drop-after-ack", "mux-managed-track-ready-v1"), context = muxContext(item, "owned-event", "2026-11-06T12:00:00.000001Z"), upstream = managed200(item), reply = response();
    mutate(upstream); assert.equal(item.component.afterUpstream(item.component.select(context), upstream, reply), false);
    assert.equal(item.receipts.length, 0); assert.equal(reply.destroyed, false);
  }
});

test("timestamp ordering retains provider microseconds and timezone equivalence", () => {
  assert.equal(parseP2MuxCreatedAt("2026-11-06T12:00:00.123456Z"), parseP2MuxCreatedAt("2026-11-06T13:00:00.123456+01:00"));
  assert.equal(parseP2MuxCreatedAt("2026-11-06T12:00:00.123457Z") - parseP2MuxCreatedAt("2026-11-06T12:00:00.123456Z"), 1000n);
  assert.throws(() => parseP2MuxCreatedAt("not-date"));
});

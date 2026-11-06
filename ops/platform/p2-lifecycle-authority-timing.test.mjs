import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signProbeToken } from "./p2-identity-negative-probe.mjs";
import {
  captureAuthorityTiming,
  observeMuxAuthority,
  observeUserAuthority,
  qualifyS13AuthorityTiming,
  validatePrivateTimingInput,
} from "./p2-lifecycle-authority-timing.mjs";

const uuid = value => `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
const sha = value => value.repeat(64);
const key = "controlled-s13-course-learner-key-".padEnd(48, "k");
const nowSeconds = Date.parse("2026-11-06T12:00:00Z") / 1000;
const ownedCa = Buffer.from("owned-ca");
const fixture = { subject: uuid("a"), courseId: uuid("b"), lessonId: uuid("c"), bindingSha256: sha("1"),
  gatewayCaSha256: createHash("sha256").update(ownedCa).digest("hex") };
const http = (status, at, requestId = uuid("d")) => ({ status, serverDate: at, requestStartedAt: at,
  responseEndedAt: new Date(Date.parse(at) + 100).toISOString(), elapsedMs: 100, requestId });
const muxToken = (playbackId, exp) => signProbeToken({ sub: playbackId, aud: "v", exp }, "not-used-for-verification");

function captureInput() {
  return { version: 1, mode: "s13-capture", environment: "staging", ...fixture, currentKey: key };
}

async function captured() {
  const playbackId = "actualMuxPlaybackId_123", exp = nowSeconds + 600;
  return captureAuthorityTiming(captureInput(), {
    ca: ownedCa,
    nowMs: () => nowSeconds * 1000,
    randomUuid: () => uuid("e"),
    readCourse: async path => path.endsWith("/playback")
      ? { ...http(200, "2026-11-06T12:00:00.000Z", uuid("f")), contentType: "application/json", cacheControl: "private, no-store",
        body: Buffer.from(JSON.stringify({ playbackId, playbackToken: muxToken(playbackId, exp), expiresAt: new Date(exp * 1000).toISOString() })) }
      : { ...http(200, "2026-11-06T12:00:00.000Z"), contentType: "application/json", cacheControl: "private, no-store", body: Buffer.from("{}") },
    readMux: async () => http(200, "2026-11-06T12:00:01.000Z"),
  });
}

test("capture uses the controlled closed learner profile and actual Course playback result without exposing a fake issuer", async () => {
  const value = await captured();
  assert.equal(value.controlledUser.exp - value.controlledUser.iat, 300);
  assert.equal(value.labels.userIssuer, "operator-controlled-source-signed-course-learner");
  assert.equal(value.labels.frontendUserJwtCaptured, false);
  assert.equal(value.labels.playbackIssuer, "actual-course-mux-signer");
  assert.equal(value.labels.domainStateEffect, "video-asset-last-token-expires-at-only");
  assert.match(value.controlledUser.token, /^[^.]+\.[^.]+\.[^.]+$/u);
  assert.match(value.playback.requestUrl, /^https:\/\/stream\.mux\.com\//u);
});

test("owned HTTPS capture verifies TLS and refuses redirects and non-expiry provider/API failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-s13-tls-"));
  const certificate = join(directory, "cert.pem"), privateKey = join(directory, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=course-tls",
    "-addext", "subjectAltName=DNS:course-tls,DNS:stream.mux.com,IP:127.0.0.1", "-keyout", privateKey, "-out", certificate], { stdio: "ignore" });
  const ca = readFileSync(certificate), current = Math.floor(Date.now() / 1000), playbackId = "ownedActualTlsPlayback";
  let mode = "pass"; const calls = [];
  const server = createServer({ cert: ca, key: readFileSync(privateKey) }, (incoming, outgoing) => {
    calls.push({ method: incoming.method, url: incoming.url, authorization: incoming.headers.authorization ?? null });
    const headers = { date: new Date(current * 1000).toUTCString(), "x-request-id": uuid("1") };
    if (incoming.url?.endsWith(".m3u8") || incoming.url?.includes(".m3u8?")) {
      if (mode === "redirect") { outgoing.writeHead(302, { ...headers, location: "https://foreign.invalid" }); outgoing.end(); return; }
      outgoing.writeHead(mode === "provider-429" ? 429 : 200, { ...headers, "content-type": "application/vnd.apple.mpegurl" });
      outgoing.end("#EXTM3U\n"); return;
    }
    if (mode === "course-500") { outgoing.writeHead(500, { ...headers, "content-type": "application/json", "cache-control": "private, no-store" }); outgoing.end("{}"); return; }
    if (incoming.url?.endsWith("/playback")) {
      const exp = current + 600;
      outgoing.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "private, no-store" });
      outgoing.end(JSON.stringify({ playbackId, playbackToken: muxToken(playbackId, exp), expiresAt: new Date(exp * 1000).toISOString() })); return;
    }
    outgoing.writeHead(200, { ...headers, "content-type": "application/json", "cache-control": "private, no-store" }); outgoing.end("{}");
  });
  server.on("tlsClientError", () => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const connector = (options, callback) => request({ ...options, hostname: "127.0.0.1", port: server.address().port, ca }, callback);
  const input = { ...captureInput(), gatewayCaSha256: createHash("sha256").update(ca).digest("hex") };
  try {
    const result = await captureAuthorityTiming(input, { ca, nowMs: () => current * 1000, randomUuid: () => uuid("2"),
      courseRequest: connector, muxRequest: connector });
    assert.equal(result.playback.initialProviderAccess.status, 200);
    assert.ok(calls.every(row => row.method === "GET"));
    assert.ok(calls.filter(row => row.url?.startsWith("/v1/")).every(row => row.authorization?.startsWith("Bearer ")));
    assert.equal(calls.find(row => row.url?.includes(".m3u8"))?.authorization, null);
    for (const [selectedMode, check] of [["redirect", "redirect-refused"], ["provider-429", "mux-initial-access"], ["course-500", "controlled-user-baseline"]]) {
      mode = selectedMode;
      await assert.rejects(() => captureAuthorityTiming(input, { ca, nowMs: () => current * 1000, randomUuid: () => uuid("2"),
        courseRequest: connector, muxRequest: connector }), { check });
    }
    await assert.rejects(() => captureAuthorityTiming({ ...input, gatewayCaSha256: createHash("sha256").update("other").digest("hex") },
      { ca, nowMs: () => current * 1000, courseRequest: connector, muxRequest: connector }), { check: "running-ca-binding" });
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private observations accept only Course 200/401 and Mux 200/206/401/403", async () => {
  const capture = await captured();
  const userInput = { version: 1, mode: "s13-user-observe", environment: "staging", bindingSha256: fixture.bindingSha256,
    subject: fixture.subject, courseId: fixture.courseId, userToken: capture.controlledUser.token,
    iat: capture.controlledUser.iat, exp: capture.controlledUser.exp, gatewayCaSha256: fixture.gatewayCaSha256 };
  const user = await observeUserAuthority(userInput, { ca: ownedCa, readCourse: async () => http(401, "2026-11-06T12:05:30.000Z") });
  assert.equal(user.observation.status, 401);
  await assert.rejects(() => observeUserAuthority(userInput, { ca: ownedCa, readCourse: async () => http(429, "2026-11-06T12:05:30.000Z") }),
    { check: "user-expiry-status" });
  const muxInput = { version: 1, mode: "s13-mux-observe", environment: "staging", bindingSha256: fixture.bindingSha256,
    requestUrl: capture.playback.requestUrl, playbackId: capture.playback.playbackId, exp: capture.playback.exp };
  assert.equal((await observeMuxAuthority(muxInput, { readMux: async () => http(403, "2026-11-06T12:10:00.000Z") })).observation.status, 403);
  await assert.rejects(() => observeMuxAuthority(muxInput, { readMux: async () => http(500, "2026-11-06T12:10:00.000Z") }),
    { check: "mux-expiry-status" });
});

test("Mux observer refuses alternate hosts, paths, query expansion and mismatched token subject or expiry", async () => {
  const capture = await captured();
  const base = { version: 1, mode: "s13-mux-observe", environment: "staging", bindingSha256: fixture.bindingSha256,
    requestUrl: capture.playback.requestUrl, playbackId: capture.playback.playbackId, exp: capture.playback.exp };
  for (const mutate of [
    value => { value.requestUrl = value.requestUrl.replace("stream.mux.com", "example.invalid"); },
    value => { value.requestUrl += "&extra=1"; },
    value => { value.playbackId += "other"; },
    value => { value.exp += 1; },
  ]) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => validatePrivateTimingInput(value));
  }
});

function qualification() {
  const userExp = nowSeconds + 300, muxExp = nowSeconds + 600;
  return {
    version: 1, environment: "staging", bindingSha256: fixture.bindingSha256,
    s12: { receiptSha256: sha("3"), sourceSha256: sha("0"), configurationSha256: sha("5"), commandId: uuid("6"), accountVersion: 1,
      action: "suspend", nativeScheduleEnabled: false,
      workerInvokedAt: "2026-11-06T12:05:32.000Z", receiverDeniedCount: 2 },
    capturePublic: {
      controlledUser: { iat: nowSeconds, exp: userExp, baseline: http(200, "2026-11-06T12:00:00.000Z") },
      playback: { exp: muxExp, courseAuthorization: http(200, "2026-11-06T12:00:00.000Z"), initialProviderAccess: http(200, "2026-11-06T12:00:01.000Z") },
      labels: { userIssuer: "operator-controlled-source-signed-course-learner", frontendUserJwtCaptured: false,
        playbackIssuer: "actual-course-mux-signer", authorizationQuotaConsumed: true,
        domainStateEffect: "video-asset-last-token-expires-at-only" },
    },
    user: { lastAccepted: http(200, "2026-11-06T12:05:29.000Z"), firstDenied: http(401, "2026-11-06T12:05:30.000Z"), pollResolutionMs: 1000 },
    pending: { version: 1, status: "P2_S13_FRONTEND_PENDING_STATE_OBSERVED", sourceSha256: sha("4"), configurationSha256: sha("5"),
      commandId: uuid("6"), accountVersion: 1, capturedAt: "2026-11-06T12:05:31.000Z", laterCommandCount: 0,
      deliveries: [{ receiver: "course", status: "pending", attempts: 0, leaseId: null, acknowledgedAt: null },
        { receiver: "community", status: "pending", attempts: 0, leaseId: null, acknowledgedAt: null }] },
    browser: { version: 1, status: "P2_S12_NORMAL_UI_SUSPENSION_OBSERVED", evidenceClass: "external-source-browser-machine-artifact",
      sourceSha256: sha("7"), artifactSha256: sha("8"),
      suspension: { commandId: uuid("6"), accountVersion: 1, issuedAt: "2026-11-06T12:00:02.000Z", requestId: uuid("9"), httpStatus: 202 },
      renewal: { requestId: uuid("a"), httpStatus: 401, observedAt: "2026-11-06T12:09:30.000Z" },
      player: { selector: "mux-player", count: 0, observedAt: "2026-11-06T12:09:31.000Z", traceEventCount: 2 } },
    mux: { lastAccepted: http(200, "2026-11-06T12:09:59.000Z"), firstDenied: http(403, "2026-11-06T12:10:00.000Z"), pollResolutionMs: 1000 },
    lifecycle: { version: 1, status: "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED", profile: "lifecycle-account-v1",
      candidateSha256: sha("b"), configurationSha256: sha("c"), sourceSha256: sha("d"), targetSha256: sha("e"), witnessSha256: sha("f"),
      commandCount: 1, pendingOrDeliveringCount: 0, receiverAcknowledgedCount: 2, rowCounts: { frontend: 5, course: 3, community: 3 },
      readOnly: true, providerTouched: false, releaseAccepted: false, privateRecordSha256: sha("1"), operatorProgramSha256: sha("2"),
      commandId: uuid("6"), accountVersion: 1 },
  };
}

test("qualification retains measured evaluation brackets, pending deliveries, both ACKs and separate browser evidence class", () => {
  assert.throws(() => validatePrivateTimingInput({ version: 1, mode: "s13-qualify", environment: "staging", qualification: qualification() }));
  const result = qualifyS13AuthorityTiming(qualification());
  assert.equal(result.status, "P2_S13_AUTHORITY_TIMING_QUALIFIED");
  assert.equal(result.pendingDeliveryCountAtUserDenial, 2);
  assert.equal(result.acknowledgedReceiverCount, 2);
  assert.equal(result.controlledUserIssuer, "operator-controlled-source-signed-course-learner");
  assert.equal(result.frontendUserJwtCaptured, false);
  assert.equal(result.playbackCleanupFenceExtended, true);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /stream\.mux\.com|eyJ|requestUrl|playbackId|userToken/u);
});

test("qualification refuses accepted-after-boundary, early worker activity, weak browser booleans and Mux grace", () => {
  for (const mutate of [
    value => { value.user.firstDenied.status = 200; },
    value => { value.user.firstDenied.requestStartedAt = "2026-11-06T12:05:29.900Z"; },
    value => { value.pending.deliveries[0].attempts = 1; },
    value => { value.pending.deliveries[1].status = "acknowledged"; },
    value => { value.browser.player.traceEventCount = 0; },
    value => { value.mux.firstDenied.status = 200; },
    value => { value.mux.firstDenied.requestStartedAt = "2026-11-06T12:10:02.001Z"; },
    value => { value.user.firstDenied.serverDate = "2026-11-06T11:00:00.000Z"; },
    value => { value.lifecycle.receiverAcknowledgedCount = 1; },
    value => { value.lifecycle.commandId = uuid("b"); },
    value => { value.s12.accountVersion = 2; },
    value => { value.browser.suspension.issuedAt = "2026-11-06T11:59:59.000Z"; },
    value => { value.browser.renewal.observedAt = "2026-11-06T12:00:01.000Z"; },
  ]) {
    const value = qualification(); mutate(value);
    assert.throws(() => qualifyS13AuthorityTiming(value));
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, renameSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createGateway } from "./server.mjs";
import { createPrivateTlsProxy } from "./private-tls.mjs";
import { createHash } from "node:crypto";
import { createP2CertificationFault, p2GatewayProcessBinding } from "./p2-certification-fault.mjs";
import { createAdmissionReader, scopedMuxTarget, SCOPED_MUX_HEADER } from "./admission.mjs";

let folder, key, cert, keyFile, certFile, wrongCertFile;
before(() => {
  folder = mkdtempSync(join(tmpdir(), "lash-gateway-test-"));
  keyFile = join(folder, "key.pem"); certFile = join(folder, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyFile,
    "-out", certFile, "-subj", "/CN=localhost.localdomain", "-addext", "subjectAltName=DNS:localhost.localdomain,DNS:other.test,DNS:api-staging.lashher.com,IP:127.0.0.1"], { stdio: "ignore" });
  wrongCertFile = join(folder, "wrong-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(folder, "wrong-key.pem"),
    "-out", wrongCertFile, "-subj", "/CN=untrusted.test"], { stdio: "ignore" });
  key = readFileSync(keyFile); cert = readFileSync(certFile);
});
after(() => rmSync(folder, { recursive: true, force: true }));

async function fixture(t, handler, overrides = {}, options = {}) {
  const upstream = createServer({ key, cert }, handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const config = {
    issuer: "https://oidc.vercel.com/test-team", audience: "https://vercel.com/test-team",
    subject: "owner:test-team:project:test-project:environment:production", ownerId: "team_test", projectId: "prj_test",
    environment: "production", appEnv: "staging", publicHost: "localhost.localdomain",
    courseOrigin: `https://127.0.0.1:${upstream.address().port}`,
    tlsKeyFile: keyFile, tlsCertFile: certFile, upstreamCaFile: certFile, ...overrides,
  };
  const { server, counters, admissionState } = createGateway(config, {
    verify: async (proof) => { if (proof !== "synthetic-valid-proof") throw new Error("invalid"); return { projectId: config.projectId }; },
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all([server, upstream].map((item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); })));
  });
  return {
    counters, admissionState,
    send: ({ path = "/course/v1/courses", method = "GET", headers = {}, body, servername = config.publicHost.split(":")[0], rawHeaders } = {}) => new Promise((resolve, reject) => {
      const call = request({ host: "127.0.0.1", port: server.address().port, path, method, servername, ca: cert,
        headers: rawHeaders ?? { host: config.publicHost, "x-lash-workload-token": "synthetic-valid-proof", ...headers } }, (reply) => {
        const chunks = [];
        reply.on("data", (chunk) => chunks.push(chunk));
        reply.on("end", () => resolve({ status: reply.statusCode, headers: reply.headers, body: Buffer.concat(chunks).toString() }));
        reply.on("error", reject);
      });
      call.on("error", reject); call.end(body);
    }),
  };
}

let certificationSequence = 0;
const certificationHash = value => createHash("sha256").update(value).digest("hex");
const certificationCanonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
async function certificationFixture(t, handler, mode = "drop-after-ack", profile = "lifecycle-known-command-v1") {
  const candidateSha256 = "a".repeat(64), file = join(folder, `certification-admission-${++certificationSequence}.json`);
  const admission = { file, candidateSha256, releaseId: "owned-certification" };
  const saveAdmission = recovery => writeFileSync(file, JSON.stringify({ version: 1, environment: "staging", candidateSha256,
    releaseId: admission.releaseId, actionId: "owned-certification", newWork: false, recovery }));
  saveAdmission(true);
  const command = { version: 1, commandId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002",
    accountVersion: 2, action: "suspend", issuedAt: new Date().toISOString() };
  const record = profile === "lifecycle-known-command-v1"
    ? { commandId: command.commandId, accountVersion: command.accountVersion, canonicalSha256: certificationHash(certificationCanonical(command)) }
    : { attemptId: "00000000-0000-4000-8000-000000000003", lessonId: "00000000-0000-4000-8000-000000000004", generation: 2,
      environmentId: "owned-environment", assetId: "owned-asset", uploadId: "owned-upload", eventType: "video.asset.track.ready" };
  const effects = [];
  let lease;
  const f = await fixture(t, handler, { admission, ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
    publicHost: "api-staging.lashher.com" }, {
    certificationFault(config) {
      const gateway = Buffer.from(JSON.stringify(config));
      const processBinding = p2GatewayProcessBinding({ bootId: "00000000-0000-4000-8000-000000000005", pid: 1, startTicks: "123" });
      const now = Date.now();
      lease = { version: 1, environment: "staging", profile, stageId: "owned-certification", releaseId: admission.releaseId, candidateSha256,
        configurationSha256: "b".repeat(64), gatewayConfigurationSha256: certificationHash(gateway), gatewayProcessSha256: processBinding,
        gatewayImageSha256: "c".repeat(64), sourceWitnessSha256: "d".repeat(64), issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120000).toISOString(), maxMatches: 1, mode, receiver: "course", record };
      // Only fixed filesystem/process readers are projected for this owned
      // fixture. Real gateway auth, admission and both TLS hops remain active.
      return createP2CertificationFault({ ...config, admission: { ...config.admission, file: "/admission/state.json" } }, {
        readLease: () => Buffer.from(JSON.stringify(lease)), readGateway: () => gateway, processBinding: () => processBinding,
        emit: receipt => effects.push(receipt),
      });
    },
  });
  return { ...f, effects, command, record, saveAdmission, input: { method: "POST", path: "/course/v1/internal/accounts/commands",
    headers: { authorization: "Bearer owned.lifecycle.jwt", "x-idempotency-key": command.commandId }, body: JSON.stringify(command) } };
}

test("scoped Mux admission forwards only the selected managed callback and mints its own target header", async t => {
  const directory = mkdtempSync(join(folder, "mux-admission-"));
  const file = join(directory, "state.json"), identity = statSync(directory, { bigint: true });
  const admission = { file, releaseId: "owned-certification", candidateSha256: "a".repeat(64) };
  const attemptId = "00000000-0000-4000-8000-000000000003";
  const start = Date.now(), processSha = "b".repeat(64);
  const scope = { gatewayProcessSha256: processSha, mountDevice: String(identity.dev), mountInode: String(identity.ino),
    issuedAt: new Date(start - 1000).toISOString(), expiresAt: new Date(start + 30_000).toISOString(),
    environmentId: "owned-environment", attemptId, generation: 2, assetId: "owned-asset", uploadId: "owned-upload",
    eventType: "video.asset.track.ready" };
  const state = { version: 2, environment: "staging", releaseId: admission.releaseId, candidateSha256: admission.candidateSha256,
    actionId: "owned-mux-window", newWork: false, recovery: false, muxCallback: scope };
  const save = value => writeFileSync(file, certificationCanonical(value) + "\n", { mode: 0o644 });
  save(state);
  const staging = { admission, appEnv: "staging", publicHost: "api-staging.lashher.com",
    ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" };
  assert.equal(createAdmissionReader(staging, { processBinding: () => processSha })().valid, false);
  const forwarded = [];
  let processReads = 0, driftOnRecheck = false, dropCourseResponse = false;
  let wall = start, tick = 0n;
  const backend = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push({ path: request.url, target: request.headers[SCOPED_MUX_HEADER],
      signature: request.headers["mux-signature"], body: Buffer.concat(chunks).toString() });
    if (dropCourseResponse) {
      response.destroy();
      return;
    }
    response.end(JSON.stringify({ videoAsset: { id: attemptId,
      lessonId: "00000000-0000-4000-8000-000000000004", status: "processing" } }));
  });
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  const proxy = createPrivateTlsProxy({ keyFile, certFile, upstream: `http://127.0.0.1:${backend.address().port}`,
    peers: [{ address: "127.0.0.1", routes: [{ method: "POST", path: "/v1/webhooks/mux" }] }] });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => Promise.all([proxy, backend].map(server => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  }))));
  const f = await fixture(t, (_request, response) => response.end(), {
    ...staging, courseOrigin: `https://127.0.0.1:${proxy.address().port}`,
  }, {
    scopedMuxAdmission: {
      processBinding() {
        processReads++;
        return driftOnRecheck && processReads % 2 === 0 ? "c".repeat(64) : processSha;
      },
      storageAuthority: candidate => candidate === file,
      now: () => wall,
      monotonic: () => tick,
    },
  });
  const data = { id: "owned-track", asset_id: scope.assetId,
    passthrough: `lash-her-course:${scope.environmentId}:${attemptId}` };
  const event = { id: "owned-event", type: scope.eventType, environment: { id: scope.environmentId }, data };
  const signature = "owned-provider-signature";
  const input = { method: "POST", path: "/course/v1/webhooks/mux",
    headers: { "mux-signature": signature, [SCOPED_MUX_HEADER]: "foreign:1" }, body: JSON.stringify(event) };
  assert.equal((await f.send(input)).status, 200);
  assert.deepEqual(forwarded, [{ path: "/v1/webhooks/mux", target: `${attemptId}:2`, signature, body: input.body }]);
  for (const changed of [
    { ...event, environment: { id: "foreign-environment" } },
    { ...event, type: "video.asset.track.deleted" },
    { ...event, data: { ...data, asset_id: "foreign-asset" } },
    { ...event, data: { ...data, passthrough: "foreign-attempt" } },
  ]) {
    assert.equal((await f.send({ ...input, body: JSON.stringify(changed) })).status, 503);
  }
  assert.equal((await f.send({ ...input, body: "{}" })).status, 503);
  assert.equal((await f.send({ ...input, headers: { "mux-signature": "" } })).status, 503);
  assert.equal((await f.send({ ...input, body: "x".repeat(65_537) })).status, 413);
  assert.equal((await f.send({ method: "POST", path: "/course/v1/internal/accounts/commands",
    headers: { authorization: "Bearer owned.lifecycle.jwt" }, body: "{}" })).status, 503);
  assert.equal((await f.send({ ...input, path: input.path + "?foreign=1" })).status, 503);
  for (const muxCallback of [
    { ...scope, mountInode: String(identity.ino + 1n) },
    { ...scope, gatewayProcessSha256: "c".repeat(64) },
    { ...scope, expiresAt: new Date(start - 1).toISOString() },
  ]) {
    save({ ...state, muxCallback });
    assert.equal((await f.send(input)).status, 503);
  }
  const canonical = certificationCanonical(state) + "\n";
  writeFileSync(file, canonical.replace('"version":2', '"version":2,"version":2'));
  assert.equal((await f.send(input)).status, 503);
  save({ ...state, actionId: "owned-mux-drift" }); processReads = 0; driftOnRecheck = true;
  assert.equal((await f.send(input)).status, 503);
  driftOnRecheck = false;
  const observedState = { ...state, actionId: "owned-mux-observed" };
  save(observedState);
  const observation = f.admissionState();
  assert.equal(observation.version, 2);
  assert.equal(observation.muxCallbackActive, true);
  assert.equal(observation.valid, false);
  assert.equal(observation.newWork, null);
  assert.equal(observation.recovery, null);
  assert.equal(Object.hasOwn(observation, "muxCallback"), false);
  assert.deepEqual(observation.uncertain, { newWork: 0, recovery: 0 });
  save({ version: 1, environment: "staging", releaseId: admission.releaseId, candidateSha256: admission.candidateSha256,
    actionId: observedState.actionId, newWork: false, recovery: false });
  assert.equal((await f.send(input)).status, 503);
  save(observedState);
  assert.equal((await f.send(input)).status, 503);
  save({ ...state, actionId: "owned-mux-clock" });
  wall = start + 1000;
  assert.equal(f.admissionState().muxCallbackActive, true);
  tick = 30_000_000_000n; wall = start;
  assert.equal((await f.send(input)).status, 503);
  assert.equal(forwarded.length, 1);
  save({ version: 1, environment: "staging", releaseId: admission.releaseId, candidateSha256: admission.candidateSha256,
    actionId: "owned-recovery", newWork: false, recovery: true });
  assert.equal((await f.send(input)).status, 200);
  assert.deepEqual(forwarded[1], { path: "/v1/webhooks/mux", target: undefined, signature, body: input.body });
  save({ ...state, actionId: "owned-mux-lost-ack" }); dropCourseResponse = true;
  assert.equal((await f.send(input)).status, 502);
  assert.equal(forwarded[2].target, `${attemptId}:2`);
  assert.deepEqual(f.admissionState().active, { newWork: 0, recovery: 0 });
  assert.deepEqual(f.admissionState().uncertain, { newWork: 0, recovery: 1 });
});

test("scoped Mux selection binds upload IDs and requires a managed marker for an unknown asset", () => {
  const attemptId = "00000000-0000-4000-8000-000000000003";
  const environmentId = "owned-environment", signature = "owned-provider-signature";
  const marker = `lash-her-course:${environmentId}:${attemptId}`;
  const scope = { attemptId, environmentId, generation: 2, uploadId: "owned-upload", assetId: null };
  const event = { id: "owned-event", environment: { id: environmentId } };
  const check = (eventType, data) => scopedMuxTarget({ ...scope, eventType },
    Buffer.from(JSON.stringify({ ...event, type: eventType, data })), signature);
  assert.equal(check("video.upload.asset_created", { id: scope.uploadId, asset_id: "owned-asset" }), `${attemptId}:2`);
  assert.equal(check("video.upload.asset_created", { id: "foreign-upload", asset_id: "owned-asset" }), null);
  assert.equal(check("video.asset.ready", { id: "owned-asset" }), null);
  assert.equal(check("video.asset.ready", { id: "owned-asset", passthrough: marker }), `${attemptId}:2`);
});

test("certification503 runs only after actual auth/admission and before any TLS upstream effect", async t => {
  let calls = 0;
  const f = await certificationFixture(t, (_req, res) => { calls++; res.end("{}"); }, "503-before-upstream");
  assert.equal((await f.send({ ...f.input, headers: { ...f.input.headers, "x-lash-workload-token": "" } })).status, 401);
  assert.equal((await f.send({ ...f.input, headers: { ...f.input.headers, authorization: "" } })).status, 401);
  f.saveAdmission(false);
  assert.equal((await f.send(f.input)).status, 503);
  assert.equal(f.effects.length, 0); assert.equal(calls, 0);
  f.saveAdmission(true);
  const refused = await f.send(f.input);
  assert.equal(refused.status, 503); assert.equal(refused.headers["retry-after"], "1"); assert.equal(calls, 0);
  assert.equal(JSON.parse(refused.body).error.code, "upstream_unavailable");
  assert.equal(f.effects.length, 1); assert.equal(f.effects[0].upstreamStarted, false);
  assert.equal((await f.send(f.input)).status, 200); assert.equal(calls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.admissionState().active, { newWork: 0, recovery: 0 });
  assert.deepEqual(f.admissionState().uncertain, { newWork: 0, recovery: 0 });
});

test("certification ACK loss drops actual complete upstream200 before response bytes and preserves uncertainty", async t => {
  let calls = 0, f;
  f = await certificationFixture(t, async (req, res) => {
    calls++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), f.input.body);
    res.writeHead(200, { "content-type": "application/json", "retry-after": "7" });
    res.end(JSON.stringify({ commandId: f.command.commandId, accountVersion: 2, status: calls === 1 ? "accepted" : "duplicate" }));
  });
  await assert.rejects(f.send(f.input), error => error.code === "ECONNRESET");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(f.effects.length, 1); assert.equal(f.effects[0].downstreamBytesStarted, false);
  assert.equal(f.effects[0].upstreamReceiptVerified, true);
  assert.deepEqual(f.admissionState().active, { newWork: 0, recovery: 0 });
  assert.deepEqual(f.admissionState().uncertain, { newWork: 0, recovery: 1 });
  const replay = await f.send(f.input);
  assert.equal(replay.status, 200); assert.equal(replay.headers["retry-after"], "7");
  assert.equal(JSON.parse(replay.body).status, "duplicate"); assert.equal(calls, 2); assert.equal(f.effects.length, 1);
  assert.equal(f.admissionState().uncertain.recovery, 1);
});

test("certification never turns untyped or unsuccessful upstream replies into ACK-loss proof", async t => {
  for (const [status, body] of [[200, '{"unrelated":true}'], [409, '{"error":{"code":"ACCOUNT_VERSION_CONFLICT"}}']]) {
    const f = await certificationFixture(t, (_req, res) => { res.writeHead(status); res.end(body); });
    const value = await f.send(f.input);
    assert.equal(value.status, status); assert.equal(value.body, body); assert.deepEqual(f.effects, []);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.admissionState().uncertain.recovery, 0);
  }
});

test("certification Mux profile sees actual raw bytes and signature then drops only verified managed200", async t => {
  let f, received, signature;
  f = await certificationFixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString(); signature = req.headers["mux-signature"];
    res.end(JSON.stringify({ videoAsset: { id: f.record.attemptId, lessonId: f.record.lessonId, status: "ready" } }));
  }, "drop-after-ack", "mux-managed-track-ready-v1");
  const body = JSON.stringify({ id: "owned-event", type: f.record.eventType, created_at: new Date().toISOString(), environment: { id: f.record.environmentId },
    data: { id: "owned-track", asset_id: f.record.assetId, passthrough: `lash-her-course:${f.record.environmentId}:${f.record.attemptId}` } });
  const input = { method: "POST", path: "/course/v1/webhooks/mux", body, headers: { "mux-signature": "owned-signature-private" } };
  await assert.rejects(f.send(input), error => error.code === "ECONNRESET");
  assert.equal(received, body); assert.equal(signature, "owned-signature-private");
  assert.deepEqual(f.effects.map(value => value.status), ["P2_MUX_VERIFIED_INGRESS_OBSERVED", "P2_TRANSPORT_FAULT_INJECTED"]);
  assert.equal(f.effects[0].sourceManagedRowJoinRequired, true);
  assert.equal((await f.send(input)).status, 200);
  assert.equal(f.effects.filter(value => value.status === "P2_TRANSPORT_FAULT_INJECTED").length, 1);
  assert.equal(JSON.stringify(f.effects).includes("owned-signature-private"), false);
});

test("private TLS upstream receives only selected headers, original query and application authorization", async (t) => {
  let received;
  const f = await fixture(t, (req, res) => { received = req; res.end('{"courses":[]}'); });
  const result = await f.send({ path: "/course/v1/student/courses?cursor=x%2Fy", headers: {
    authorization: "Bearer application.jwt.proof", "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8",
    "x-user-id": "forged", forwarded: "for=8.8.8.8", cookie: "session=private", "x-request-id": "caller-id",
    "x-vercel-oidc-token": "forged", "mux-signature": "forged",
  } });
  assert.equal(result.status, 200);
  assert.equal(received.url, "/v1/student/courses?cursor=x%2Fy");
  assert.equal(received.headers.authorization, "Bearer application.jwt.proof");
  assert.equal(received.socket.remoteAddress, "127.0.0.1");
  for (const name of ["x-lash-workload-token", "x-forwarded-for", "x-real-ip", "x-user-id", "forwarded", "cookie", "x-vercel-oidc-token", "mux-signature"]) assert.equal(received.headers[name], undefined, name);
  assert.match(received.headers["x-request-id"], /^[a-f0-9-]{36}$/u);
  assert.equal(result.headers["cache-control"], "no-store");
});

test("same lifecycle paths route to their explicit service and never expose private enrollment routes", async t => {
  let communityCalls = 0, courseCalls = 0;
  const community = createServer({ key, cert }, (req, res) => {
    communityCalls++;
    assert.equal(req.url, "/v1/internal/accounts/commands");
    assert.equal(req.headers.authorization, "Bearer lifecycle.jwt");
    assert.equal(req.headers.cookie, undefined);
    res.setHeader("content-type", "application/json"); res.end('{"receiver":"community"}');
  });
  await new Promise(resolve => community.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { community.close(resolve); community.closeAllConnections(); }));
  const f = await fixture(t, (_req, res) => { courseCalls++; res.end('{"receiver":"course"}'); }, { communityOrigin: `https://127.0.0.1:${community.address().port}` });
  const input = { method: "POST", headers: { authorization: "Bearer lifecycle.jwt", cookie: "must-not-forward=private" }, body: "{}" };
  assert.equal((await f.send({ ...input, path: "/community/v1/internal/accounts/commands" })).body, '{"receiver":"community"}');
  assert.equal((await f.send({ ...input, path: "/course/v1/internal/accounts/commands" })).body, '{"receiver":"course"}');
  assert.equal((await f.send({ ...input, path: "/community/v1/internal/course/enrollment-events" })).status, 404);
  assert.equal((await f.send({ ...input, path: "/community/v1/courses" })).status, 404);
  assert.equal((await f.send({ ...input, path: "/community/v1/internal/accounts/commands", headers: { cookie: "session=browser" } })).status, 401);
  assert.equal(communityCalls, 1); assert.equal(courseCalls, 1);
});

test("missing optional Community upstream fails closed without forwarding to Course", async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end("{}"); });
  assert.equal((await f.send({ path: "/community/v1/internal/accounts/exports/a", headers: { authorization: "Bearer lifecycle" } })).status, 503);
  assert.equal(calls, 0);
});

test("host fence changes immediately for historical callers while recovery remains independent", async (t) => {
  const file = join(folder, "admission.json");
  const binding = { file, candidateSha256: "a".repeat(64), releaseId: "fixture" };
  const state = { version: 1, environment: "staging", candidateSha256: binding.candidateSha256,
    releaseId: "fixture", actionId: "p1-admit-fixture", newWork: false, recovery: false };
  const save = (value) => { writeFileSync(file + ".next", JSON.stringify(value)); renameSync(file + ".next", file); };
  const calls = [];
  const f = await fixture(t, (req, res) => { calls.push(req.url); res.end('{}'); }, { maintenance: true, admission: binding });
  const recovery = { path: "/course/v1/internal/entitlements/reconcile", method: "POST", headers: { authorization: "Bearer service" } };
  const authoring = { path: "/course/v1/admin/courses", method: "POST", headers: { authorization: "Bearer admin" } };
  assert.equal((await f.send(recovery)).status, 503); // missing file
  save(state);
  assert.equal((await f.send(recovery)).status, 503);
  save({ ...state, recovery: true });
  assert.equal((await f.send(recovery)).status, 200);
  assert.equal((await f.send(authoring)).status, 503);
  assert.equal((await f.send({ path: "/course/v1/webhooks/mux", method: "POST", body: '{}' })).status, 200);
  assert.equal((await f.send()).status, 200);
  save({ ...state, newWork: true });
  assert.equal((await f.send(authoring)).status, 200);
  assert.equal((await f.send(recovery)).status, 503);
  assert.equal((await f.send({ path: "/course/admission" })).status, 404);
  assert.equal(f.admissionState().valid, true);
  assert.equal(calls.length, 4);
  for (const value of [{ ...state, candidateSha256: "b".repeat(64), recovery: true },
    { ...state, environment: "production", recovery: true }, { ...state, newWork: "false", recovery: true },
    { ...state, releaseId: "other", recovery: true }]) {
    save(value);
    assert.equal((await f.send(recovery)).status, 503);
  }
  writeFileSync(file, '{');
  assert.equal((await f.send(recovery)).status, 503);
  rmSync(file); symlinkSync(certFile, file);
  assert.equal((await f.send(recovery)).status, 503);
  rmSync(file);
});

test("fencing accounts for admitted delayed work before reporting drained", async (t) => {
  const file = join(folder, "delayed-admission.json");
  const binding = { file, candidateSha256: "a".repeat(64), releaseId: "fixture" };
  const state = { version: 1, environment: "staging", candidateSha256: binding.candidateSha256,
    releaseId: "fixture", actionId: "p1-admit-fixture", newWork: true, recovery: true };
  writeFileSync(file, JSON.stringify(state));
  let releaseReply, reached;
  const entered = new Promise(resolve => { reached = resolve; });
  const f = await fixture(t, (_req, res) => { releaseReply = () => res.end('{}'); reached(); }, { admission: binding });
  const operation = { path: "/course/v1/admin/courses", method: "POST", headers: { authorization: "Bearer admin" } };
  const pending = f.send(operation);
  await entered;
  assert.deepEqual(f.admissionState().active, { newWork: 1, recovery: 0 });
  writeFileSync(file, JSON.stringify({ ...state, newWork: false }));
  assert.equal((await f.send(operation)).status, 503);
  assert.equal(f.admissionState().active.newWork, 1);
  releaseReply();
  assert.equal((await pending).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.admissionState().active.newWork, 0);
});

test("an upstream disconnect preserves mutation uncertainty even after transport drain", async (t) => {
  const file = join(folder, "uncertain-admission.json");
  const binding = { file, candidateSha256: "a".repeat(64), releaseId: "fixture" };
  writeFileSync(file, JSON.stringify({ version: 1, environment: "staging", candidateSha256: binding.candidateSha256,
    releaseId: "fixture", actionId: "p1-admit-fixture", newWork: true, recovery: true }));
  const f = await fixture(t, (req) => req.socket.destroy(), { admission: binding });
  assert.equal((await f.send({ path: "/course/v1/admin/courses", method: "POST", headers: { authorization: "Bearer admin" } })).status, 502);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.admissionState().active.newWork, 0);
  assert.equal(f.admissionState().uncertain.newWork, 1);
  assert.equal(f.admissionState().uncertain.recovery, 0);
});

test("missing workload, OIDC-only protected requests, wrong host and duplicate credentials never reach upstream", async (t) => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => { calls++; res.end(); });
  assert.equal((await f.send({ headers: { "x-lash-workload-token": "", authorization: "Bearer app" } })).status, 401);
  assert.equal((await f.send({ path: "/course/v1/student/courses" })).status, 401);
  assert.equal((await f.send({ headers: { host: "attacker.test" } })).status, 421);
  assert.equal((await f.send({ servername: "other.test" })).status, 421);
  assert.equal((await f.send({ rawHeaders: ["Host", "localhost.localdomain", "X-Lash-Workload-Token", "synthetic-valid-proof", "X-Lash-Workload-Token", "second"] })).status, 400);
  assert.equal((await f.send({ rawHeaders: ["Host", "localhost.localdomain", "X-Lash-Workload-Token", "synthetic-valid-proof", "Authorization", "Bearer a", "Authorization", "Bearer b"] })).status, 400);
  assert.equal((await f.send({ path: "/course/v1/internal/community/entitlements/check", method: "POST" })).status, 404);
  assert.equal((await f.send({ path: "/course/metrics" })).status, 404);
  assert.equal(calls, 0);
});

test("maintenance holds application writes while read probes and signed callback forwarding remain available", async (t) => {
  const calls = [];
  const f = await fixture(t, (req, res) => { calls.push(req.url); res.end('{}'); }, { maintenance: true });
  const result = await f.send({ path: "/course/v1/internal/entitlements/grants", method: "POST", headers: { authorization: "Bearer app" } });
  assert.equal(result.status, 503); assert.equal(result.headers["retry-after"], "30");
  assert.equal((await f.send()).status, 200);
  assert.equal((await f.send({ path: "/course/v1/webhooks/mux", method: "POST", headers: { "mux-signature": "fixture-signed" }, body: '{}' })).status, 200);
  assert.deepEqual(calls, ["/v1/courses", "/v1/webhooks/mux"]);
});

test("exact Mux exception preserves raw bytes/signature; other webhook methods are denied", async (t) => {
  const body = '{ "type": "video.test", "data": {"id":"fixture"} }\n';
  let received, signature;
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString(); signature = req.headers["mux-signature"];
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(400); res.end('{"error":{"code":"INVALID_SIGNATURE","message":"Invalid signature"}}');
  });
  const result = await f.send({ method: "POST", path: "/course/v1/webhooks/mux", body,
    headers: { "x-lash-workload-token": "", "mux-signature": "synthetic-signature", authorization: "Bearer drop" } });
  assert.equal(result.status, 400); assert.equal(received, body); assert.equal(signature, "synthetic-signature");
  assert.equal((await f.send({ path: "/course/v1/webhooks/mux" })).status, 404);
});

test("upstream 429 envelope and Retry-After survive; internal locations and cookies cannot escape", async (t) => {
  let count = 0;
  const f = await fixture(t, (_req, res) => {
    if (++count === 1) {
      res.writeHead(429, { "retry-after": "12", "content-type": "application/json", "set-cookie": "private=value" });
      res.end('{"error":{"code":"TOO_MANY_REQUESTS","message":"Retry later"},"requestId":"safe-id"}');
    } else { res.writeHead(302, { location: "https://private.internal/secret" }); res.end(); }
  });
  const limited = await f.send();
  assert.equal(limited.status, 429); assert.equal(limited.headers["retry-after"], "12");
  assert.equal(JSON.parse(limited.body).requestId, "safe-id");
  assert.equal(limited.headers["set-cookie"], undefined);
  const redirect = await f.send();
  assert.equal(redirect.status, 502); assert.equal(redirect.headers.location, undefined);
  assert.ok(!redirect.body.includes("private.internal"));
});

test("workload admission does not consume independent webhook/service budgets", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("ok"), {}, {
    limits: { preauth: 10, workload: 1, service: 1, webhook: 1 },
  });
  assert.equal((await f.send()).status, 200);
  const limited = await f.send();
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers["retry-after"]) >= 1);
  assert.equal((await f.send({ method: "POST", path: "/course/v1/webhooks/mux" })).status, 200);
  assert.equal((await f.send({ path: "/course/v1/internal/entitlements", headers: { authorization: "Bearer app" } })).status, 200);
});

test("untrusted private TLS certificate is refused without exposing connection details", async (t) => {
  let reached = false;
  const f = await fixture(t, (_req, res) => { reached = true; res.end("must not pass"); }, { upstreamCaFile: wrongCertFile });
  const result = await f.send();
  assert.equal(result.status, 502); assert.ok(!result.body.includes("localhost"));
  assert.equal(reached, false);
});

test("private TLS terminator checks actual peer and route, replacing spoofed forwarding metadata", async (t) => {
  let received;
  const backend = createHttpServer((req, res) => { received = req; res.end("private ok"); });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const proxy = createPrivateTlsProxy({
    upstream: `http://127.0.0.1:${backend.address().port}`, keyFile, certFile,
    peers: [{ address: "127.0.0.1", routes: [{ method: "POST", path: "/v1/internal/course/enrollment-events" }] }],
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await Promise.all([proxy, backend].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }))); });
  const send = (path) => new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port: proxy.address().port, ca: cert, method: "POST", path,
      headers: { authorization: "Bearer app", "x-forwarded-for": "8.8.8.8", "x-lash-workload-token": "forged" } }, (reply) => {
      reply.resume(); reply.once("end", () => resolve(reply.statusCode));
    });
    call.once("error", reject); call.end("{}");
  });
  assert.equal(await send("/v1/internal/course/enrollment-events"), 200);
  assert.equal(received.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(received.headers["x-lash-workload-token"], undefined);
  assert.equal(received.headers.authorization, "Bearer app");
  assert.equal(await send("/metrics"), 403);
  assert.equal(await send("/v1/internal/course/%65nrollment-events"), 403);
});

test("private TLS permits exact P2 quiz PUT and caption DELETE routes while denying other methods and peers", async (t) => {
  const received = [];
  const backend = createHttpServer((req, res) => { received.push(`${req.method} ${req.url}`); req.resume(); res.end("ok"); });
  await new Promise(done => backend.listen(0, "127.0.0.1", done));
  const routes = [{ method: "PUT", path: "/v1/admin/lessons/{lessonId}/quiz" },
    { method: "DELETE", path: "/v1/admin/lessons/{lessonId}/video/{videoAssetId}/captions/{trackId}" }];
  const proxy = createPrivateTlsProxy({ upstream: `http://127.0.0.1:${backend.address().port}`, keyFile, certFile,
    peers: [{ address: "127.0.0.1", routes }, { address: "127.0.0.2", routes: [{ method: "GET", path: "/health" }] }] });
  const otherPeer = createPrivateTlsProxy({ upstream: `http://127.0.0.1:${backend.address().port}`, keyFile, certFile,
    peers: [{ address: "127.0.0.2", routes }] });
  await new Promise(done => proxy.listen(0, "127.0.0.1", done));
  await new Promise(done => otherPeer.listen(0, "127.0.0.1", done));
  t.after(async () => { await Promise.all([proxy, otherPeer, backend].map(server => new Promise(done => { server.close(done); server.closeAllConnections(); }))); });
  const send = (method, path, port = proxy.address().port) => new Promise((done, fail) => {
    const call = request({ host: "127.0.0.1", port, ca: cert, method, path, headers: { "content-type": "application/json", "content-length": "2" } }, reply => {
      reply.resume(); reply.once("end", () => done(reply.statusCode));
    });
    call.once("error", fail); call.end("{}");
  });
  const quiz = "/v1/admin/lessons/owned/quiz", caption = "/v1/admin/lessons/owned/video/current/captions/en";
  assert.equal(await send("PUT", quiz), 200);
  assert.equal(await send("DELETE", caption), 200);
  for (const [method, path, peer] of [["POST", quiz], ["DELETE", quiz], ["PUT", caption], ["PUT", "/v1/admin/other"],
    ["PUT", quiz, otherPeer.address().port], ["DELETE", caption, otherPeer.address().port]]) assert.equal(await send(method, path, peer), 403);
  assert.deepEqual(received, [`PUT ${quiz}`, `DELETE ${caption}`]);
  assert.throws(() => createPrivateTlsProxy({ upstream: "http://127.0.0.1", keyFile, certFile,
    peers: [{ address: "127.0.0.1", routes: [{ method: "OPTIONS", path: "/v1/admin/lessons/{lessonId}/quiz" }] }] }), /Invalid private peer policy/u);
});

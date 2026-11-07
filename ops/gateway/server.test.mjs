import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, renameSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer, request } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { createGateway } from "./server.mjs";
import { createPrivateTlsProxy } from "./private-tls.mjs";
import { createHash, createHmac } from "node:crypto";
import { createP2CertificationFault, p2GatewayProcessBinding } from "./p2-certification-fault.mjs";
import { createAdmissionReader, selectScopedMuxCallback, SCOPED_INTERACTIVE_HEADER, SCOPED_MUX_HEADER } from "./admission.mjs";
import { interactiveCourseOperation, interactiveCourseStagePermits } from "./operations.mjs";

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

test("interactive Course operations classify exact existing browser route and method pairs", () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const otherId = "20000000-0000-4000-8000-000000000002";
  const course = `/v1/admin/courses/${id}`;
  const modulePath = `/v1/admin/modules/${id}`;
  const lesson = `/v1/admin/lessons/${id}`;
  const video = `${lesson}/video/${otherId}`;
  const learnerCourse = `/v1/student/courses/${id}`;
  const learnerLesson = `/v1/student/lessons/${id}`;
  const methods = {
    catalog: {
      GET: ["/v1/courses", "/v1/courses/first-course-2"],
    },
    authoring: {
      GET: ["/v1/admin/courses", course, `${course}/publication-readiness`, `${lesson}/quiz`],
      POST: ["/v1/admin/courses", `${course}/modules`, `${course}/modules/reorder`, `${modulePath}/lessons`, `${modulePath}/lessons/reorder`],
      PATCH: [course, modulePath, lesson],
      PUT: [`${lesson}/quiz`],
    },
    media: {
      GET: [`${lesson}/video`],
      POST: [`${lesson}/video-upload`, `${video}/refresh`, `${video}/captions`],
      DELETE: [`${video}/captions/Mux_Track-1`],
    },
    learning: {
      GET: ["/v1/student/courses", learnerCourse, `${learnerCourse}/lessons`, learnerLesson, `${learnerLesson}/playback`,
        `${learnerLesson}/quiz`, `${learnerLesson}/quiz/attempts`, "/v1/student/progress"],
      POST: [`${learnerCourse}/enrollments`, `${learnerLesson}/progress`, `${learnerLesson}/quiz/attempts`],
    },
    "paid-grant": {
      GET: ["/v1/admin/entitlements/commands", "/v1/admin/entitlements/grants"],
      POST: ["/v1/admin/entitlements/grants"],
    },
    "paid-revoke": {
      POST: ["/v1/admin/entitlements/revocations"],
    },
  };
  for (const [group, verbs] of Object.entries(methods)) {
    for (const [method, paths] of Object.entries(verbs)) {
      for (const path of paths) assert.equal(interactiveCourseOperation(method, `/course${path}`), group, `${method} ${path}`);
    }
  }

  for (const [method, path] of [
    ["POST", "/course/v1/webhooks/mux"],
    ["POST", "/course/v1/internal/entitlements/grants"],
    ["POST", "/course/v1/internal/entitlements/reconcile"],
    ["POST", "/course/v1/internal/entitlements/revocations"],
    ["GET", "/course/v1/internal/entitlements"],
    ["GET", "/course/v1/admin/entitlements/revocations"],
    ["GET", "/course/v1/admin/entitlements/enrollments"],
    ["POST", "/course/v1/internal/accounts/commands"],
    ["GET", `/course/v1/internal/accounts/exports/${id}`],
    ["POST", "/community/v1/internal/accounts/commands"],
    ["GET", `/community/v1/internal/accounts/exports/${id}`],
    ["GET", "/community/v1/courses"],
    ["DELETE", `/course${course}`],
    ["POST", `/course${course}/publish`],
    ["HEAD", "/course/v1/courses"],
    ["get", "/course/v1/courses"],
    ["GET", "/v1/courses"],
    ["GET", "/course/v1/courses?limit=1"],
    ["GET", "/course/v1/courses#fragment"],
    ["GET", "/course/v1/courses/"],
    ["GET", "/course/v1//courses"],
    ["GET", "/course/v1/courses/Upper_Case"],
    ["GET", `/course/v1/courses/${"a".repeat(121)}`],
    ["GET", "/course/v1/admin/courses/not-a-uuid"],
    ["GET", "/course/v1/admin/courses/A0000000-0000-4000-8000-000000000001"],
    ["GET", "/course/v1/student/lessons/%2e%2e"],
    ["POST", `/course${lesson}/video/no-asset-id/captions`],
    ["DELETE", `/course${video}/captions/${"x".repeat(256)}`],
    ["GET", null],
  ]) assert.equal(interactiveCourseOperation(method, path), null, `${method} ${path}`);
});

test("learner access stage permits only protected reads with exact query shapes", () => {
  const id = "20000000-0000-4000-8000-000000000001";
  const course = `/course/v1/student/courses/${id}`;
  const lesson = `/course/v1/student/lessons/${id}`;
  const progress = "/course/v1/student/progress";
  for (const target of [course, lesson, `${lesson}/playback`, `${lesson}/quiz`, `${lesson}/quiz/attempts`,
    `${progress}?courseId=${id}`, `${progress}?lessonId=${id}`]) {
    assert.equal(interactiveCourseOperation("GET", target.split("?", 1)[0]), "learning");
    assert.equal(interactiveCourseStagePermits("learner-access", "GET", target), true, target);
  }
  for (const [method, target] of [
    ["GET", "/course/v1/courses/example"], ["GET", "/course/v1/student/courses"], ["GET", `${course}/lessons`],
    ["GET", `${lesson}?`], ["GET", `${course}?limit=1`], ["GET", progress], ["GET", `${progress}?courseId=not-a-uuid`],
    ["GET", `${progress}?lessonId=${id}&courseId=${id}`], ["GET", `${progress}?courseId=${id}&courseId=${id}`],
    ["GET", `${progress}?%63ourseId=${id}`], ["GET", `${progress}?courseId=${id.replace("-", "%2D")}`],
    ["POST", `${course}/enrollments`], ["POST", `${lesson}/progress`], ["POST", `${lesson}/quiz/attempts`],
  ]) assert.equal(interactiveCourseStagePermits("learner-access", method, target), false, `${method} ${target}`);
});

test("paid revoke stage permits only the named mutation and exact inspection query shapes", () => {
  const id = "20000000-0000-4000-8000-000000000001";
  const course = `/course/v1/admin/courses/${id}`;
  const commands = "/course/v1/admin/entitlements/commands";
  const grants = "/course/v1/admin/entitlements/grants";
  const revoke = "/course/v1/admin/entitlements/revocations";
  for (const target of [course, `${commands}?idempotencyKey=owner-paid-revoke%3A${id}&limit=2`,
    `${grants}?grantId=${id}&userId=${id}&courseId=${id}&limit=2`]) {
    assert.equal(interactiveCourseStagePermits("paid-revoke", "GET", target), true, target);
  }
  assert.equal(interactiveCourseStagePermits("paid-revoke", "POST", revoke), true);
  assert.equal(interactiveCourseStagePermits("paid-grant", "POST", revoke), false);
  for (const [method, target] of [
    ["POST", grants], ["POST", `${revoke}?`], ["GET", revoke], ["GET", `${course}?limit=2`],
    ["GET", `${commands}?idempotencyKey=owner-paid%3A${id}&limit=2`], ["GET", `${commands}?idempotencyKey=owner-paid-revoke%3a${id}&limit=2`],
    ["GET", `${commands}?limit=2&idempotencyKey=owner-paid-revoke%3A${id}`], ["GET", `${grants}?userId=${id}&courseId=${id}&limit=2`],
    ["GET", `${grants}?grantId=not-a-uuid&userId=${id}&courseId=${id}&limit=2`], ["GET", `${grants}?grantId=${id}&courseId=${id}&userId=${id}&limit=2`],
  ]) assert.equal(interactiveCourseStagePermits("paid-revoke", method, target), false, `${method} ${target}`);
});

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
  const accepted = await f.send(input);
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.admissionState().muxCallbackEvidence, { admitted: 1,
    managedAcks: [{ requestId: accepted.headers["x-request-id"], eventId: event.id, upstreamStatus: 200 }] });
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
  assert.deepEqual(observation.muxCallbackEvidence, { admitted: 0, managedAcks: [] });
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
  assert.deepEqual(f.admissionState().muxCallbackEvidence, { admitted: 1, managedAcks: [] });
});

async function interactiveFixture(t, requests, handler, stage = "learning") {
  const directory = mkdtempSync(join(folder, "interactive-admission-"));
  const file = join(directory, "state.json"), mount = statSync(directory, { bigint: true });
  const admission = { file, releaseId: "owned-interactive", candidateSha256: "a".repeat(64) };
  const start = Date.now(), processSha = "b".repeat(64), key = "c".repeat(64);
  const actorId = "10000000-0000-4000-8000-000000000001";
  const state = { version: 3, environment: "staging", releaseId: admission.releaseId, candidateSha256: admission.candidateSha256,
    actionId: "owned-interactive-action", newWork: false, recovery: false, interactive: {
      actorId, stage, epoch: "91", frontendSourceCommit: "d".repeat(40),
      deploymentHost: "owned-immutable.vercel.app", issuedAt: new Date(start - 1000).toISOString(),
      expiresAt: new Date(start + 60_000).toISOString(), nonce: "e".repeat(32), gatewayProcessSha256: processSha,
      mountDevice: String(mount.dev), mountInode: String(mount.ino), key, requests,
    } };
  const { interactive, ...selected } = state;
  const ordinary = { ...selected, version: 1, actionId: "owned-original-release" };
  const save = value => {
    writeFileSync(file, certificationCanonical(value) + "\n", { mode: 0o640 });
    chmodSync(file, 0o640);
  };
  const staging = { admission, appEnv: "staging", publicHost: "api-staging.lashher.com",
    ownerId: "team_2Hrn5eMZyZxfAWdmYvyKi9t3", projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" };
  let wall = start, tick = 0n, currentProcess = processSha;
  const options = { processBinding: () => currentProcess, storageAuthority: path => path === file,
    now: () => wall, monotonic: () => tick, interactiveGroup: mount.gid };
  save(state);
  const f = await fixture(t, handler, staging, { scopedAdmission: options });
  let proofSequence = 0;
  function signed({ method = "GET", path, body, actor = actorId, idempotency = "", issued = Math.floor(wall / 1000), proofId,
    signingKey = key, catalog = false }) {
    const requestId = proofId ?? `10000000-0000-4000-8000-${String(++proofSequence).padStart(12, "0")}`;
    const token = catalog ? "" : `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: actor })).toString("base64url")}.owned`;
    const message = ["lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, path, certificationHash(body ?? ""),
      certificationHash(token), certificationHash(idempotency)].join("\n");
    const mac = createHmac("sha256", Buffer.from(signingKey, "hex")).update(message).digest("hex");
    return { method, path, ...(body === undefined ? {} : { body }), headers: {
      "x-request-id": requestId, [SCOPED_INTERACTIVE_HEADER]: `v1.${issued}.${requestId}.${mac}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotency ? { "x-idempotency-key": idempotency } : {}),
    } };
  }
  return { ...f, state, ordinary, save, signed, file, staging, options, start,
    setClock(time, monotonic) { wall = time; tick = monotonic; },
    setProcess(value) { currentProcess = value; } };
}

test("scoped interactive v3 joins exact signed requests, including GETs, to bounded TLS acknowledgements", async t => {
  const id = "20000000-0000-4000-8000-000000000002";
  const read = `/course/v1/student/progress?courseId=${id}`;
  const write = `/course/v1/student/lessons/${id}/progress`;
  const catalog = "/course/v1/courses?limit=2";
  const body = '{"positionSeconds":17}';
  const requests = [
    { method: "GET", target: read, bodySha256: certificationHash(""), uses: 1 },
    { method: "POST", target: write, bodySha256: certificationHash(body), uses: 2 },
    { method: "GET", target: catalog, bodySha256: certificationHash(""), uses: 1 },
  ];
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const complete = new Promise(resolve => { release = resolve; });
  const forwarded = [];
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
      proof: req.headers[SCOPED_INTERACTIVE_HEADER], body: Buffer.concat(chunks).toString() });
    if (req.url === read.slice("/course".length)) {
      entered();
      await complete;
    }
    if (req.headers["x-idempotency-key"] === "owned-conflict") {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      res.end('{"error":{"code":"CONFLICT","message":"Owned conflict"}}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"owned":true}');
  });
  const writeInput = f.signed({ method: "POST", path: write, body, idempotency: "owned-first" });
  for (const refused of [
    { method: "GET", path: read, headers: { authorization: writeInput.headers.authorization } },
    f.signed({ path: read + "&limit=2" }),
    f.signed({ path: catalog }),
    f.signed({ path: read, actor: id }),
    f.signed({ path: read, signingKey: "f".repeat(64) }),
    f.signed({ path: read, issued: Math.floor(f.start / 1000) - 30 }),
    f.signed({ path: read, issued: Math.floor(f.start / 1000) + 1 }),
    f.signed({ method: "POST", path: write, body: '{"positionSeconds":18}' }),
    { ...writeInput, headers: { ...writeInput.headers, "x-idempotency-key": "owned-tampered" } },
    { ...writeInput, headers: { ...writeInput.headers, "x-request-id": id } },
    { ...writeInput, headers: { ...writeInput.headers, "content-type": "text/plain" } },
    f.signed({ method: "POST", path: "/course/v1/internal/accounts/commands", body: "{}" }),
    f.signed({ method: "POST", path: "/course/v1/webhooks/mux", body: "{}" }),
  ]) assert.equal((await f.send(refused)).status, 503);
  assert.equal(forwarded.length, 0);

  const readInput = f.signed({ path: read });
  const readResponse = f.send(readInput);
  await waiting;
  const during = f.admissionState();
  assert.equal(during.valid, false);
  assert.equal(during.version, 3);
  assert.equal(during.interactiveActive, true);
  assert.equal(during.newWork, null);
  assert.equal(during.recovery, null);
  assert.deepEqual(during.active, { newWork: 1, recovery: 0 });
  assert.deepEqual(during.interactiveEvidence, { admitted: 1, acknowledged: [] });
  assert.equal(Object.hasOwn(during, "interactive"), false);
  assert.equal(JSON.stringify(during).includes(f.state.interactive.key), false);
  release();
  const readResult = await readResponse;
  assert.equal(readResult.status, 200);
  assert.equal((await f.send(readInput)).status, 503);
  const writeResult = await f.send(writeInput);
  assert.equal(writeResult.status, 200);
  assert.equal((await f.send(writeInput)).status, 503);
  const conflictInput = f.signed({ method: "POST", path: write, body, idempotency: "owned-conflict" });
  const conflict = await f.send(conflictInput);
  assert.equal(conflict.status, 409);
  assert.equal((await f.send(f.signed({ method: "POST", path: write, body }))).status, 503);
  const catalogInput = f.signed({ path: catalog, catalog: true });
  const catalogResult = await f.send(catalogInput);
  assert.equal(catalogResult.status, 200);
  assert.equal(forwarded.length, 4);
  assert.ok(forwarded.every(row => row.proof === undefined));
  assert.equal(forwarded.at(-1).authorization, undefined);
  assert.equal(forwarded[1].body, body);
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.interactiveEvidence, { admitted: 4, acknowledged: [
    [readInput, readResult, 0], [writeInput, writeResult, 1], [conflictInput, conflict, 1], [catalogInput, catalogResult, 2],
  ].map(([input, response, requestIndex]) => ({ requestId: response.headers["x-request-id"],
    proofRequestId: input.headers["x-request-id"], requestIndex, upstreamStatus: response.status })) });
});

test("scoped learning acknowledges free enrollment after access denial and confirms private course and progress", async t => {
  const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const [courseId, foreignCourseId, idempotencyKey, wrongKey, grantId, enrollmentId, moduleId, lessonId] = [1, 2, 3, 4, 5, 6, 7, 8].map(fixtureId);
  const slug = "p2q-free-enrollment";
  const publicTarget = `/course/v1/courses/${slug}`;
  const studentPath = id => `/course/v1/student/courses/${id}`;
  const studentTarget = studentPath(courseId);
  const enrollmentTarget = `${studentTarget}/enrollments`;
  const progressTarget = `/course/v1/student/progress?courseId=${courseId}`;
  const body = JSON.stringify({ idempotencyKey });
  const requests = [
    { method: "GET", target: publicTarget, bodySha256: certificationHash(""), uses: 1 },
    { method: "GET", target: studentTarget, bodySha256: certificationHash(""), uses: 2 },
    { method: "POST", target: enrollmentTarget, bodySha256: certificationHash(body), uses: 1 },
    { method: "GET", target: progressTarget, bodySha256: certificationHash(""), uses: 1 },
  ];
  const courseModule = { id: moduleId, title: "Enrollment module", slug: "enrollment-module", description: null, position: 1 };
  const course = { id: courseId, slug, title: "P2Q free course", description: null, introduction: null, currency: "CAD", accessMode: "free",
    priceCents: 0, cover: null, seo: null, modules: [{ ...courseModule, lessons: [] }] };
  const studentCourse = { course: { ...course, modules: [{ ...courseModule, lessons: [{ id: lessonId, moduleId, slug: "first-lesson", title: "First lesson",
    content: null, contentDocument: { version: 1, blocks: [] }, transcript: null, captions: [], isPreview: false, position: 1 }] }] } };
  const accessRequired = { error: { code: "ACTIVE_ENROLLMENT_REQUIRED", message: "Active enrollment required" } };
  const enrollment = { grantId, enrollmentId, courseId, source: "free", status: "active", idempotentReplay: false };
  const forwarded = [];
  let enrolled = false;
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    forwarded.push({ method: req.method, target: req.url, body: payload, requestId: req.headers["x-request-id"],
      proof: req.headers[SCOPED_INTERACTIVE_HEADER], authorization: req.headers.authorization, idempotency: req.headers["x-idempotency-key"] });
    let status, value;
    if (req.url === publicTarget.slice("/course".length)) { status = 200; value = { course }; }
    else if (req.method === "POST") {
      const receivedKey = JSON.parse(payload).idempotencyKey;
      if (receivedKey !== req.headers["x-idempotency-key"]) { status = 400; value = { error: { code: "BAD_REQUEST", message: "Invalid request" } }; }
      else { enrolled = true; status = 201; value = enrollment; }
    } else if (!enrolled) { status = 403; value = accessRequired; }
    else { status = 200; value = req.url === progressTarget.slice("/course".length) ? { progress: [] } : studentCourse; }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }, "learning");

  const post = () => f.signed({ method: "POST", path: enrollmentTarget, body, idempotency: idempotencyKey });
  const enrolledInput = post();
  for (const input of [f.signed({ path: publicTarget }), f.signed({ path: studentTarget, actor: foreignCourseId }),
    f.signed({ path: progressTarget, actor: foreignCourseId }), f.signed({ path: `/course/v1/student/progress?courseId=${foreignCourseId}` }),
    f.signed({ method: "POST", path: enrollmentTarget, body, idempotency: idempotencyKey, actor: foreignCourseId }),
    f.signed({ method: "POST", path: `${studentPath(foreignCourseId)}/enrollments`, body, idempotency: idempotencyKey }),
    f.signed({ method: "POST", path: enrollmentTarget, body: JSON.stringify({ idempotencyKey: wrongKey }), idempotency: wrongKey }),
    { ...enrolledInput, headers: { ...enrolledInput.headers, "x-idempotency-key": wrongKey } }]) {
    assert.equal((await f.send(input)).status, 503);
  }
  const steps = [
    { input: f.signed({ path: publicTarget, catalog: true }), requestIndex: 0, status: 200, value: { course } },
    { input: f.signed({ path: studentTarget }), requestIndex: 1, status: 403, value: accessRequired },
    { input: enrolledInput, requestIndex: 2, status: 201, value: enrollment },
    { input: f.signed({ path: studentTarget }), requestIndex: 1, status: 200, value: studentCourse },
    { input: f.signed({ path: progressTarget }), requestIndex: 3, status: 200, value: { progress: [] } },
  ];
  async function complete({ input, requestIndex, status, value }) {
    const output = await f.send(input);
    assert.equal(output.status, status);
    assert.deepEqual(JSON.parse(output.body), value);
    const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(requestId, proofRequestId);
    return { requestId, proofRequestId, requestIndex, upstreamStatus: status };
  }
  const acknowledged = [];
  for (const step of steps.slice(0, 3)) {
    acknowledged.push(await complete(step));
    assert.equal((await f.send(step.input)).status, 503);
  }
  acknowledged.push(...await Promise.all(steps.slice(3).map(complete)));
  for (const input of [f.signed({ path: publicTarget, catalog: true }), f.signed({ path: studentTarget }),
    f.signed({ path: progressTarget }), post(), ...steps.slice(3).map(step => step.input)]) {
    assert.equal((await f.send(input)).status, 503);
  }
  assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
  assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
  const expectedForwarded = steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
    body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined,
    authorization: input.headers.authorization, idempotency: input.headers["x-idempotency-key"] }));
  assert.deepEqual(forwarded.slice(0, 3), expectedForwarded.slice(0, 3));
  assert.deepEqual(forwarded.slice(3).sort((a, b) => a.target.localeCompare(b.target)), expectedForwarded.slice(3));
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.equal(observed.interactiveEvidence.admitted, 5);
  assert.deepEqual(observed.interactiveEvidence.acknowledged.slice(0, 3), acknowledged.slice(0, 3));
  assert.deepEqual(observed.interactiveEvidence.acknowledged.slice(3).sort((a, b) => a.requestIndex - b.requestIndex), acknowledged.slice(3));
});

for (const [scenario, status] of [["allowed", 200], ["archived", 410], ["draft", 404], ["revoked", 403], ["expired", 403]]) {
  test(`scoped learner access acknowledges only the reviewed reads for ${scenario} access`, async t => {
    const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const [courseId, lessonId, moduleId, quizId, foreignId] = [1, 2, 3, 4, 5].map(fixtureId);
    const courseTarget = `/course/v1/student/courses/${courseId}`;
    const lessonTarget = `/course/v1/student/lessons/${lessonId}`;
    const progress = "/course/v1/student/progress";
    const targets = [courseTarget, `${progress}?courseId=${courseId}`, lessonTarget, `${lessonTarget}/playback`,
      `${progress}?lessonId=${lessonId}`, `${lessonTarget}/quiz`, `${lessonTarget}/quiz/attempts`];
    const requests = targets.map((target, index) => ({ method: "GET", target, bodySha256: certificationHash(""), uses: index === 0 ? 2 : 1 }));
    const lesson = { id: lessonId, moduleId, slug: "first-lesson", title: "First lesson", content: null,
      contentDocument: { version: 1, blocks: [] }, transcript: "Owned learner-access transcript", captions: [], isPreview: false, position: 1 };
    const course = { id: courseId, slug: "p2q-learner-access", title: "P2Q paid course", description: null, introduction: null, currency: "CAD",
      accessMode: "paid", priceCents: 3900, cover: null, seo: null, modules: [{ id: moduleId, slug: "first-module", title: "First module",
        description: null, position: 1, lessons: [lesson] }] };
    const expiresAt = "2026-11-07T16:10:00.000Z";
    const positive = [{ course }, { progress: [] }, { lesson }, { playbackId: "owned-playback", playbackToken: "synthetic-playback-proof",
      expiresAt, thumbnailToken: "synthetic-thumbnail-proof", thumbnailExpiresAt: expiresAt }, { progress: [] },
    { quiz: { id: quizId, lessonId, revision: 1, document: { version: 1, mode: "graded", passingPercent: 80,
      questions: [{ id: "owned-question", prompt: "What comes first?", options: [{ id: "first", text: "Preparation" }, { id: "second", text: "Review" }] }] } } },
    { attempts: [] }];
    const error = (code, message) => ({ error: { code, message } });
    const values = targets.map((_target, index) => {
      if (scenario === "allowed") return positive[index];
      if (scenario === "archived") return error("COURSE_ARCHIVED", "Course is archived");
      if (scenario === "draft") {
        if (index < 2) return error("COURSE_NOT_FOUND", "Course not found");
        return index < 5 ? error("LESSON_NOT_FOUND", "Lesson not found") : error("NOT_FOUND", "Quiz not found");
      }
      if (scenario === "revoked" && index < 5) return error("ENTITLEMENT_REVOKED", "Course entitlement was revoked");
      return error("ACTIVE_ENROLLMENT_REQUIRED", "Active enrollment required");
    });
    const forwarded = [];
    const f = await interactiveFixture(t, requests, (req, res) => {
      forwarded.push({ method: req.method, path: req.url, requestId: req.headers["x-request-id"],
        proof: req.headers[SCOPED_INTERACTIVE_HEADER], authorization: req.headers.authorization });
      const index = targets.indexOf(`/course${req.url}`);
      res.writeHead(index === -1 ? 400 : status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(values[index] ?? error("BAD_REQUEST", "Unexpected fixture request")));
    }, "learner-access");
    for (const input of [f.signed({ path: courseTarget, actor: foreignId }), f.signed({ path: targets[3], actor: foreignId }),
      f.signed({ path: `/course/v1/student/courses/${foreignId}` }), f.signed({ path: `${progress}?lessonId=${foreignId}` }),
      f.signed({ path: `${progress}?courseId=${courseId}&lessonId=${lessonId}` }), f.signed({ path: `${courseTarget}/lessons` }),
      f.signed({ path: "/course/v1/student/courses" }), f.signed({ path: "/course/v1/courses/p2q-learner-access", catalog: true }),
      f.signed({ method: "POST", path: `${courseTarget}/enrollments`, body: "{}" }),
      f.signed({ method: "POST", path: `${lessonTarget}/progress`, body: "{}" }),
      f.signed({ method: "POST", path: `${lessonTarget}/quiz/attempts`, body: "{}" })]) {
      assert.equal((await f.send(input)).status, 503);
    }
    const steps = [0, 1, 0, 2, 3, 4, 5, 6].map(requestIndex => ({ input: f.signed({ path: targets[requestIndex] }), requestIndex }));
    async function complete({ input, requestIndex }) {
      const output = await f.send(input);
      assert.equal(output.status, status);
      assert.deepEqual(JSON.parse(output.body), values[requestIndex]);
      const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
      assert.match(requestId, /^[a-f0-9-]{36}$/u);
      assert.notEqual(requestId, proofRequestId);
      return { requestId, proofRequestId, requestIndex, upstreamStatus: status };
    }
    const acknowledged = await Promise.all(steps.slice(0, 2).map(complete));
    assert.equal((await f.send(steps[0].input)).status, 503);
    for (const step of steps.slice(2)) acknowledged.push(await complete(step));
    for (const input of [...targets.map(path => f.signed({ path })), ...steps.slice(2).map(step => step.input)]) {
      assert.equal((await f.send(input)).status, 503);
    }
    assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
    assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
    const expectedForwarded = steps.map(({ input }, index) => ({ method: "GET", path: input.path.slice("/course".length),
      requestId: acknowledged[index].requestId, proof: undefined, authorization: input.headers.authorization }));
    assert.deepEqual(forwarded.slice(0, 2).sort((a, b) => a.path.localeCompare(b.path)), expectedForwarded.slice(0, 2));
    assert.deepEqual(forwarded.slice(2), expectedForwarded.slice(2));
    const observed = f.admissionState();
    assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
    assert.equal(observed.interactiveEvidence.admitted, steps.length);
    assert.deepEqual(observed.interactiveEvidence.acknowledged.slice(0, 2).sort((a, b) => a.requestIndex - b.requestIndex), acknowledged.slice(0, 2));
    assert.deepEqual(observed.interactiveEvidence.acknowledged.slice(2), acknowledged.slice(2));
  });
}

test("scoped paid grant acknowledges the reviewed owner mutation and exact command and grant readbacks", async t => {
  const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const [courseId, userId, key, commandId, grantId, enrollmentId, foreignId] = [1, 2, 3, 4, 5, 6, 7].map(fixtureId);
  const actorUserId = "10000000-0000-4000-8000-000000000001";
  const idempotencyKey = `owner-paid:${key}`;
  const encodedKey = `owner-paid%3A${key}`;
  const revision = 7;
  const reason = `[paid-course revision ${revision}] Reviewed manual access`;
  const courseTarget = `/course/v1/admin/courses/${courseId}`;
  const commandsPath = "/course/v1/admin/entitlements/commands";
  const commandsTarget = `${commandsPath}?idempotencyKey=${encodedKey}&limit=2`;
  const grantTarget = "/course/v1/admin/entitlements/grants";
  const grantReadback = `${grantTarget}?userId=${userId}&courseId=${courseId}&idempotencyKey=${encodedKey}&limit=2`;
  const body = JSON.stringify({ userId, courseId, reason, idempotencyKey });
  const requests = [
    { method: "GET", target: courseTarget, bodySha256: certificationHash(""), uses: 3 },
    { method: "GET", target: commandsTarget, bodySha256: certificationHash(""), uses: 2 },
    { method: "POST", target: grantTarget, bodySha256: certificationHash(body), uses: 1 },
    { method: "GET", target: grantReadback, bodySha256: certificationHash(""), uses: 1 },
  ];
  const course = { course: { id: courseId, slug: "p2q-paid-course", title: "P2Q paid course", description: null, introduction: null,
    status: "published", currency: "CAD", accessMode: "paid", priceCents: 3900, taxClassification: "p2q-reviewed-tax-fixture",
    cover: null, seo: null, revision, modules: [] } };
  const at = "2026-11-07T16:00:00.000Z";
  const command = { commandId, action: "grant", scope: "userCourse", outcome: "applied", actorUserId, userId, courseId, targetGrantId: null,
    reason, effectiveAt: at, affectedGrantCount: 1, effects: [{ grantId, effectType: "grant_created", previousStatus: null, resultingStatus: "active" }] };
  const commandsBefore = { commands: [], nextCursor: null };
  const commandsAfter = { commands: [{ ...command, idempotencyKey, createdAt: at }], nextCursor: null };
  const grant = { grants: [{ grantId, enrollmentId, userId, userEmail: null, courseId, courseSlug: course.course.slug, courseTitle: course.course.title,
    orderId: null, externalPaymentId: null, provider: null, idempotencyKey, grantReason: "manual", revokeReason: null,
    grantedAt: at, revokedAt: null, expiresAt: null, status: "active", revokeIdempotencyKey: null, createdAt: at, updatedAt: at }],
  nextCursor: null, emailLookup: { source: "local_users_projection", complete: false } };
  const forwarded = [];
  let granted = false;
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    forwarded.push({ method: req.method, target: req.url, body: payload, requestId: req.headers["x-request-id"],
      proof: req.headers[SCOPED_INTERACTIVE_HEADER], authorization: req.headers.authorization, idempotency: req.headers["x-idempotency-key"] });
    let status = 200, value = course;
    if (req.method === "POST") {
      if (JSON.parse(payload).idempotencyKey !== req.headers["x-idempotency-key"]) {
        status = 400;
        value = { error: { code: "BAD_REQUEST", message: "Invalid request" } };
      } else { granted = true; status = 201; value = command; }
    } else if (req.url === commandsTarget.slice("/course".length)) value = granted ? commandsAfter : commandsBefore;
    else if (req.url === grantReadback.slice("/course".length)) value = granted ? grant : { ...grant, grants: [] };
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }, "paid-grant");

  const post = () => f.signed({ method: "POST", path: grantTarget, body, idempotency: idempotencyKey });
  const grantInput = post();
  for (const input of [f.signed({ path: courseTarget, actor: foreignId }),
    f.signed({ path: `${commandsPath}?idempotencyKey=${idempotencyKey}&limit=2` }),
    f.signed({ path: `${commandsPath}?limit=2&idempotencyKey=${encodedKey}` }),
    f.signed({ path: grantReadback.replace(userId, foreignId) }),
    f.signed({ method: "POST", path: grantTarget, body, idempotency: idempotencyKey, actor: foreignId }),
    f.signed({ method: "POST", path: grantTarget, body: JSON.stringify({ userId, courseId, reason: "Unreviewed reason", idempotencyKey }), idempotency: idempotencyKey }),
    { ...grantInput, headers: { ...grantInput.headers, "x-idempotency-key": `owner-paid:${foreignId}` } }]) {
    assert.equal((await f.send(input)).status, 503);
  }
  const steps = [
    { input: f.signed({ path: courseTarget }), requestIndex: 0, status: 200, value: course },
    { input: f.signed({ path: commandsTarget }), requestIndex: 1, status: 200, value: commandsBefore },
    { input: f.signed({ path: courseTarget }), requestIndex: 0, status: 200, value: course },
    { input: grantInput, requestIndex: 2, status: 201, value: command },
    { input: f.signed({ path: commandsTarget }), requestIndex: 1, status: 200, value: commandsAfter },
    { input: f.signed({ path: grantReadback }), requestIndex: 3, status: 200, value: grant },
    { input: f.signed({ path: courseTarget }), requestIndex: 0, status: 200, value: course },
  ];
  const acknowledged = [];
  for (const { input, requestIndex, status, value } of steps) {
    const output = await f.send(input);
    assert.equal(output.status, status);
    assert.deepEqual(JSON.parse(output.body), value);
    const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(requestId, proofRequestId);
    acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: status });
    assert.equal((await f.send(input)).status, 503);
    if (requestIndex === 2) {
      const unreviewed = f.signed({ path: `${commandsPath}?commandId=${commandId}&idempotencyKey=${encodedKey}&limit=2` });
      assert.equal((await f.send(unreviewed)).status, 503);
    }
  }
  for (const input of [f.signed({ path: courseTarget }), f.signed({ path: commandsTarget }), post(), f.signed({ path: grantReadback })]) {
    assert.equal((await f.send(input)).status, 503);
  }
  assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
  assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
  assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
    body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined,
    authorization: input.headers.authorization, idempotency: input.headers["x-idempotency-key"] })));
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.interactiveEvidence, { admitted: steps.length, acknowledged });
});

test("scoped paid revoke acknowledges the named grant and exact owner readbacks", async t => {
  const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const [courseId, userId, key, commandId, grantId, enrollmentId, foreignId] = [1, 2, 3, 4, 5, 6, 7].map(fixtureId);
  const actorUserId = "10000000-0000-4000-8000-000000000001";
  const idempotencyKey = `owner-paid-revoke:${key}`;
  const revision = 7;
  const reason = `[paid-course revision ${revision}] Reviewed named grant revocation`;
  const courseTarget = `/course/v1/admin/courses/${courseId}`;
  const commandsTarget = `/course/v1/admin/entitlements/commands?idempotencyKey=owner-paid-revoke%3A${key}&limit=2`;
  const grantReadback = `/course/v1/admin/entitlements/grants?grantId=${grantId}&userId=${userId}&courseId=${courseId}&limit=2`;
  const revokeTarget = "/course/v1/admin/entitlements/revocations";
  const fields = { scope: "grantId", grantId, reason, idempotencyKey };
  const body = JSON.stringify(fields);
  const requests = [
    { method: "GET", target: courseTarget, bodySha256: certificationHash(""), uses: 3 },
    { method: "GET", target: commandsTarget, bodySha256: certificationHash(""), uses: 2 },
    { method: "GET", target: grantReadback, bodySha256: certificationHash(""), uses: 2 },
    { method: "POST", target: revokeTarget, bodySha256: certificationHash(body), uses: 1 },
  ];
  const course = { course: { id: courseId, slug: "p2q-revocation-course", title: "P2Q paid course", description: null, introduction: null,
    status: "published", currency: "CAD", accessMode: "paid", priceCents: 3900, taxClassification: "p2q-reviewed-tax-fixture",
    cover: null, seo: null, revision, modules: [] } };
  const grantedAt = "2026-11-07T15:00:00.000Z", revokedAt = "2026-11-07T16:00:00.000Z";
  const command = { commandId, action: "revoke", scope: "grantId", outcome: "applied", actorUserId, userId, courseId, targetGrantId: grantId,
    reason, effectiveAt: revokedAt, affectedGrantCount: 1, effects: [{ grantId, effectType: "grant_revoked", previousStatus: "active", resultingStatus: "revoked" }] };
  const commandsBefore = { commands: [], nextCursor: null };
  const commandsAfter = { commands: [{ ...command, idempotencyKey, createdAt: revokedAt }], nextCursor: null };
  const grant = { grantId, enrollmentId, userId, userEmail: null, courseId, courseSlug: course.course.slug, courseTitle: course.course.title,
    orderId: null, externalPaymentId: null, provider: null, idempotencyKey: `owner-paid:${foreignId}`, grantReason: "manual", revokeReason: null,
    grantedAt, revokedAt: null, expiresAt: null, status: "active", revokeIdempotencyKey: null, createdAt: grantedAt, updatedAt: grantedAt };
  const inspection = record => ({ grants: [record], nextCursor: null, emailLookup: { source: "local_users_projection", complete: false } });
  const grantBefore = inspection(grant);
  const grantAfter = inspection({ ...grant, status: "revoked", revokeReason: "manual", revokedAt, updatedAt: revokedAt });
  const forwarded = [];
  let revoked = false;
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = Buffer.concat(chunks).toString();
    forwarded.push({ method: req.method, target: req.url, body: payload, requestId: req.headers["x-request-id"],
      proof: req.headers[SCOPED_INTERACTIVE_HEADER], authorization: req.headers.authorization, idempotency: req.headers["x-idempotency-key"] });
    let value = course;
    if (req.method === "POST") { revoked = true; value = command; }
    else if (req.url === commandsTarget.slice("/course".length)) value = revoked ? commandsAfter : commandsBefore;
    else if (req.url === grantReadback.slice("/course".length)) value = revoked ? grantAfter : grantBefore;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }, "paid-revoke");

  const post = (options = {}) => f.signed({ method: "POST", path: revokeTarget, body, idempotency: idempotencyKey, ...options });
  const revokeInput = post();
  assert.equal((await f.send({ ...revokeInput, headers: { ...revokeInput.headers, host: "other.test" } })).status, 421);
  assert.equal((await f.send({ ...revokeInput, servername: "other.test" })).status, 421);
  for (const input of [post({ actor: foreignId }), post({ body: JSON.stringify({ ...fields, grantId: foreignId }) }),
    post({ body: JSON.stringify({ scope: "userCourse", userId, courseId, reason, idempotencyKey }) }),
    post({ body: JSON.stringify({ ...fields, reason: "Unreviewed reason" }) }), post({ idempotency: `owner-paid-revoke:${foreignId}` }),
    post({ idempotency: "" }), post({ path: "/course/v1/admin/entitlements/grants" }),
    f.signed({ path: grantReadback.replace(grantId, foreignId) }), f.signed({ path: commandsTarget.replace("%3A", ":") })]) {
    assert.equal((await f.send(input)).status, 503);
  }
  const steps = [
    { input: f.signed({ path: courseTarget }), requestIndex: 0, value: course },
    { input: f.signed({ path: commandsTarget }), requestIndex: 1, value: commandsBefore },
    { input: f.signed({ path: courseTarget }), requestIndex: 0, value: course },
    { input: f.signed({ path: grantReadback }), requestIndex: 2, value: grantBefore },
    { input: revokeInput, requestIndex: 3, value: command },
    { input: f.signed({ path: commandsTarget }), requestIndex: 1, value: commandsAfter },
    { input: f.signed({ path: grantReadback }), requestIndex: 2, value: grantAfter },
    { input: f.signed({ path: courseTarget }), requestIndex: 0, value: course },
  ];
  const acknowledged = [];
  for (const { input, requestIndex, value } of steps) {
    const output = await f.send(input);
    assert.equal(output.status, 200);
    assert.deepEqual(JSON.parse(output.body), value);
    const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(requestId, proofRequestId);
    acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: 200 });
    assert.equal((await f.send(input)).status, 503);
  }
  for (const input of [f.signed({ path: courseTarget }), f.signed({ path: commandsTarget }), f.signed({ path: grantReadback }), post()]) {
    assert.equal((await f.send(input)).status, 503);
  }
  assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
  assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
  assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
    body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined,
    authorization: input.headers.authorization, idempotency: input.headers["x-idempotency-key"] })));
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.interactiveEvidence, { admitted: steps.length, acknowledged });
});

test("scoped paid revoke refuses a broad revocation even with a reviewed hash and valid proof", async t => {
  const id = "20000000-0000-4000-8000-000000000001";
  const idempotencyKey = `owner-paid-revoke:${id}`;
  const body = JSON.stringify({ scope: "userCourse", userId: id, courseId: id, reason: "Unreviewed broad scope", idempotencyKey });
  const target = "/course/v1/admin/entitlements/revocations";
  let reachedUpstream = false;
  const f = await interactiveFixture(t, [{ method: "POST", target, bodySha256: certificationHash(body), uses: 1 }], (_req, res) => {
    reachedUpstream = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  }, "paid-revoke");
  assert.equal(f.admissionState().interactiveActive, true);
  assert.equal((await f.send(f.signed({ method: "POST", path: target, body, idempotency: idempotencyKey }))).status, 503);
  assert.equal(reachedUpstream, false);
  assert.deepEqual(f.admissionState().interactiveEvidence, { admitted: 0, acknowledged: [] });
});

test("scoped authoring acknowledges the catalog page and draft create under their returned gateway request IDs", async t => {
  const createTarget = "/course/v1/admin/courses";
  const listTarget = `${createTarget}?limit=100`;
  const id = "20000000-0000-4000-8000-000000000002";
  const draft = { title: "P2Q gateway fixture", slug: "p2q-gateway-fixture", description: null, introduction: null,
    currency: "CAD", accessMode: "free", priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null, status: "draft" };
  const body = JSON.stringify(draft);
  const catalogResponse = { courses: [], nextCursor: null };
  const createResponse = { course: { ...draft, id, revision: 1, modules: [] } };
  const requests = [
    { method: "GET", target: listTarget, bodySha256: certificationHash(""), uses: 1 },
    { method: "POST", target: createTarget, bodySha256: certificationHash(body), uses: 1 },
  ];
  const backendRequestId = "30000000-0000-4000-8000-000000000003";
  const forwarded = [];
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push({ method: req.method, target: req.url, body: Buffer.concat(chunks).toString(),
      requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
    res.writeHead(req.method === "GET" ? 200 : 201, { "content-type": "application/json; charset=utf-8", "x-request-id": backendRequestId });
    res.end(JSON.stringify(req.method === "GET" ? catalogResponse : createResponse));
  }, "authoring");
  const read = f.signed({ path: listTarget });
  const create = f.signed({ method: "POST", path: createTarget, body });
  for (const denied of [f.signed({ path: createTarget }), f.signed({ path: `${createTarget}?limit=99` }),
    f.signed({ method: "POST", path: createTarget, body: JSON.stringify({ ...draft, status: "published" }) })]) {
    assert.equal((await f.send(denied)).status, 503);
  }
  const listResult = await f.send(read);
  const createResult = await f.send(create);
  assert.deepEqual([listResult.status, createResult.status], [200, 201]);
  assert.deepEqual([JSON.parse(listResult.body), JSON.parse(createResult.body)], [catalogResponse, createResponse]);
  assert.equal((await f.send(f.signed({ path: `${createTarget}/${id}` }))).status, 503);
  assert.equal((await f.send(read)).status, 503);
  assert.equal((await f.send(create)).status, 503);
  const acknowledgements = [[read, listResult], [create, createResult]].map(([input, output], requestIndex) => {
    const requestId = output.headers["x-request-id"];
    const proofRequestId = input.headers["x-request-id"];
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(requestId, proofRequestId);
    assert.notEqual(requestId, backendRequestId);
    return { requestId, proofRequestId, requestIndex, upstreamStatus: output.status };
  });
  assert.deepEqual(forwarded, requests.map((row, index) => ({ method: row.method, target: row.target.slice("/course".length),
    body: index === 0 ? "" : body, requestId: acknowledgements[index].requestId, proof: undefined })));
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.interactiveEvidence, { admitted: 2, acknowledged: acknowledgements });
});

test("scoped authoring acknowledges the winning edit and stale conflict with exactly three draft reads", async t => {
  const id = "20000000-0000-4000-8000-000000000002";
  const foreignId = "30000000-0000-4000-8000-000000000003";
  const path = `/v1/admin/courses/${id}`;
  const target = `/course${path}`;
  const fields = { title: "P2Q draft", slug: "p2q-draft", description: null, introduction: null, currency: "CAD", accessMode: "free",
    priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null };
  const baseline = { ...fields, id, status: "draft", revision: 1, modules: [] };
  const winnerFields = { ...fields, title: "P2Q winning edit" };
  const winnerBody = JSON.stringify({ ...winnerFields, expectedRevision: 1 });
  const staleBody = JSON.stringify({ ...fields, title: "P2Q stale edit", expectedRevision: 1 });
  const conflict = { error: { code: "CONFLICT", message: "Course revision is stale; reload before editing" } };
  const requests = [
    { method: "GET", target, bodySha256: certificationHash(""), uses: 3 },
    { method: "PATCH", target, bodySha256: certificationHash(winnerBody), uses: 1 },
    { method: "PATCH", target, bodySha256: certificationHash(staleBody), uses: 1 },
  ];
  const forwarded = [];
  let course = baseline;
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    forwarded.push({ method: req.method, target: req.url, body,
      requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
    if (req.method === "PATCH") {
      const { expectedRevision, ...edit } = JSON.parse(body);
      if (expectedRevision !== course.revision) {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(conflict));
        return;
      }
      course = { ...course, ...edit, revision: course.revision + 1 };
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ course }));
  }, "authoring");

  for (const denied of [f.signed({ path: `/course/v1/admin/courses/${foreignId}` }),
    f.signed({ method: "PATCH", path: target, body: JSON.stringify({ ...winnerFields, expectedRevision: 2 }) })]) {
    assert.equal((await f.send(denied)).status, 503);
  }
  const steps = [
    { input: f.signed({ path: target }), requestIndex: 0, status: 200, value: { course: baseline } },
    { input: f.signed({ path: target }), requestIndex: 0, status: 200, value: { course: baseline } },
    { input: f.signed({ method: "PATCH", path: target, body: winnerBody }), requestIndex: 1, status: 200,
      value: { course: { ...baseline, ...winnerFields, revision: 2 } } },
    { input: f.signed({ path: target }), requestIndex: 0, status: 200, value: { course: { ...baseline, ...winnerFields, revision: 2 } } },
    { input: f.signed({ method: "PATCH", path: target, body: staleBody }), requestIndex: 2, status: 409, value: conflict },
  ];
  const acknowledged = [];
  for (const { input, requestIndex, status, value } of steps) {
    const output = await f.send(input);
    assert.equal(output.status, status);
    assert.deepEqual(JSON.parse(output.body), value);
    const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
    assert.match(requestId, /^[a-f0-9-]{36}$/u);
    assert.notEqual(requestId, proofRequestId);
    acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: status });
  }
  for (const denied of [f.signed({ path: target }), f.signed({ method: "PATCH", path: target, body: winnerBody }),
    f.signed({ method: "PATCH", path: target, body: staleBody }), ...steps.map(({ input }) => input)]) {
    assert.equal((await f.send(denied)).status, 503);
  }
  assert.equal(new Set(acknowledged.map(row => row.requestId)).size, 5);
  assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: path, body: input.body ?? "",
    requestId: acknowledged[index].requestId, proof: undefined })));
  assert.deepEqual(course, { ...baseline, ...winnerFields, revision: 2 });
  const observed = f.admissionState();
  assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
  assert.deepEqual(observed.interactiveEvidence, { admitted: 5, acknowledged });
});

for (const kind of ["modules", "lessons"]) {
  test(`scoped authoring acknowledges ${kind} reorder and stale conflict with exactly three draft reads`, async t => {
    const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const courseId = fixtureId(1), foreignCourseId = fixtureId(2);
    const moduleIds = [3, 4, 5].map(fixtureId), lessonIds = [6, 7, 8].map(fixtureId);
    const [moduleId, foreignModuleId] = moduleIds;
    const modules = kind === "modules";
    const read = `/course/v1/admin/courses/${courseId}`;
    const reorderPath = parent => modules ? `/course/v1/admin/courses/${parent}/modules/reorder` : `/course/v1/admin/modules/${parent}/lessons/reorder`;
    const write = reorderPath(modules ? courseId : moduleId);
    const foreignWrite = reorderPath(modules ? foreignCourseId : foreignModuleId);
    const original = modules ? moduleIds : lessonIds;
    const winner = [original[1], original[0], original[2]];
    const stale = [original[0], original[2], original[1]];
    const revision = 7;
    const reorderBody = (ids, expectedCourseRevision = revision) => JSON.stringify({ expectedCourseRevision, ids });
    const winnerBody = reorderBody(winner), staleBody = reorderBody(stale);
    const conflict = { error: { code: "CONFLICT", message: "Course revision is stale; reload before editing" } };
    const requests = [
      { method: "GET", target: read, bodySha256: certificationHash(""), uses: 3 },
      { method: "POST", target: write, bodySha256: certificationHash(winnerBody), uses: 1 },
      { method: "POST", target: write, bodySha256: certificationHash(staleBody), uses: 1 },
    ];
    const courseResponse = (ids, courseRevision) => ({ course: { id: courseId, title: "P2Q reorder fixture", slug: "p2q-reorder-fixture",
      description: null, introduction: null, status: "draft", currency: "CAD", accessMode: "free", priceCents: 0,
      cover: null, seo: { noIndex: false }, taxClassification: null, revision: courseRevision,
      modules: (modules ? ids : moduleIds).map((id, index) => ({ id, courseId, title: `Module ${id.slice(-1)}`, slug: `module-${id.slice(-1)}`,
        description: null, position: index + 1, archivedAt: null, courseRevision,
        lessons: !modules && id === moduleId ? ids.map((lesson, position) => ({ id: lesson, moduleId, title: `Lesson ${lesson.slice(-1)}`,
          slug: `lesson-${lesson.slice(-1)}`, content: null, contentDocument: null, transcript: null, captions: [], isPreview: false,
          position: position + 1, archivedAt: null, courseRevision })) : [] })),
    } });
    const baseline = courseResponse(original, revision), expected = courseResponse(winner, revision + 1);
    const responseForWrite = value => modules ? value : { module: value.course.modules[0] };
    let order = original, currentRevision = revision;
    const forwarded = [];
    const f = await interactiveFixture(t, requests, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      forwarded.push({ method: req.method, target: req.url, body,
        requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
      const mutating = req.method === "POST";
      if (mutating) {
        const { expectedCourseRevision, ids } = JSON.parse(body);
        if (expectedCourseRevision !== currentRevision) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(conflict));
          return;
        }
        order = ids;
        currentRevision++;
      }
      const value = courseResponse(order, currentRevision);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(mutating ? responseForWrite(value) : value));
    }, "authoring");
    const post = (body, path = write) => f.signed({ method: "POST", path, body });
    for (const denied of [post(winnerBody, foreignWrite), post(reorderBody(original)), post(reorderBody(winner, revision + 1))]) {
      assert.equal((await f.send(denied)).status, 503);
    }

    const steps = [
      { input: f.signed({ path: read }), requestIndex: 0, status: 200, value: baseline },
      { input: f.signed({ path: read }), requestIndex: 0, status: 200, value: baseline },
      { input: post(winnerBody), requestIndex: 1, status: 200, value: responseForWrite(expected) },
      { input: f.signed({ path: read }), requestIndex: 0, status: 200, value: expected },
      { input: post(staleBody), requestIndex: 2, status: 409, value: conflict },
    ];
    const acknowledged = [];
    for (const { input, requestIndex, status, value } of steps) {
      const output = await f.send(input);
      assert.equal(output.status, status);
      assert.deepEqual(JSON.parse(output.body), value);
      const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
      assert.match(requestId, /^[a-f0-9-]{36}$/u);
      assert.notEqual(requestId, proofRequestId);
      acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: status });
    }
    for (const denied of [f.signed({ path: read }), post(winnerBody), post(staleBody), ...steps.map(({ input }) => input)]) {
      assert.equal((await f.send(denied)).status, 503);
    }
    assert.deepEqual(order, winner);
    assert.equal(currentRevision, revision + 1);
    assert.equal(new Set(acknowledged.map(row => row.requestId)).size, 5);
    assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, 5);
    assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
      body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined })));
    const observed = f.admissionState();
    assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.interactiveEvidence, { admitted: 5, acknowledged });
  });
}

for (const variant of ["module", "lesson", "rich lesson"]) {
  test(`scoped authoring acknowledges ${variant} creation between two exact draft reads`, async t => {
    const courseId = "20000000-0000-4000-8000-000000000001";
    const parentModuleId = "20000000-0000-4000-8000-000000000002";
    const createdId = "20000000-0000-4000-8000-000000000003";
    const foreignParentId = "20000000-0000-4000-8000-000000000004";
    const creatingModule = variant === "module";
    const richLesson = variant === "rich lesson";
    const read = `/course/v1/admin/courses/${courseId}`;
    const createPath = parentId => creatingModule ? `/course/v1/admin/courses/${parentId}/modules` : `/course/v1/admin/modules/${parentId}/lessons`;
    const write = createPath(creatingModule ? courseId : parentModuleId);
    const expectedCourseRevision = 7;
    const contentDocument = { version: 1, blocks: richLesson ? [{ _type: "block", _key: "block-7-1", style: "h2",
      children: [{ _type: "span", _key: "span-7-1", text: "Prepare the workspace", marks: ["strong", "link-7-1"] }],
      markDefs: [{ _type: "link", _key: "link-7-1", href: "https://example.com/workspace-guide" }],
    }] : [] };
    const form = creatingModule
      ? { expectedCourseRevision, title: "P2Q second module", slug: "p2q-second-module", description: "Reviewed module description", position: 2 }
      : { expectedCourseRevision, title: "P2Q first lesson", slug: "p2q-first-lesson", position: 1,
        contentDocument, transcript: "Reviewed lesson transcript", isPreview: true, captions: [] };
    const body = JSON.stringify(form);
    const requests = [
      { method: "GET", target: read, bodySha256: certificationHash(""), uses: 2 },
      { method: "POST", target: write, bodySha256: certificationHash(body), uses: 1 },
    ];
    const parent = { id: parentModuleId, courseId, title: "P2Q parent module", slug: "p2q-parent-module", description: null, position: 1,
      archivedAt: null, courseRevision: expectedCourseRevision, lessons: [] };
    const baseline = { course: { id: courseId, title: "P2Q curriculum draft", slug: "p2q-curriculum-draft", description: null, introduction: null,
      currency: "CAD", accessMode: "free", priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null,
      status: "draft", revision: expectedCourseRevision, modules: [parent] } };
    const { expectedCourseRevision: revision, ...fields } = form;
    const saved = { id: createdId, ...fields, archivedAt: null, courseRevision: revision + 1,
      ...(creatingModule ? { courseId, lessons: [] } : { moduleId: parentModuleId, content: null }) };
    const created = creatingModule ? { module: saved } : { lesson: saved };
    const after = { course: { ...baseline.course, revision: revision + 1, modules: creatingModule
      ? [{ ...parent, courseRevision: revision + 1 }, saved]
      : [{ ...parent, courseRevision: revision + 1, lessons: [saved] }] } };
    const forwarded = [];
    let current = baseline;
    const f = await interactiveFixture(t, requests, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      forwarded.push({ method: req.method, target: req.url, body: Buffer.concat(chunks).toString(),
        requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
      if (req.method === "POST") current = after;
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(req.method === "POST" ? created : current));
    }, "authoring");

    const post = (payload = body, path = write) => f.signed({ method: "POST", path, body: payload });
    const deniedRequests = [post(body, createPath(foreignParentId)), post(body, `${write}/reorder`),
      post(JSON.stringify({ ...form, title: "Unreviewed title" })), post(JSON.stringify(form, null, 2))];
    if (richLesson) {
      for (const alter of [
        block => { block.children[0].text = "Unreviewed lesson text"; },
        block => { block.children[0].marks[0] = "em"; },
        block => { block.markDefs[0].href = "https://example.com/unreviewed-guide"; },
      ]) {
        const unreviewed = structuredClone(form);
        alter(unreviewed.contentDocument.blocks[0]);
        deniedRequests.push(post(JSON.stringify(unreviewed)));
      }
    }
    for (const denied of deniedRequests) {
      assert.equal((await f.send(denied)).status, 503);
    }
    const steps = [
      { input: f.signed({ path: read }), requestIndex: 0, status: 200, value: baseline },
      { input: post(), requestIndex: 1, status: 201, value: created },
      { input: f.signed({ path: read }), requestIndex: 0, status: 200, value: after },
    ];
    const acknowledged = [];
    for (const { input, requestIndex, status, value } of steps) {
      const output = await f.send(input);
      assert.equal(output.status, status);
      assert.deepEqual(JSON.parse(output.body), value);
      const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
      assert.match(requestId, /^[a-f0-9-]{36}$/u);
      assert.notEqual(requestId, proofRequestId);
      acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: status });
      assert.equal((await f.send(input)).status, 503);
    }
    assert.equal((await f.send(f.signed({ path: read }))).status, 503);
    assert.equal((await f.send(post())).status, 503);
    assert.equal(new Set(acknowledged.map(row => row.requestId)).size, 3);
    assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, 3);
    assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
      body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined })));
    const observed = f.admissionState();
    assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.interactiveEvidence, { admitted: 3, acknowledged });
  });
}

for (const [ready, republish, name] of [
  [true, false, "ready publication and readback"],
  [false, false, "not-ready publication review without a write"],
  [true, true, "paid republish with separately scoped draft and publish writes"],
  [false, true, "blocked paid republish that retains the draft"],
]) {
  test(`scoped authoring acknowledges ${name}`, async t => {
    const courseId = "20000000-0000-4000-8000-000000000001";
    const moduleId = "20000000-0000-4000-8000-000000000002";
    const lessonId = "20000000-0000-4000-8000-000000000003";
    const foreignId = "20000000-0000-4000-8000-000000000004";
    const detail = `/course/v1/admin/courses/${courseId}`;
    const readiness = `${detail}/publication-readiness`;
    const revision = 7;
    const draftRevision = revision + Number(republish);
    const draftBody = JSON.stringify({ expectedRevision: revision, status: "draft" });
    const patchBody = JSON.stringify({ expectedRevision: draftRevision, status: "published" });
    const readinessIndex = republish ? 2 : 1;
    const requests = [
      { method: "GET", target: detail, bodySha256: certificationHash(""), uses: (ready ? 2 : 1) + Number(republish) },
      ...(republish ? [{ method: "PATCH", target: detail, bodySha256: certificationHash(draftBody), uses: 1 }] : []),
      { method: "GET", target: readiness, bodySha256: certificationHash(""), uses: 1 },
      ...(ready ? [{ method: "PATCH", target: detail, bodySha256: certificationHash(patchBody), uses: 1 }] : []),
    ];
    const blocks = ready ? [{ _type: "block", _key: "owned-block", style: "normal", markDefs: [],
      children: [{ _type: "span", _key: "owned-span", text: "Owned publication fixture content", marks: [] }] }] : [];
    const courseResponse = (status, courseRevision) => ({ course: { id: courseId, title: "P2Q publication draft", slug: "p2q-publication-draft",
      description: null, introduction: null, currency: "CAD", accessMode: republish ? "paid" : "free", priceCents: republish ? 3900 : 0,
      cover: null, seo: { noIndex: false }, taxClassification: ready || republish ? "p2q-reviewed-tax-fixture" : null, status, revision: courseRevision,
      modules: [{ id: moduleId, courseId, title: "Publication module", slug: "publication-module", description: null, position: 1,
        archivedAt: null, courseRevision, lessons: [{ id: lessonId, moduleId, title: "Publication lesson", slug: "publication-lesson", content: null,
          contentDocument: { version: 1, blocks }, transcript: null, captions: [], isPreview: false, position: 1, archivedAt: null, courseRevision }] }],
    } });
    const before = courseResponse(republish ? "archived" : "draft", revision);
    const draft = courseResponse("draft", draftRevision), published = courseResponse("published", draftRevision + 1);
    const readinessResponse = { courseId, courseRevision: draftRevision, ready, issues: ready ? [] : [
      ...(!republish ? [{ code: "TAX_CLASSIFICATION_REQUIRED", field: "taxClassification", message: "Record the reviewed tax classification before publication." }] : []),
      { code: "LESSON_CONTENT_REQUIRED", field: "contentDocument", message: "Provide nonempty lesson content, a valid quiz, or ready video.", lessonId },
    ] };
    const forwarded = [];
    let current = before;
    const f = await interactiveFixture(t, requests, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      forwarded.push({ method: req.method, target: req.url, body,
        requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
      if (req.method === "PATCH") {
        const { expectedRevision, status } = JSON.parse(body);
        current = courseResponse(status, expectedRevision + 1);
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(req.url === readiness.slice("/course".length) ? readinessResponse : current));
    }, "authoring");

    const patch = (body = patchBody, path = detail) => f.signed({ method: "PATCH", path, body });
    const denied = [f.signed({ path: detail, actor: foreignId }), f.signed({ path: readiness, actor: foreignId }),
      f.signed({ method: "PATCH", path: detail, body: patchBody, actor: foreignId }),
      f.signed({ path: `/course/v1/admin/courses/${foreignId}/publication-readiness` }),
      patch(patchBody, `/course/v1/admin/courses/${foreignId}`), patch(JSON.stringify({ expectedRevision: revision, status: "archived" })),
      patch(JSON.stringify({ expectedRevision: republish ? revision : revision + 1, status: "published" }))];
    if (republish) denied.push(patch(JSON.stringify({ expectedRevision: draftRevision, status: "draft" })));
    if (!ready) denied.push(patch());
    for (const input of denied) assert.equal((await f.send(input)).status, 503);
    const steps = [
      { input: f.signed({ path: detail }), requestIndex: 0, value: before },
      ...(republish ? [{ input: patch(draftBody), requestIndex: 1, value: draft }, { input: f.signed({ path: detail }), requestIndex: 0, value: draft }] : []),
      { input: f.signed({ path: readiness }), requestIndex: readinessIndex, value: readinessResponse },
      ...(ready ? [{ input: patch(), requestIndex: readinessIndex + 1, value: published }, { input: f.signed({ path: detail }), requestIndex: 0, value: published }] : []),
    ];
    const acknowledged = [];
    for (const { input, requestIndex, value } of steps) {
      const output = await f.send(input);
      assert.equal(output.status, 200);
      assert.deepEqual(JSON.parse(output.body), value);
      const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
      assert.match(requestId, /^[a-f0-9-]{36}$/u);
      assert.notEqual(requestId, proofRequestId);
      acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: 200 });
      assert.equal((await f.send(input)).status, 503);
      if (republish && requestIndex === 1) assert.equal((await f.send(patch(draftBody))).status, 503);
    }
    for (const input of [f.signed({ path: detail }), f.signed({ path: readiness }), patch()]) {
      assert.equal((await f.send(input)).status, 503);
    }
    assert.deepEqual(current, ready ? published : draft);
    assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
    assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
    assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
      body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined })));
    const observed = f.admissionState();
    assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.interactiveEvidence, { admitted: steps.length, acknowledged });
  });
}

for (const priorQuizRevision of [0, 2]) {
  test(`scoped authoring acknowledges ${priorQuizRevision ? "a revised" : "the first"} quiz and course readback`, async t => {
    const fixtureId = number => `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const [courseId, moduleId, lessonId, foreignLessonId, priorQuizId, newQuizId] = [1, 2, 3, 4, 5, 6].map(fixtureId);
    const actorId = "10000000-0000-4000-8000-000000000001";
    const courseTarget = `/course/v1/admin/courses/${courseId}`;
    const quizPath = id => `/course/v1/admin/lessons/${id}/quiz`;
    const quizTarget = quizPath(lessonId);
    const revision = 7;
    const questionRevision = priorQuizRevision ? revision - 1 : revision;
    const correctOptionId = `option-${questionRevision}-1`, otherOptionId = `option-${questionRevision}-2`;
    const question = { id: `question-${questionRevision}-1`, prompt: "What should you check first?", options: [
      { id: correctOptionId, text: "The workspace" }, { id: otherOptionId, text: "The final result" },
    ], correctOptionId, feedback: "Check the workspace before beginning." };
    const document = { version: 1, mode: "graded", passingPercent: 80, questions: [question] };
    const body = JSON.stringify({ expectedCourseRevision: revision, document });
    const requests = [
      { method: "GET", target: courseTarget, bodySha256: certificationHash(""), uses: 2 },
      { method: "GET", target: quizTarget, bodySha256: certificationHash(""), uses: 1 },
      { method: "PUT", target: quizTarget, bodySha256: certificationHash(body), uses: 1 },
    ];
    const courseResponse = courseRevision => ({ course: { id: courseId, title: "P2Q assessment draft", slug: "p2q-assessment-draft", description: null,
      introduction: null, currency: "CAD", accessMode: "free", priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null,
      status: "draft", revision: courseRevision, modules: [{ id: moduleId, courseId, title: "Assessment module", slug: "assessment-module",
        description: null, position: 1, archivedAt: null, courseRevision, lessons: [{ id: lessonId, moduleId, title: "Assessment lesson",
          slug: "assessment-lesson", content: null, contentDocument: { version: 1, blocks: [] }, transcript: null, captions: [], isPreview: false,
          position: 1, archivedAt: null, courseRevision }] }],
    } });
    const before = courseResponse(revision), after = courseResponse(revision + 1);
    const quizResponse = (id, quizRevision, courseRevision, savedDocument) => ({ quiz: { id, lessonId, revision: quizRevision,
      courseRevision, document: savedDocument, createdBy: actorId, createdAt: "2026-11-07T16:00:00.000Z" } });
    const priorStatus = priorQuizRevision ? 200 : 404;
    const prior = priorQuizRevision ? quizResponse(priorQuizId, priorQuizRevision, revision,
      { ...document, questions: [{ ...question, feedback: "Prior feedback remains in quiz history." }] }) : { error: { code: "NOT_FOUND", message: "Quiz not found" } };
    const saved = quizResponse(newQuizId, priorQuizRevision + 1, revision + 1, document);
    const forwarded = [];
    let current = before;
    const f = await interactiveFixture(t, requests, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      forwarded.push({ method: req.method, target: req.url, body: Buffer.concat(chunks).toString(),
        requestId: req.headers["x-request-id"], proof: req.headers[SCOPED_INTERACTIVE_HEADER] });
      if (req.method === "PUT") current = after;
      const quizRead = req.method === "GET" && req.url === quizTarget.slice("/course".length);
      res.writeHead(quizRead ? priorStatus : 200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(quizRead ? prior : req.method === "PUT" ? saved : current));
    }, "authoring");

    const put = (payload = body, path = quizTarget) => f.signed({ method: "PUT", path, body: payload });
    const unreviewed = { ...document, questions: [{ ...question, correctOptionId: otherOptionId }] };
    for (const input of [f.signed({ path: quizPath(foreignLessonId) }), put(body, quizPath(foreignLessonId)),
      put(JSON.stringify({ expectedCourseRevision: revision, document: unreviewed })),
      put(JSON.stringify({ expectedCourseRevision: revision + 1, document }))]) {
      assert.equal((await f.send(input)).status, 503);
    }
    const steps = [
      { input: f.signed({ path: courseTarget }), requestIndex: 0, status: 200, value: before },
      { input: f.signed({ path: quizTarget }), requestIndex: 1, status: priorStatus, value: prior },
      { input: put(), requestIndex: 2, status: 200, value: saved },
      { input: f.signed({ path: courseTarget }), requestIndex: 0, status: 200, value: after },
    ];
    const acknowledged = [];
    for (const { input, requestIndex, status, value } of steps) {
      const output = await f.send(input);
      assert.equal(output.status, status);
      assert.deepEqual(JSON.parse(output.body), value);
      const requestId = output.headers["x-request-id"], proofRequestId = input.headers["x-request-id"];
      assert.match(requestId, /^[a-f0-9-]{36}$/u);
      assert.notEqual(requestId, proofRequestId);
      acknowledged.push({ requestId, proofRequestId, requestIndex, upstreamStatus: status });
      assert.equal((await f.send(input)).status, 503);
    }
    for (const input of [f.signed({ path: courseTarget }), f.signed({ path: quizTarget }), put()]) {
      assert.equal((await f.send(input)).status, 503);
    }
    assert.equal(new Set(acknowledged.map(row => row.requestId)).size, steps.length);
    assert.equal(new Set(acknowledged.map(row => row.proofRequestId)).size, steps.length);
    assert.deepEqual(forwarded, steps.map(({ input }, index) => ({ method: input.method, target: input.path.slice("/course".length),
      body: input.body ?? "", requestId: acknowledged[index].requestId, proof: undefined })));
    const observed = f.admissionState();
    assert.deepEqual(observed.active, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.uncertain, { newWork: 0, recovery: 0 });
    assert.deepEqual(observed.interactiveEvidence, { admitted: steps.length, acknowledged });
  });
}

function mediaRefreshReceipt(lessonId, id) {
  return { id, lessonId, status: "processing", generation: 2, isCurrent: false, lastErrorCode: null,
    captionTracks: [{ id: "owned-track", language: "en", label: "English", status: "ready", closedCaptions: true }] };
}

test("scoped media refresh accepts the normal bodyless POST without a content type", async t => {
  const lesson = "20000000-0000-4000-8000-000000000002";
  const asset = "30000000-0000-4000-8000-000000000003";
  const target = `/course/v1/admin/lessons/${lesson}/video/${asset}/refresh`;
  const method = "POST";
  const requests = [{ method, target, bodySha256: certificationHash(""), uses: 2 }];
  const forwarded = [];
  const f = await interactiveFixture(t, requests, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push({ method: req.method, path: req.url, contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(mediaRefreshReceipt(lesson, asset)));
  }, "media");
  const bodyless = f.signed({ method, path: target });
  assert.equal((await f.send({ ...bodyless, headers: { ...bodyless.headers, "content-type": "text/plain" } })).status, 503);
  assert.equal((await f.send(f.signed({ method, path: target, body: "{}" }))).status, 503);
  assert.equal((await f.send(bodyless)).status, 200);
  assert.equal((await f.send(f.signed({ method, path: target, body: "" }))).status, 200);
  assert.deepEqual(forwarded, [undefined, "application/json"].map(contentType => ({
    method, path: target.slice("/course".length), contentType, body: "",
  })));
  assert.equal(f.admissionState().interactiveEvidence.acknowledged.length, 2);
});

test("scoped media retains ambiguous Course 409 and unresolved or mismatched refresh 200", async t => {
  const lesson = "20000000-0000-4000-8000-000000000002";
  const asset = "30000000-0000-4000-8000-000000000003";
  const target = `/course/v1/admin/lessons/${lesson}/video/${asset}`;
  const receipt = mediaRefreshReceipt(lesson, asset);
  const error = code => ({ error: { code, message: "Media requires refresh or reconciliation" } });
  const captionBody = '{"expectedCourseRevision":3,"url":"https://captions.example.test/owned.vtt","language":"en","label":"English"}';
  for (const [suffix, body, status, response] of [
    ["captions", captionBody, 409, error("CAPTION_OUTCOME_UNKNOWN")],
    ["refresh", undefined, 409, error("MEDIA_LEASE_LOST")],
    ["refresh", undefined, 200, { ...receipt, lastErrorCode: "UPLOAD_SCAN_INCOMPLETE" }],
    ["refresh", undefined, 200, { ...receipt, id: lesson }],
    ["refresh", undefined, 200, { ...receipt, captionTracks: [null] }],
  ]) {
    const path = `${target}/${suffix}`, method = "POST";
    const requests = [{ method, target: path, bodySha256: certificationHash(body ?? ""), uses: 3 }];
    let forwarded = 0;
    const f = await interactiveFixture(t, requests, (_req, res) => {
      forwarded++;
      res.writeHead(forwarded === 1 ? 409 : status, { "content-type": "application/json" });
      res.end(JSON.stringify(forwarded === 1 ? error("MEDIA_BUSY") : response));
    }, "media");
    const send = () => f.send(f.signed({ method, path, body }));
    assert.equal((await send()).status, 409);
    assert.equal((await send()).status, status);
    assert.equal((await send()).status, 503);
    const observed = f.admissionState();
    assert.equal(forwarded, 2);
    assert.equal(observed.interactiveEvidence.admitted, 2);
    assert.deepEqual(observed.interactiveEvidence.acknowledged.map(row => row.upstreamStatus), [409]);
    assert.deepEqual(observed.uncertain, { newWork: 1, recovery: 0 });
  }
});

test("invalid and retired interactive v3 states deny private GETs while ordinary state remains compatible", async t => {
  const path = "/course/v1/student/courses";
  const requests = [{ method: "GET", target: path, bodySha256: certificationHash(""), uses: 1 }];
  let forwarded = 0;
  const f = await interactiveFixture(t, requests, (_req, res) => {
    forwarded++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  assert.equal(createAdmissionReader(f.staging, f.options)().valid, true);
  assert.equal(createAdmissionReader(f.staging, { ...f.options, interactiveGroup: f.options.interactiveGroup + 1n })().valid, false);
  assert.equal(createAdmissionReader(f.staging, { processBinding: f.options.processBinding })().valid, false);
  const unsigned = { path, headers: { authorization: f.signed({ path }).headers.authorization } };
  for (const [index, patch] of [
    { mountInode: "0" },
    { gatewayProcessSha256: "0".repeat(64) },
    { deploymentHost: "staging.lashher.com" },
    { requests: [requests[0], requests[0]] },
    { requests: [{ ...requests[0], bodySha256: "e".repeat(64) }] },
    { requests: [{ ...requests[0], uses: 5 }] },
    { requests: [{ ...requests[0], method: "POST", target: "/course/v1/internal/accounts/commands" }] },
    { requests: [{ ...requests[0], method: "GET", target: "/course/v1/admin/entitlements/grants" }] },
    { requests: [{ ...requests[0], target: path + "?" }] },
    { requests: [{ ...requests[0], target: path + "?owned=" + "x".repeat(512) }] },
    { expiresAt: new Date(f.start - 1).toISOString() },
    { expiresAt: new Date(f.start + 301_000).toISOString() },
  ].entries()) {
    f.save({ ...f.state, actionId: `owned-bad-${index}`, interactive: { ...f.state.interactive, ...patch } });
    assert.equal((await f.send(unsigned)).status, 503);
    assert.equal(f.admissionState().interactiveActive, false);
  }
  f.save(f.state);
  chmodSync(f.file, 0o644);
  assert.equal((await f.send(unsigned)).status, 503);
  f.save(f.state);
  writeFileSync(f.file, certificationCanonical(f.state).replace('"version":3', '"version":3,"version":3') + "\n");
  assert.equal((await f.send(unsigned)).status, 503);
  f.save(f.state);
  assert.equal(f.admissionState().interactiveActive, true);
  f.setProcess("0".repeat(64));
  assert.equal((await f.send(unsigned)).status, 503);
  f.setProcess(f.state.interactive.gatewayProcessSha256);
  assert.equal((await f.send(f.signed({ path }))).status, 503);
  const clock = { ...f.state, actionId: "owned-interactive-clock" };
  f.save(clock);
  assert.equal(f.admissionState().interactiveActive, true);
  f.setClock(f.start, 60_000_000_000n);
  assert.equal((await f.send(unsigned)).status, 503);
  assert.equal(f.admissionState().interactiveActive, false);
  rmSync(f.file);
  assert.equal((await f.send(unsigned)).status, 503);
  assert.equal(forwarded, 0);
  f.save(f.ordinary);
  assert.equal((await f.send(f.signed({ path }))).status, 503);
  assert.equal((await f.send(unsigned)).status, 200);
  assert.equal(f.admissionState().version, 1);
});

test("scoped interactive lost and errored upstream acknowledgements retain uncertainty after closure", async t => {
  const path = "/course/v1/student/courses";
  const requests = [{ method: "GET", target: path, bodySha256: certificationHash(""), uses: 2 }];
  for (const lost of [false, true]) {
    let forwarded = 0;
    const f = await interactiveFixture(t, requests, (req, res) => {
      forwarded++;
      if (lost) {
        req.socket.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end('{"error":{"code":"BAD_GATEWAY","message":"Owned receiver response lost"}}');
    });
    assert.equal((await f.send(f.signed({ path }))).status, 502);
    assert.equal((await f.send(f.signed({ path }))).status, 503);
    assert.equal(forwarded, 1);
    assert.deepEqual(f.admissionState().interactiveEvidence, { admitted: 1, acknowledged: [] });
    assert.deepEqual(f.admissionState().active, { newWork: 0, recovery: 0 });
    assert.deepEqual(f.admissionState().uncertain, { newWork: 1, recovery: 0 });
    f.save(f.ordinary);
    assert.deepEqual(f.admissionState().uncertain, { newWork: 1, recovery: 0 });
  }
});

test("scoped Mux selection binds upload IDs and requires a managed marker for an unknown asset", () => {
  const attemptId = "00000000-0000-4000-8000-000000000003";
  const environmentId = "owned-environment", signature = "owned-provider-signature";
  const marker = `lash-her-course:${environmentId}:${attemptId}`;
  const scope = { attemptId, environmentId, generation: 2, uploadId: "owned-upload", assetId: null };
  const event = { id: "owned-event", environment: { id: environmentId } };
  const check = (eventType, data) => selectScopedMuxCallback({ ...scope, eventType },
    Buffer.from(JSON.stringify({ ...event, type: eventType, data })), signature);
  assert.deepEqual(check("video.upload.asset_created", { id: scope.uploadId, asset_id: "owned-asset" }),
    { target: `${attemptId}:2`, eventId: event.id });
  assert.equal(check("video.upload.asset_created", { id: "foreign-upload", asset_id: "owned-asset" }), null);
  assert.equal(check("video.asset.ready", { id: "owned-asset" }), null);
  assert.deepEqual(check("video.asset.ready", { id: "owned-asset", passthrough: marker }),
    { target: `${attemptId}:2`, eventId: event.id });
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

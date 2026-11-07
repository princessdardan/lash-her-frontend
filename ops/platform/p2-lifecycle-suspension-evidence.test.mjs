import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { expireP2InteractiveBrowserCookie, installP2InteractiveBrowserCookie, p2InteractiveBrowserPath, parseP2OwnerSuspensionResponse,
  parseP2PlaybackObservation, readP2InteractiveBrowserPermit, validateP2InteractiveBrowserInput, validateP2InteractiveBrowserPermit,
  validateP2LifecycleBrowserInput } from "./p2-lifecycle-browser-recorder.mjs";
import { qualifyP2SuspensionPending, P2_LIFECYCLE_PENDING_SQL } from "./p2-lifecycle-pending-probe.mjs";
import { launchP2InteractiveBrowserRecorder, launchP2LifecycleBrowserRecorder, validateP2SuspensionBrowserRecord, prepareP2LifecycleSuspensionPlan, readP2LifecycleBrowserSourceArtifact, P2_LIFECYCLE_BROWSER_LAUNCHER } from "./p2-lifecycle-suspension-evidence.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { prepareP2LifecyclePersistencePlan, p2LifecyclePersistenceTargetSha256 } from "./p2-lifecycle-persistence-probe.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";

const at = "2026-11-06T12:00:00.000Z", userId = randomUUID(), commandId = randomUUID(), adminId = randomUUID();
const headers = { "cache-control": "private, no-store", "x-request-id": randomUUID(), date: at };
function input() { return { version: 1, environment: "staging", actionId: "owned-browser", challenge: "a".repeat(64), bindingSha256: "b".repeat(64),
  sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app", browserOrigin: "https://staging.lashher.com", userId, courseId: randomUUID(), lessonId: randomUUID(), windowSeconds: 840 }; }
function pending() {
  const command = { version: 1, commandId, userId, accountVersion: 1, action: "suspend", issuedAt: at };
  return { selection: { userId, commandId, accountVersion: 1, requestId: headers["x-request-id"], responseObservedAt: at, controlledDenialObservedAt: "2026-11-06T12:05:31.000Z" },
    observation: { identity: { read_only: "on" }, account: [{ id: userId, status: "suspended", account_version: "1" }],
      command: [{ command_id: commandId, user_id: userId, account_version: "1", action: "suspend", issued_at: new Date(at), command, requested_by_admin_id: adminId }],
      deliveries: ["course", "community"].map(receiver => ({ receiver, status: "pending", attempts: 0, lease_id: null, lease_until: null, acknowledged_at: null })),
      later: 0, outstanding: 2, sessions: 0, owner: [{ id: adminId, status: "active", role: "owner" }], now: "2026-11-06T12:05:32.000Z" } };
}
function browserRecord(selected) {
  const event = (type, elapsedMs, extra) => ({ type, observedAt: new Date(Date.parse(at) + elapsedMs).toISOString(), elapsedMs, ...extra });
  return { version: 1, status: "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED", environment: "staging", actionId: selected.actionId, challenge: selected.challenge,
    bindingSha256: selected.bindingSha256, sourceCommit: selected.sourceCommit, deploymentId: selected.deploymentId, deploymentUrl: selected.deploymentUrl, browserOrigin: selected.browserOrigin,
    userId: selected.userId, courseId: selected.courseId, lessonId: selected.lessonId,
    events: [event("ordinary-playback-authorized", 1, { httpStatus: 200, lifetimeMs: 600000, privateNoStore: true }), event("player-present", 2, { muxPlayerCount: 1 }),
      event("ordinary-owner-suspension-accepted", 3000, { commandId, accountVersion: 1, action: "suspend", status: "pending", requestId: headers["x-request-id"] }),
      event("ordinary-renewal-denied", 570001, { httpStatus: 401, errorCode: "sign_in_required", requestId: randomUUID(), privateNoStore: true }),
      event("player-removed", 570100, { muxPlayerCount: 0, sessionEndedAlert: true })],
    contextsIsolated: true, sessionsFabricated: false, clockChanged: false, requestsIntercepted: false, tokensRetained: false, rawHarRetained: false,
    playbackRemovalAfterSuspensionMs: 567100, nativeInvocationQualified: false, releaseAccepted: false };
}
function documents() {
  const raw = { version: 1, environment: "staging", releaseId: "owned-browser-release", hostMachineId: "1".repeat(32), candidateSha256: "1".repeat(64),
    configurationSha256: "2".repeat(64), sources: { frontend: nativeSourceCommit(), course: "2".repeat(40), community: "3".repeat(40) },
    targets: Object.fromEntries(["frontend", "course", "community"].map(service => {
      const target = { host: "localhost", port: 5432, database: "owned_" + service, runtimeRole: "owned_" + service, runtimeRoleOid: "1234", serverMajor: 16 };
      return [service, { ...target, targetSha256: p2LifecyclePersistenceTargetSha256(service, target) }];
    })), containerImages: Object.fromEntries(["course", "community"].map(service => [service, `ghcr.io/princessdardan/lash-her-platform-${service}-runtime@sha256:${"6".repeat(64)}`])),
    operatorSourceSha256: "7".repeat(64), frontendDeploymentSha256: "8".repeat(64), originalReleaseSha256: "9".repeat(64),
    expectedMigrations: { frontend: 83, course: 22, community: 11 } };
  const persistencePlan = prepareP2LifecyclePersistencePlan(raw), target = { host: raw.targets.frontend.host, port: raw.targets.frontend.port,
    database: raw.targets.frontend.database, user: "owned_operator", serverMajor: raw.targets.frontend.serverMajor };
  const producer = { producerSha256: "b".repeat(64), role: { name: raw.targets.frontend.runtimeRole, oid: raw.targets.frontend.runtimeRoleOid } };
  return { candidate: { version: 2, environment: "staging", releaseId: raw.releaseId, contractPhase: "p2", integration: { state: "passed" },
    sourceApproval: { mode: "single-operator-dispatch", operatorGithubUserId: "8996309" }, workload: { projectId: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM", environment: "production" },
    sources: Object.fromEntries(["frontend", "course", "community"].map(service => [service, { repository: `https://github.com/princessdardan/lash-her-${service === "frontend" ? "frontend" : service + "-api"}.git`, commit: raw.sources[service], requiredChecks: "passed" }])) },
  input: { version: 1, actionId: "owned-ui-pending", candidateSha256: raw.candidateSha256, persistencePlan,
    deployment: { deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app", configurationRecordSha256: "e".repeat(64),
      featureControls: structuredClone(P2_CERTIFICATION_PROFILE.featureControls), writerAdmissionBinding: { mode: "enforce", targetSha256: frontendAdmissionTargetSha256("staging", target),
        producerSha256: producer.producerSha256, sourceCommit: raw.sources.frontend, roleName: producer.role.name } },
    target, owner: { name: "admission_owner", oid: "1235" }, producer, resources: { userId, courseId: randomUUID(), lessonId: randomUUID() },
    windowSeconds: 840, drainSeconds: 10, operatorSourceCommit: raw.sources.frontend } };
}
function profiledDocuments() {
  const selected = structuredClone(documents()), persisted = selected.input.persistencePlan;
  const fields = ["environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
    "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations"];
  const raw = Object.fromEntries(fields.map(name => [name, persisted[name]])); raw.version = 2; raw.qualificationTargetProfile = current;
  for (const [service, target] of Object.entries(raw.targets)) {
    target.qualificationTargetProfile = current;
    target.targetSha256 = p2LifecyclePersistenceTargetSha256(service, target, current);
  }
  selected.input.persistencePlan = prepareP2LifecyclePersistencePlan(raw, current);
  selected.input.version = 2; selected.input.qualificationTargetProfile = current; selected.input.target.qualificationTargetProfile = current;
  selected.candidate.version = 3;
  selected.candidate.approval = {};
  selected.candidate.frontendMigration = {};
  for (const carrier of [selected.candidate, selected.candidate.integration, selected.candidate.sourceApproval,
    ...Object.values(selected.candidate.sources), selected.candidate.workload, selected.candidate.approval, selected.candidate.frontendMigration]) {
    carrier.qualificationTargetProfile = current;
  }
  return selected;
}

test("browser plan has no invented command witnesses and requires same-source exact profile and three-source context", () => {
  const selected = documents(), plan = prepareP2LifecycleSuspensionPlan(selected.candidate, selected.input);
  assert.equal(plan.windowSeconds, 840); assert.equal(plan.workerInvocationAuthorized, false); assert.equal(Object.hasOwn(plan, "commandWitnesses"), false);
  assert.equal(JSON.stringify(plan).includes(userId), false);
  assert.throws(() => launchP2LifecycleBrowserRecorder(JSON.parse(JSON.stringify(plan)), "/private/tmp/foreign"));
  assert.throws(() => readP2LifecycleBrowserSourceArtifact(plan, { recordSha256: "a".repeat(64) }));
  for (const change of [row => { row.input.operatorSourceCommit = "f".repeat(40); }, row => { row.input.windowSeconds = 60; },
    row => { row.input.deployment.featureControls.INTEGRATION_CHECKOUT_ENABLED = true; }, row => { row.candidate.sources.course.commit = "f".repeat(40); },
    row => { row.input.deployment.writerAdmissionBinding.targetSha256 = "f".repeat(64); }]) {
    const fixture = structuredClone(documents()); change(fixture); assert.throws(() => prepareP2LifecycleSuspensionPlan(fixture.candidate, fixture.input));
  }
});

test("profiled browser source plan binds candidate3, current persistence targets and raw workload hash without enabling apply", () => {
  const selected = profiledDocuments(), plan = prepareP2LifecycleSuspensionPlan(selected.candidate, selected.input, current);
  assert.equal(plan.version, 2); assert.deepEqual(plan.qualificationTargetProfile, current);
  assert.equal(plan.profile, "normal-ui-suspension-pending-v1");
  assert.equal(plan.configurationRecordSha256, selected.input.deployment.configurationRecordSha256);
  assert.equal(plan.candidateSha256, selected.input.candidateSha256);
  assert.throws(() => launchP2LifecycleBrowserRecorder(plan, "/private/tmp/foreign"));
  for (const change of [row => { delete row.input.target.qualificationTargetProfile; },
    row => { delete row.input.persistencePlan.targets.course.qualificationTargetProfile; },
    row => { delete row.candidate.sources.frontend.qualificationTargetProfile; },
    row => { row.candidate.version = 2; }]) {
    const fixture = profiledDocuments(); change(fixture);
    assert.throws(() => prepareP2LifecycleSuspensionPlan(fixture.candidate, fixture.input, current));
  }
  assert.throws(() => prepareP2LifecycleSuspensionPlan(selected.candidate, selected.input));
});

test("fixed browser input has no injection, storage, clock, credential, URL or command hook", () => {
  validateP2LifecycleBrowserInput(input());
  for (const change of [row => { row.context = {}; }, row => { row.storageState = {}; }, row => { row.deploymentUrl = "http://localhost:3000"; },
    row => { row.browserOrigin = "https://foreign.invalid"; }, row => { row.windowSeconds = 60; }, row => { row.environment = "production"; }, row => { row.commandId = commandId; }]) {
    const value = input(); change(value); assert.throws(() => validateP2LifecycleBrowserInput(value));
  }
  assert.throws(() => launchP2LifecycleBrowserRecorder({ version: 1 }, "/private/tmp/foreign"));
});

test("owner response uses actual202 and header request ID; issuedAt is not invented", () => {
  const body = { commandId, accountVersion: 1, action: "suspend", status: "pending" };
  const record = parseP2OwnerSuspensionResponse(202, headers, body);
  assert.equal(record.requestId, headers["x-request-id"]); assert.equal(Object.hasOwn(record, "issuedAt"), false);
  for (const [status, selectedHeaders, selectedBody] of [[200, headers, body], [202, {}, body], [202, headers, { ...body, issuedAt: at }],
    [202, headers, { ...body, action: "delete" }], [403, headers, body]]) assert.throws(() => parseP2OwnerSuspensionResponse(status, selectedHeaders, selectedBody));
});

test("natural600s initial playback retains expiry metadata but no token or playback identifier", () => {
  const token = "OWNED-PRIVATE-TOKEN-NEVER-RETAINED";
  const body = { expiresAt: "2026-11-06T12:10:00.000Z", playbackId: "owned-playback", playbackToken: token, thumbnailExpiresAt: "2026-11-06T12:10:00.000Z", thumbnailToken: token };
  const record = parseP2PlaybackObservation(200, headers, body, true); assert.equal(record.lifetimeMs, 600000);
  for (const secret of [token, body.playbackId]) assert.equal(JSON.stringify(record).includes(secret), false);
  assert.throws(() => parseP2PlaybackObservation(200, headers, { ...body, expiresAt: "2026-11-06T12:00:40.000Z" }, true));
});

test("ordinaryrenewal401 cannot be substituted with redirect, quota, servicefailure or wrong error", () => {
  const body = { error: { code: "sign_in_required", message: "Sign in required" }, requestId: headers["x-request-id"] };
  assert.equal(parseP2PlaybackObservation(401, headers, body).httpStatus, 401);
  for (const status of [200, 302, 403, 429, 500, 503]) assert.throws(() => parseP2PlaybackObservation(status, headers, body));
  assert.throws(() => parseP2PlaybackObservation(401, headers, { ...body, error: { ...body.error, code: "service_unavailable" } }));
});

test("pending authority requires actualcanonical command, active owner, revoked sessions and two untouched deliveries", () => {
  const fixture = pending(); assert.equal(qualifyP2SuspensionPending(fixture.observation, fixture.selection).requestedByAdminId, adminId);
  for (const change of [row => { row.deliveries[0].attempts = 1; }, row => { row.deliveries[1].lease_id = randomUUID(); },
    row => { row.deliveries[0].acknowledged_at = at; }, row => { row.later = 1; }, row => { row.sessions = 1; },
    row => { row.owner[0].role = "course-editor"; }, row => { row.command[0].command.issuedAt = "2026-11-06T12:01:00.000Z"; },
    row => { row.command[0].requested_by_admin_id = null; }, row => { row.outstanding = 3; }]) {
    const selected = pending(); change(selected.observation); assert.throws(() => qualifyP2SuspensionPending(selected.observation, selected.selection));
  }
  assert.ok(Object.values(P2_LIFECYCLE_PENDING_SQL).every(sql => sql.startsWith("SELECT ") && !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u.test(sql)));
});

test("browser schema requires ordered source response and DOM events plus actual player removal", () => {
  const selected = input(); validateP2SuspensionBrowserRecord(browserRecord(selected), selected);
  for (const change of [row => { row.events[3].httpStatus = 503; }, row => { row.events[4].muxPlayerCount = 1; }, row => { row.events.splice(3, 1); },
    row => { row.events[3].elapsedMs = 0; }, row => { row.sessionsFabricated = true; }, row => { row.challenge = "f".repeat(64); }]) {
    const record = browserRecord(selected); change(record); assert.throws(() => validateP2SuspensionBrowserRecord(record, selected));
  }
});

test("standalone source child without parentIPC refuses before browser or network", () => {
  const result = spawnSync(process.execPath, [new URL("./p2-lifecycle-browser-recorder.mjs", import.meta.url).pathname], { encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } });
  assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});

test("actual immutable-bytes NodeIPC launcher refuses malformed input without browser, token or artifact", async () => {
  const bytes = readFileSync(new URL("./p2-lifecycle-browser-recorder.mjs", import.meta.url), "utf8") + P2_LIFECYCLE_BROWSER_LAUNCHER;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", bytes], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH } });
  const messages = []; let output = "";
  child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; }); child.on("message", value => messages.push(value));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const exited = new Promise((done, fail) => { child.once("error", fail); child.once("exit", code => done(code)); });
    child.send({ type: "initialize", input: { privateMarker: "OWNED-PRIVATE-MARKER" } });
    assert.equal(await exited, 1); assert.deepEqual(messages, [{ type: "failed" }]); assert.equal(output, "");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
});

function interactiveInput(overrides = {}) {
  return { version: 2, environment: "staging", actionId: "owned-interactive", challenge: "b".repeat(64), bindingSha256: "c".repeat(64),
    sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app",
    browserOrigin: "https://staging.lashher.com", stage: "identity", epoch: "9", windowSeconds: 120, ...overrides };
}
function interactivePermit(input) {
  const issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const lifecycle = input.stage === "lifecycle";
  const cookie = [lifecycle ? "v2" : "v1", input.epoch, input.stage, issued, expires, "3".repeat(32),
    ...(lifecycle ? ["4".repeat(64)] : []), "5".repeat(64)].join(".");
  return { stage: input.stage, epoch: input.epoch, expires, cookie };
}
const binding = input => ({ challenge: input.challenge, bindingSha256: input.bindingSha256, stage: input.stage, epoch: input.epoch });
const privateFrame = (input, context, permit) => Buffer.from(JSON.stringify({
  challenge: input.challenge, bindingSha256: input.bindingSha256, context, permit,
}) + "\n");

test("interactive recorder requires the exact in-process reviewed plan and a fixed stage, epoch and actor context", async () => {
  const input = interactiveInput();
  assert.deepEqual(validateP2InteractiveBrowserInput(input), input);
  assert.equal(p2InteractiveBrowserPath("identity", "owner"), "/admin/sign-in");
  assert.equal(p2InteractiveBrowserPath("learning", "learner"), "/academy");
  assert.throws(() => p2InteractiveBrowserPath("learning", "owner"));
  assert.throws(() => p2InteractiveBrowserPath("identity", "__proto__"));
  for (const change of [{ cookie: "private" }, { browserOrigin: "https://elsewhere.example" }, { epoch: 9 }, { stage: ["identity"] }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, ...change }));
  }
  await assert.rejects(launchP2InteractiveBrowserRecorder(Object.freeze({ ...input, mode: "interactive-browser" })));
  for (const selected of [input, interactiveInput({ stage: "lifecycle" })]) {
    const permit = interactivePermit(selected);
    assert.equal(validateP2InteractiveBrowserPermit(permit, selected), permit);
    assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: permit.cookie.replace(/^v[12]/u, "v3") }, selected));
    assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, epoch: "8" }, selected));
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, selected, permit.expires));
  }
});

test("private stdin accepts one bounded matching frame per phase and refuses replay, duplication, malformed bytes and EOF", async () => {
  const input = interactiveInput(), context = "owner", permit = interactivePermit(input), selection = { context, expires: permit.expires };
  const frame = privateFrame(input, context, permit), stream = new PassThrough();
  const received = readP2InteractiveBrowserPermit(stream, input, selection);
  stream.write(frame.subarray(0, 19));
  stream.write(frame.subarray(19));
  assert.deepEqual(await received, permit);
  const next = interactiveInput({ stage: "lifecycle", epoch: "11", bindingSha256: "d".repeat(64) }), nextPermit = interactivePermit(next);
  const stale = readP2InteractiveBrowserPermit(stream, next, { context, expires: nextPermit.expires });
  stream.write(frame);
  await assert.rejects(stale, { message: "P2_INTERACTIVE_BROWSER_STDIN_REFUSED" });
  stream.destroy();
  for (const invalid of [Buffer.concat([frame, frame]), Buffer.alloc(1025, 97), Buffer.from("{bad json}\n"),
    privateFrame({ ...input, challenge: "f".repeat(64) }, context, permit), privateFrame(input, "learner", permit),
    Buffer.from(frame.toString().replace('"context":', '"context":"owner","context":')), Buffer.alloc(0)]) {
    const stream = new PassThrough(), observed = readP2InteractiveBrowserPermit(stream, input, selection);
    stream.end(invalid);
    await assert.rejects(observed, { message: "P2_INTERACTIVE_BROWSER_STDIN_REFUSED" });
  }
});

function interactiveChild() {
  const bytes = readFileSync(new URL("./p2-lifecycle-browser-recorder.mjs", import.meta.url), "utf8") + P2_LIFECYCLE_BROWSER_LAUNCHER;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", bytes], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  const records = [], output = [];
  child.on("message", value => records.push(value));
  child.stdout.on("data", value => output.push(value));
  child.stderr.on("data", value => output.push(value));
  const exited = once(child, "close");
  const command = (type, input, frame) => {
    const response = once(child, "message");
    child.send({ type, input });
    if (frame) child.stdin.write(frame);
    return Promise.race([response.then(([receipt]) => receipt), exited.then(() => { throw new Error("OWNED_INTERACTIVE_CHILD_EXITED"); })]);
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const close = async () => { clearTimeout(timer); if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); await exited; };
  return { child, records, output, exited, command, close };
}

test("actual interactive child refuses secret-bearing IPC before browser launch and emits only a generic failure", async () => {
  const input = interactiveInput(), permit = interactivePermit(input), runner = interactiveChild();
  try {
    assert.deepEqual(await runner.command("initialize-interactive", input), { type: "interactive-initialized", ...binding(input) });
    assert.deepEqual(await runner.command("interactive-install", { ...binding(input), context: "owner", expires: permit.expires, cookie: permit.cookie }), { type: "failed" });
    assert.deepEqual(await runner.exited, [1, null]);
    assert.deepEqual(runner.output, []);
    assert.equal(JSON.stringify(runner.records).includes(permit.cookie), false);
  } finally { await runner.close(); }
});

const ownedInteractiveBrowser = process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST === "true";
test("owned Chromium installs the exact host-only permit and expires it without disturbing the other context or cookies",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const input = interactiveInput(), permit = interactivePermit(input), origin = input.browserOrigin + "/";
      const owner = await browser.newContext(), learner = await browser.newContext();
      await owner.addCookies([{ name: "owned-session", value: "owned-fixture", url: origin }]);
      await installP2InteractiveBrowserCookie(owner, permit, input);
      const engine = await owner.newCDPSession(await owner.newPage());
      const named = async url => (await engine.send("Network.getCookies", { urls: [url] })).cookies.find(row => row.name === "__Host-lash-p2q-window");
      const cookie = await named(origin);
      assert.deepEqual({ domain: cookie.domain, path: cookie.path, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite },
        { domain: "staging.lashher.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
      for (const url of ["https://lashher.com", "https://other.staging.lashher.com", input.deploymentUrl, "https://accounts.google.com", "http://staging.lashher.com"]) {
        assert.equal(await named(url), undefined);
      }
      assert.equal((await learner.cookies([origin])).length, 0);
      await expireP2InteractiveBrowserCookie(owner);
      assert.equal(await named(origin), undefined);
      assert.deepEqual((await owner.cookies([origin])).map(row => row.name), ["owned-session"]);
    } finally { await browser.close(); }
  });

test("owned Chromium child rotates the stage only after clearing and retains only sanitized protocol receipts",
  { skip: !ownedInteractiveBrowser }, async () => {
    const runner = interactiveChild(), first = interactiveInput(), firstPermit = interactivePermit(first), context = "owner";
    const next = interactiveInput({ stage: "lifecycle", epoch: "11", actionId: "owned-next-phase", bindingSha256: "d".repeat(64) }), nextPermit = interactivePermit(next);
    try {
      assert.equal((await runner.command("initialize-interactive", first)).type, "interactive-initialized");
      const firstSelection = { context, expires: firstPermit.expires };
      assert.deepEqual(await runner.command("interactive-install", { ...binding(first), ...firstSelection }, privateFrame(first, context, firstPermit)),
        { type: "interactive-permit-installed", ...binding(first), ...firstSelection });
      assert.deepEqual(await runner.command("interactive-clear", { ...binding(first), ...firstSelection }),
        { type: "interactive-permit-cleared", ...binding(first), ...firstSelection });
      assert.deepEqual(await runner.command("interactive-select", { ...binding(first), next }), { type: "interactive-selected", ...binding(next) });
      const nextSelection = { context, expires: nextPermit.expires };
      assert.deepEqual(await runner.command("interactive-install", { ...binding(next), ...nextSelection }, privateFrame(next, context, nextPermit)),
        { type: "interactive-permit-installed", ...binding(next), ...nextSelection });
      assert.deepEqual(await runner.command("interactive-close", binding(next)), { type: "interactive-closed", ...binding(next) });
      assert.deepEqual(await runner.exited, [0, null]);
      assert.deepEqual(runner.output, []);
      for (const permit of [firstPermit, nextPermit]) assert.equal(JSON.stringify(runner.records).includes(permit.cookie), false);
    } finally { await runner.close(); }
  });

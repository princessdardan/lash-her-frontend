import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseP2OwnerSuspensionResponse, parseP2PlaybackObservation, validateP2LifecycleBrowserInput } from "./p2-lifecycle-browser-recorder.mjs";
import { qualifyP2SuspensionPending, P2_LIFECYCLE_PENDING_SQL } from "./p2-lifecycle-pending-probe.mjs";
import { launchP2LifecycleBrowserRecorder, validateP2SuspensionBrowserRecord, prepareP2LifecycleSuspensionPlan, readP2LifecycleBrowserSourceArtifact } from "./p2-lifecycle-suspension-evidence.mjs";
import { nativeSourceCommit } from "./harness/p2-native-unit-fixture.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { prepareP2LifecyclePersistencePlan, p2LifecyclePersistenceTargetSha256 } from "./p2-lifecycle-persistence-probe.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";

const at = "2026-11-06T12:00:00.000Z", userId = randomUUID(), commandId = randomUUID(), adminId = randomUUID();
const headers = { "cache-control": "private, no-store", "x-request-id": randomUUID(), date: at };
function input() { return { version: 1, environment: "staging", actionId: "owned-browser", challenge: "a".repeat(64), bindingSha256: "b".repeat(64),
  sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app", userId, courseId: randomUUID(), lessonId: randomUUID(), windowSeconds: 840 }; }
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
    bindingSha256: selected.bindingSha256, sourceCommit: selected.sourceCommit, deploymentId: selected.deploymentId, deploymentUrl: selected.deploymentUrl,
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

test("fixed browser input has no injection, storage, clock, credential, URL or command hook", () => {
  validateP2LifecycleBrowserInput(input());
  for (const change of [row => { row.context = {}; }, row => { row.storageState = {}; }, row => { row.deploymentUrl = "http://localhost:3000"; },
    row => { row.windowSeconds = 60; }, row => { row.environment = "production"; }, row => { row.commandId = commandId; }]) {
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

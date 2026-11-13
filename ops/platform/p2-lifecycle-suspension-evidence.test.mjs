import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ownedCheckoutCommit } from "./harness/p2-native-unit-fixture.mjs";
import { expireP2InteractiveBrowserCookie, installP2InteractiveBrowserCookie, installP2PaidArchiveObserver, installP2PaidRevokeObserver, observeP2InteractiveIdentitySession,
  p2AuthoringCurriculumPath, p2AuthoringPublicationPaths, p2AuthoringQuizPath, p2AuthoringReorderPath,
  p2InteractiveBrowserEntryPath, p2InteractiveBrowserPath, p2LearningEnrollmentPaths, p2LifecycleMutationTarget, p2PaidGrantPaths,
  p2LessonEntryPaths, p2PaidLearnerAccessPaths, p2PaidRevokePaths, parseP2OwnerSuspensionResponse,
  parseP2PlaybackObservation, readP2InteractiveBrowserPermit, validateP2InteractiveBrowserInput, validateP2InteractiveBrowserPermit,
  validateP2AuthoringEditResponses, validateP2AuthoringMutationReceipt, validateP2AuthoringReorderResponses,
  validateP2InteractiveIdentityReceipt, validateP2LearningEnrollmentReceipt, validateP2LessonEntryReceipt, validateP2LifecycleBrowserInput,
  validateP2LifecycleMutationReceipt, validateP2PaidGrantReceipt, validateP2PaidLearnerAccessReceipt, validateP2PaidRevokeReceipt, watchP2AuthoringEdits,
  watchP2AuthoringMutation, watchP2LearningEnrollment, watchP2LessonEntry, watchP2LifecycleMutation, watchP2PaidGrant, watchP2PaidLearnerAccess,
  watchP2PaidRevoke } from "./p2-lifecycle-browser-recorder.mjs";
import { qualifyP2SuspensionPending, P2_LIFECYCLE_PENDING_SQL } from "./p2-lifecycle-pending-probe.mjs";
import { launchP2InteractiveBrowserRecorder, launchP2LifecycleBrowserRecorder, validateP2SuspensionBrowserRecord, prepareP2LifecycleSuspensionPlan, readP2LifecycleBrowserSourceArtifact, P2_LIFECYCLE_BROWSER_LAUNCHER } from "./p2-lifecycle-suspension-evidence.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { prepareP2LifecyclePersistencePlan, p2LifecyclePersistenceTargetSha256 } from "./p2-lifecycle-persistence-probe.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as current } from "./qualification-target-profile.mjs";
import { P2_FIRST_OWNER_PATH, p2FirstOwnerDiscoveryEmailSha256, p2FirstOwnerIdentitySha256 } from "./p2-first-owner-identity.mjs";

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
  const operatorSourceCommit = ownedCheckoutCommit();
  const raw = { version: 1, environment: "staging", releaseId: "owned-browser-release", hostMachineId: "1".repeat(32), candidateSha256: "1".repeat(64),
    configurationSha256: "2".repeat(64), sources: { frontend: operatorSourceCommit, course: "2".repeat(40), community: "3".repeat(40) },
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
  const child = spawn(process.execPath, ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH } });
  const messages = []; let output = "";
  child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; }); child.on("message", value => messages.push(value));
  child.stdin.end(bytes);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const exited = new Promise((done, fail) => { child.once("error", fail); child.once("exit", code => done(code)); });
    child.send({ type: "initialize", input: { privateMarker: "OWNED-PRIVATE-MARKER" } });
    assert.equal(await exited, 1); assert.deepEqual(messages, [{ type: "failed" }]); assert.equal(output, "");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
});

function interactiveInput(overrides = {}) {
  const value = { version: 2, environment: "staging", actionId: "owned-interactive", challenge: "b".repeat(64), bindingSha256: "c".repeat(64),
    sourceCommit: "1".repeat(40), deploymentId: "dpl_ownedBrowser", deploymentUrl: "https://owned-browser.vercel.app",
    browserOrigin: "https://staging.lashher.com", stage: "identity", epoch: "9", windowSeconds: 120, ...overrides };
  if (value.stage === "lifecycle" && !Object.hasOwn(value, "lifecycle")) {
    value.lifecycle = p2LifecycleMutationTarget({ actorKind: "admin", userId, operation: "suspend" });
  }
  if (value.stage === "identity" && !Object.hasOwn(value, "identity") && !Object.hasOwn(value, "identityEnrollment") &&
    !Object.hasOwn(value, "firstOwner") && !Object.hasOwn(value, "firstOwnerDiscovery")) {
    value.identity = { actorKind: "admin", actorId: adminId };
  }
  return value;
}
const identityHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownedDraft = { title: "Owned draft title", slug: "owned-draft", description: "Owned draft text", introduction: null,
  currency: "CAD", accessMode: "free", priceCents: 0, cover: null, seo: { noIndex: false }, taxClassification: null, status: "draft" };
const ownedAuthoring = { actorId: adminId, slug: ownedDraft.slug, bodySha256: identityHash(ownedDraft) };
const authoringSelector = actorId => "7032712d617574686f72696e672d7631" + actorId.replaceAll("-", "");
const authoringEditSelector = actorId => "7032712d617574682d656469742d7631" + actorId.replaceAll("-", "");
const authoringReorderSelector = actorId => "7032712d617574682d736f72742d7631" + actorId.replaceAll("-", "");
const authoringCurriculumSelector = actorId => "7032712d617574682d6e65772d763100" + actorId.replaceAll("-", "");
const authoringPublicationSelector = (actorId, outcome) => (outcome === "published" ? "7032712d617574682d7075622d763100"
  : "7032712d617574682d7264792d763100") + actorId.replaceAll("-", "");
const authoringQuizSelector = actorId => "7032712d617574682d7175697a2d7631" + actorId.replaceAll("-", "");
const authoringArchiveSelector = actorId => "7032712d617574682d6172632d763100" + actorId.replaceAll("-", "");
const ownedCourseId = randomUUID();
const ownedDraftResponse = { course: { ...ownedDraft, id: ownedCourseId, revision: 1, modules: [] } };
const { status: ownedDraftStatus, ...ownedEditFields } = ownedDraft;
const ownedWinner = { ...ownedEditFields, title: "Owned winner title", expectedRevision: 4 };
const ownedStale = { ...ownedEditFields, title: "Owned unsaved stale title", expectedRevision: 4 };
const ownedAuthoringEdit = { actorId: adminId, operation: "edit-and-stale-draft", courseId: ownedCourseId, slug: ownedDraft.slug, revision: 4,
  winnerBodySha256: identityHash(ownedWinner), staleBodySha256: identityHash(ownedStale) };
const customerIdentitySelector = "7032712d637573746f6d65722d763100" + userId.replaceAll("-", "");
const enrollmentEmail = "owned-new-customer@example.invalid", enrollmentId = randomUUID();
function ownedEnrollment(provider) {
  const nonce = "9".repeat(32);
  return { provider, nonce, emailSha256: identityHash(["p2q-customer-enrollment-v1", provider, nonce, enrollmentEmail]) };
}
function interactivePermit(input) {
  const issued = Math.floor(Date.now() / 1000), expires = issued + 60;
  const enrollment = input.identityEnrollment;
  const firstOwner = input.firstOwner;
  const firstOwnerDiscovery = input.firstOwnerDiscovery;
  let selector = input.stage === "lifecycle" ? "4".repeat(64) : undefined;
  if (firstOwner) selector = "a3" + firstOwner.identitySha256.slice(0, 62);
  else if (firstOwnerDiscovery) selector = "a4" + firstOwnerDiscovery.emailSha256.slice(0, 62);
  else if (enrollment) selector = (enrollment.provider === "google" ? "a1" : "a2") + enrollment.emailSha256.slice(0, 62);
  else if (input.stage === "identity") selector = input.identity.actorKind === "admin" ? identityHash(["identity", "admin"])
    : "7032712d637573746f6d65722d763100" + input.identity.actorId.replaceAll("-", "");
  else if (input.stage === "learning") selector = (input.learning.actorId + input.learning.idempotencyKey).replaceAll("-", "");
  else if (input.stage === "learner-access") selector = (input.learnerAccess.actorId + input.learnerAccess.lessonId).replaceAll("-", "");
  else if (input.stage === "lesson-entry") selector = (input.lessonEntry.actorId + input.lessonEntry.courseId + input.lessonEntry.lessonId).replaceAll("-", "");
  else if (input.stage === "paid-grant") selector = (input.paidGrant.actorId + input.paidGrant.idempotencyKey).replaceAll("-", "");
  else if (input.stage === "paid-revoke") selector = (input.paidRevoke.actorId + input.paidRevoke.idempotencyKey).replaceAll("-", "");
  else if (input.authoring?.operation === "save-quiz-revision") selector = authoringQuizSelector(input.authoring.actorId);
  else if (input.authoring?.operation === "archive-paid-course") selector = authoringArchiveSelector(input.authoring.actorId);
  else if (input.authoring?.operation === "republish-paid-course") selector = republishSelector(input.authoring.actorId, input.authoring.outcome);
  else if (input.stage === "authoring") selector = input.authoring.operation === "edit-and-stale-draft"
    ? authoringEditSelector(input.authoring.actorId) : input.authoring.operation === "reorder-and-stale-curriculum"
      ? authoringReorderSelector(input.authoring.actorId) : input.authoring.operation === "create-curriculum"
        ? authoringCurriculumSelector(input.authoring.actorId) : input.authoring.operation === "qualify-publication"
          ? authoringPublicationSelector(input.authoring.actorId, input.authoring.outcome) : authoringSelector(input.authoring.actorId);
  const cookie = [selector ? "v2" : "v1", input.epoch, input.stage, issued, expires,
    firstOwner?.nonce ?? firstOwnerDiscovery?.nonce ?? enrollment?.nonce ?? "3".repeat(32),
    ...(selector ? [selector] : []), "5".repeat(64)].join(".");
  return { stage: input.stage, epoch: input.epoch, expires, cookie };
}
const binding = input => ({ challenge: input.challenge, bindingSha256: input.bindingSha256, stage: input.stage, epoch: input.epoch });
const privateFrame = (input, context, permit) => Buffer.from(JSON.stringify({
  challenge: input.challenge, bindingSha256: input.bindingSha256, context, permit,
}) + "\n");

function ownedLearning() {
  const target = { actorId: userId, operation: "enroll-free-course", courseId: ownedCourseId, slug: ownedDraft.slug, idempotencyKey: randomUUID() };
  const input = interactiveInput({ stage: "learning", learning: target });
  const paths = p2LearningEnrollmentPaths(target);
  const body = { courseId: target.courseId, grantId: randomUUID(), enrollmentId: randomUUID(), source: "free", status: "active", idempotentReplay: false };
  const receipt = { method: "POST", pathname: paths.pathname, status: 200, requestId: randomUUID(), academyPath: paths.academyPath, body };
  return { target, input, receipt, ...paths };
}

function ownedLearningReplay() {
  const fresh = ownedLearning();
  const { grantId, enrollmentId } = fresh.receipt.body;
  const target = { ...fresh.target, operation: "replay-free-enrollment",
    prior: { grantId, enrollmentId, eventId: randomUUID(), streamId: randomUUID(), canonicalDigest: "a".repeat(64) } };
  const input = { ...fresh.input, learning: target };
  const receipt = { ...fresh.receipt, body: { ...fresh.receipt.body, idempotentReplay: true } };
  return { ...fresh, target, input, receipt };
}

test("learning enrollment input, v2 permit and compact receipt bind exact learner and course", () => {
  const { input, target, receipt, coursePath } = ownedLearning(), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), coursePath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  const [version, epoch, stage, issued, expires, nonce, selector, mac] = permit.cookie.split(".");
  assert.equal(version, "v2");
  assert.equal(selector, (target.actorId + target.idempotencyKey).replaceAll("-", ""));
  for (const change of [{ actorId: randomUUID() }, { idempotencyKey: randomUUID() }]) {
    const other = { ...input, learning: { ...target, ...change } };
    assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit(other), input));
  }
  const legacy = ["v1", epoch, stage, issued, expires, nonce, mac].join(".");
  assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: legacy }, input));
  for (const change of [{ slug: "different?x=1" }, { courseId: "invalid" }, { operation: "other" }, { body: "unexpected" }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, learning: { ...target, ...change } }));
  }
  assert.deepEqual(validateP2LearningEnrollmentReceipt(receipt, target), receipt);
  assert.throws(() => validateP2LearningEnrollmentReceipt({ ...receipt, academyPath: "/academy" }, target));
  for (const body of [{ courseId: randomUUID() }, { source: "paid" }, { status: "revoked" }, { enrollmentId: null }, { idempotentReplay: true },
    { idempotencyKey: target.idempotencyKey }]) {
    assert.throws(() => validateP2LearningEnrollmentReceipt({ ...receipt, body: { ...receipt.body, ...body } }, target));
  }
});

test("free-enrollment replay permit, entry and receipt bind the original grant and enrollment", () => {
  const { input, target, receipt, academyPath } = ownedLearningReplay(), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), academyPath);
  assert.deepEqual(validateP2LearningEnrollmentReceipt(receipt, target), receipt);
  const differentActor = { ...input, learning: { ...target, actorId: randomUUID() } };
  assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit(differentActor), input));
  for (const prior of [undefined, { ...target.prior, eventId: "wrong" }, { ...target.prior, streamId: "wrong" },
    { ...target.prior, canonicalDigest: "0".repeat(64) }, { ...target.prior, other: true }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, learning: { ...target, prior } }));
  }
  for (const change of [{ grantId: randomUUID() }, { enrollmentId: randomUUID() }, { courseId: randomUUID() },
    { idempotentReplay: false }, { idempotencyKey: target.idempotencyKey }, { source: "paid" }]) {
    assert.throws(() => validateP2LearningEnrollmentReceipt({ ...receipt, body: { ...receipt.body, ...change } }, target));
  }
});

function ownedPaidGrant() {
  const reason = "Private owner support reason", grantId = randomUUID(), commandId = randomUUID();
  const target = { actorId: adminId, operation: "grant-paid-access", courseId: ownedCourseId, userId, revision: 4, idempotencyKey: randomUUID(),
    reasonSha256: createHash("sha256").update(reason).digest("hex") };
  const input = interactiveInput({ stage: "paid-grant", paidGrant: target }), { pathname, pagePath } = p2PaidGrantPaths(target);
  const submitted = { userId, reason: ` ${reason} `, expectedCourseRevision: target.revision, idempotencyKey: target.idempotencyKey };
  const grant = { grantId, userId, courseId: target.courseId, status: "active", grantReason: "manual", orderId: null, externalPaymentId: null, provider: null };
  const command = { commandId, action: "grant", scope: "userCourse", outcome: "applied", actorUserId: target.actorId, userId, courseId: target.courseId,
    targetGrantId: null, reason: `[paid-course revision ${target.revision}] ${reason}`, effectiveAt: at, affectedGrantCount: 1,
    effects: [{ grantId, effectType: "grant_created", previousStatus: null, resultingStatus: "active" }], createdAt: at,
    idempotencyKey: "owner-paid:" + target.idempotencyKey };
  const response = { state: "confirmed", idempotencyKey: target.idempotencyKey, command, grant, courseRevision: target.revision,
    mutationRetried: false, communityDeliveryVerified: false };
  const receipt = { method: "POST", pathname, status: 200, requestId: randomUUID(),
    body: { courseId: target.courseId, userId, commandId, grantId, courseRevision: target.revision } };
  return { target, input, pagePath, pathname, submitted, response, receipt };
}

function ownedPaidRevoke() {
  const reason = "Private approved revocation reason", grantId = randomUUID(), commandId = randomUUID();
  const target = { actorId: adminId, operation: "revoke-paid-grant", courseId: ownedCourseId, userId, grantId, revision: 4, idempotencyKey: randomUUID(),
    reasonSha256: createHash("sha256").update(reason).digest("hex"), remainingAccess: false };
  const input = interactiveInput({ stage: "paid-revoke", paidRevoke: target }), { pathname, pagePath } = p2PaidRevokePaths(target);
  const submitted = { userId, grantId, expectedCourseRevision: target.revision, reason: ` ${reason} `, idempotencyKey: target.idempotencyKey };
  const grant = { grantId, userId, courseId: target.courseId, status: "revoked", orderId: null, externalPaymentId: null, provider: null };
  const response = { state: "confirmed", idempotencyKey: target.idempotencyKey, command: { commandId }, grant, courseRevision: target.revision,
    mutationRetried: false, communityDeliveryVerified: false };
  const receipt = { method: "POST", pathname, status: 200, requestId: randomUUID(), body: { courseId: target.courseId, userId, grantId, commandId,
    courseRevision: target.revision } };
  return { target, input, pagePath, pathname, submitted, response, receipt };
}

test("paid revocation permit and compact receipt bind the exact owner, attempt and selected grant", () => {
  const { input, target, receipt, pagePath } = ownedPaidRevoke(), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), pagePath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "learner"));
  assert.equal(permit.cookie.split(".")[6], (target.actorId + target.idempotencyKey).replaceAll("-", ""));
  for (const change of [{ actorId: randomUUID() }, { idempotencyKey: randomUUID() }]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit({ ...input, paidRevoke: { ...target, ...change } }), input));
  }
  for (const change of [{ grantId: "other" }, { revision: 2_147_483_648 }, { remainingAccess: "false" }, { reason: "Private" }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, paidRevoke: { ...target, ...change } }));
  }
  assert.deepEqual(validateP2PaidRevokeReceipt(receipt, target), receipt);
  for (const change of [{ grantId: randomUUID() }, { courseRevision: target.revision + 1 }, { remainingAccess: false }, { reason: "Private" }]) {
    assert.throws(() => validateP2PaidRevokeReceipt({ ...receipt, body: { ...receipt.body, ...change } }, target));
  }
});

const ownedAccessOutcomes = {
  allowed: { status: 200, code: null }, archived: { status: 410, code: "course_archived", heading: "This course is archived", message: "This course is archived." },
  draft: { status: 404, code: "not_found", heading: "This course is unavailable", message: "This resource is unavailable." },
  restricted: { status: 403, code: "access_revoked", heading: "Course access has ended", message: "Course access has been revoked." },
};

function ownedPaidLearnerAccess(outcome) {
  const target = { actorId: userId, operation: "observe-paid-access", courseId: ownedCourseId, lessonId: randomUUID(), grantId: randomUUID(), revision: 4, outcome };
  const input = interactiveInput({ stage: "learner-access", learnerAccess: target });
  const paths = p2PaidLearnerAccessPaths(target), { status, code } = ownedAccessOutcomes[outcome];
  const receipt = { page: { pathname: paths.pagePath, status: 200, lessonLink: outcome === "allowed" },
    reads: paths.targets.map(target => ({ target, status, requestId: randomUUID(), code })),
    body: { courseId: target.courseId, lessonId: target.lessonId, outcome } };
  return { target, input, receipt, ...paths };
}

test("paid learner access permit and compact receipt bind the customer, lesson and six exact outcomes", () => {
  for (const outcome of Object.keys(ownedAccessOutcomes)) {
    const { input, target, receipt, pagePath, targets } = ownedPaidLearnerAccess(outcome), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(permit.cookie.split(".")[6], (target.actorId + target.lessonId).replaceAll("-", ""));
    assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), pagePath);
    assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
    const lesson = `/api/academy/lessons/${target.lessonId}`;
    assert.deepEqual(targets, [`/api/academy/courses/${target.courseId}`, lesson, `${lesson}/playback`,
      `/api/academy/progress?lessonId=${target.lessonId}`, `${lesson}/quiz`, `${lesson}/quiz/attempts`]);
    for (const change of [{ actorId: randomUUID() }, { lessonId: randomUUID() }])
      assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit({ ...input, learnerAccess: { ...target, ...change } }), input));
    for (const change of [{ grantId: "other" }, { revision: 0 }, { revision: 2_147_483_648 }, { outcome: "other" }])
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, learnerAccess: { ...target, ...change } }));
    assert.deepEqual(validateP2PaidLearnerAccessReceipt(receipt, target), receipt);
    for (const change of [{ target: pagePath }, { status: 401 }, { code: "forbidden" }, { requestId: receipt.reads[1].requestId }, { token: "private" }])
      assert.throws(() => validateP2PaidLearnerAccessReceipt({ ...receipt, reads: [{ ...receipt.reads[0], ...change }, ...receipt.reads.slice(1)] }, target));
  }
});

test("paid-grant v2 permit and compact receipt bind exact owner, key, course and customer", () => {
  const { target, input, pagePath, receipt } = ownedPaidGrant(), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), pagePath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "learner"));
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  const parts = permit.cookie.split(".");
  assert.equal(parts[6], (target.actorId + target.idempotencyKey).replaceAll("-", ""));
  for (const change of [{ actorId: randomUUID() }, { idempotencyKey: randomUUID() }]) {
    assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit({ ...input, paidGrant: { ...target, ...change } }), input));
  }
  parts[0] = "v1";
  parts.splice(6, 1);
  assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
  assert.doesNotThrow(() => validateP2InteractiveBrowserInput({ ...input, paidGrant: { ...target, revision: 2_147_483_647 } }));
  for (const change of [{ revision: 2_147_483_648 }, { userId: "unknown" }, { reasonSha256: "unknown" }, { reason: "Private" }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, paidGrant: { ...target, ...change } }));
  }
  assert.deepEqual(validateP2PaidGrantReceipt(receipt, target), receipt);
  for (const change of [{ userId: randomUUID() }, { courseId: randomUUID() }, { courseRevision: target.revision + 1 }, { reason: "Private" }]) {
    assert.throws(() => validateP2PaidGrantReceipt({ ...receipt, body: { ...receipt.body, ...change } }, target));
  }
});

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

const mediaControllerHarness = String.raw`
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
const { controllerUrl, behavior } = JSON.parse(readFileSync(0));
const root = new URL("../../", controllerUrl);
const sourceCommit = "1".repeat(40), actorId = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222", lessonId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444", readId = "55555555-5555-4555-8555-555555555555";
const postId = "66666666-6666-4666-8666-666666666666", fileSha256 = "e".repeat(64);
const joined = behavior !== "reserve", stage = "media", context = "owner", expires = Math.floor(Date.now()/1000)+60;
const dispatch = { intentSha256: "d".repeat(64), expiresAt: expires-1 }, armed = {};
const selected = { operation: joined ? "upload-video-and-observe-callback" : "reserve-video-upload", courseId, lessonId,
  revision: 11, currentVideoAssetId: null, fileSha256, fileBytes: 120, contentType: "video/mp4" };
const reservation = { page: { pathname: "/admin/courses/"+courseId, status: 200 },
  read: { requestId: readId, courseRevision: 11, currentVideoAssetId: null },
  reservation: { requestId: postId, status: 200, assetId, lessonId, uploadId: "owned-upload", uploadTimeoutSeconds: 3600, assetStatus: "uploading" },
  outbound: { intercepted: true, sent: false, fileSha256, fileBytes: 120, contentType: "video/mp4" } };
const identityActor = { actorKind: "admin", actorId };
const common = { version: 2, mode: "interactive-browser", maximumSeconds: 300, sourceCommit, operatorSourceCommit: sourceCommit,
  nativePlan: { deploymentId: "dpl_owned", deploymentUrl: "https://owned.vercel.app" } };
const identityPlan = { ...common, certificationActionId: "owned-identity", planSha256: "a".repeat(64), initialEpoch: "7",
  scopedAction: { stage: "identity", windowSeconds: 120, identityActor } };
const mediaPlan = { ...common, certificationActionId: "owned-media", planSha256: "b".repeat(64), initialEpoch: "9",
  scopedAction: { stage, windowSeconds: 120, actorId, mediaAction: selected } };
const binding = ({ challenge, bindingSha256, stage, epoch }) => ({ challenge, bindingSha256, stage, epoch });
const expectedCommands = [], child = new EventEmitter();
const stdin = new PassThrough(), permitPipe = new PassThrough();
stdin.resume();permitPipe.resume();
let controller, selectedInput, taken = 0;
child.stdin=stdin;child.stdio=[stdin,null,null,null,permitPipe];child.connected=true;
const end = (code, signal) => { if(child.connected){child.connected=false;child.emit("close",code,signal);} };
child.kill = signal => { queueMicrotask(() => end(1,signal)); return true; };
child.send = ({ type, input }, callback) => {
  expectedCommands.push(type);
  let message = { ...binding(input) };
  switch(type){
    case "initialize-interactive":selectedInput=input;message.type="interactive-initialized";break;
    case "interactive-install":Object.assign(message,{type:"interactive-permit-installed",context,expires});break;
    case "interactive-open":Object.assign(message,{type:"interactive-page-opened",context,expires,
      path:selectedInput.stage==="identity"?"/admin/sign-in":reservation.page.pathname,httpStatus:200});break;
    case "interactive-capture-identity":Object.assign(message,{type:"interactive-identity-captured",context,expires,
      identity:{...identityActor,sessionVerified:true}});break;
    case "interactive-select":selectedInput=input.next;message={type:"interactive-selected",...binding(selectedInput)};break;
    case "interactive-capture-media":Object.assign(message,{type:"interactive-media-captured",context,expires,response:reservation});break;
    case "interactive-dispatch-media":
      assert.deepEqual(input,{...binding(selectedInput),context,expires,dispatch});
      Object.assign(message,{type:"interactive-media-dispatched",context,expires,response:{attempted:true,status:204,
        ...(behavior==="secret-reply"?{url:"fixture-private-field"}:{})}});break;
    case "interactive-close":message.type="interactive-closed";break;
    default:assert.fail(type);
  }
  queueMicrotask(()=>{callback(null);child.emit("message",message);if(type==="interactive-close")queueMicrotask(()=>end(0,null));});
};
const { default: defaultChild, spawn: _spawn, execFileSync: _exec, ...childExports } = childProcess;
const spawn = () => child, execFileSync = (program,args) => {
  assert.equal(program,"git");
  if(args.includes("rev-parse"))return sourceCommit+"\n";
  assert.ok(args.includes("show")&&args.at(-1).startsWith(sourceCommit+":"));
  return readFileSync(new URL(args.at(-1).slice(41),root));
};
mock.module("node:child_process",{exports:{...childExports,spawn,execFileSync,default:{...defaultChild,spawn,execFileSync}}});
mock.module(new URL("./p2-certification.mjs",controllerUrl).href,{exports:{p2CertificationParentContext(plan){assert.ok(plan===identityPlan||plan===mediaPlan);}}});
mock.module(new URL("./p2-certification-transport.mjs",controllerUrl).href,{exports:{takeP2InteractiveMediaDispatch(plan,actual,receipt){
  assert.equal(plan,mediaPlan);assert.equal(actual,controller);assert.equal(receipt,armed);assert.equal(++taken,1);return dispatch;
}}});
const {launchP2InteractiveBrowserRecorder,requireP2InteractiveBrowserMediaEvidence}=await import(controllerUrl);
const permit = (stage,epoch,selector) => ({stage,epoch,expires,cookie:["v2",epoch,stage,expires-60,expires,"a".repeat(32),selector,"b".repeat(64)].join(".")});
const adminSelector=createHash("sha256").update(JSON.stringify(["identity","admin"])).digest("hex");
controller=await launchP2InteractiveBrowserRecorder(identityPlan);
try{
  await controller.initialized();
  await controller.installPermit(permit("identity","8",adminSelector),context);
  await controller.open(context);
  await controller.captureIdentity(context,"f".repeat(64));
  await controller.selectPlan(mediaPlan,"/owned-private-fixture.mp4");
  await controller.installPermit(permit(stage,"10",(actorId+courseId+lessonId).replaceAll("-","")),context);
  await controller.open(context);
  await assert.rejects(controller.dispatchMedia(context,armed));
  const held=await controller.captureMediaReservation(context);
  assert.deepEqual(held,reservation);
  if(joined){
    requireP2InteractiveBrowserMediaEvidence(mediaPlan,controller,held);
    assert.throws(()=>requireP2InteractiveBrowserMediaEvidence(mediaPlan,controller,{...held}));
    if(behavior==="secret-reply"){
      await assert.rejects(controller.dispatchMedia(context,armed),{message:"P2_INTERACTIVE_BROWSER_CHILD_FAILED"});
    }else{
      const response=await controller.dispatchMedia(context,armed);
      assert.deepEqual(response,{attempted:true,status:204});
      requireP2InteractiveBrowserMediaEvidence(mediaPlan,controller,held,{response,intentSha256:dispatch.intentSha256});
      assert.throws(()=>requireP2InteractiveBrowserMediaEvidence(mediaPlan,controller,held,{response:{...response},intentSha256:dispatch.intentSha256}));
      await assert.rejects(controller.dispatchMedia(context,armed));
    }
  }else{
    await assert.rejects(controller.dispatchMedia(context,armed));
    assert.throws(()=>requireP2InteractiveBrowserMediaEvidence(mediaPlan,controller,held));
  }
}finally{
  assert.deepEqual(await controller.close(),{childClosed:true,browserCleanupAcknowledged:behavior!=="secret-reply"});
}
assert.equal(taken,Number(joined));
assert.equal(expectedCommands.filter(type=>type==="interactive-dispatch-media").length,Number(joined));
`;

test("media controller holds one joined upload for exact source dispatch and refuses unexpected child fields", () => {
  const controllerUrl = new URL("./p2-lifecycle-suspension-evidence.mjs", import.meta.url).href;
  for (const behavior of ["joined", "reserve", "secret-reply"]) {
    const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", mediaControllerHarness], {
      input: JSON.stringify({ controllerUrl, behavior }), encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
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
  const child = spawn(process.execPath, ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe", "ipc", "pipe"],
    env: Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  const records = [], output = [];
  child.on("message", value => records.push(value));
  child.stdout.on("data", value => output.push(value));
  child.stderr.on("data", value => output.push(value));
  child.stdin.end(bytes);
  const exited = once(child, "close");
  const command = (type, input, frame) => {
    const response = once(child, "message");
    child.send({ type, input });
    if (frame) child.stdio[4].write(frame);
    return Promise.race([response.then(([receipt]) => receipt), exited.then(() => { throw new Error("OWNED_INTERACTIVE_CHILD_EXITED"); })]);
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const close = async () => { clearTimeout(timer); if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL"); await exited; };
  return { child, records, output, exited, command, close };
}

test("authoring input and receipt bind the selected draft slug, revision and canonical course ID", () => {
  const input = interactiveInput({ stage: "authoring", authoring: ownedAuthoring });
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  const permit = interactivePermit(input), parts = permit.cookie.split(".");
  assert.equal(parts[6], authoringSelector(adminId));
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit({ ...input, authoring: { ...ownedAuthoring, actorId: randomUUID() } }), input));
  parts[0] = "v1";
  parts.splice(6, 1);
  assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
  assert.equal(p2InteractiveBrowserPath("authoring", "owner"), "/admin/courses");
  assert.throws(() => p2InteractiveBrowserPath("authoring", "learner"));
  for (const authoring of [{ ...ownedAuthoring, slug: "Unreviewed" }, { ...ownedAuthoring, bodySha256: "0" },
    { ...ownedAuthoring, actorId: "wrong-id" }, { ...ownedAuthoring, title: "Extra" }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring }));
  }
  const receipt = { method: "POST", pathname: "/api/admin/courses", status: 200, requestId: randomUUID(),
    body: { courseId: ownedCourseId, slug: ownedDraft.slug, revision: 1, status: "draft" } };
  assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, ownedAuthoring), receipt);
  for (const change of [{ slug: "foreign-draft" }, { revision: 2 }, { status: "published" }, { courseId: "wrong-id" }, { title: "Private" }]) {
    assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, body: { ...receipt.body, ...change } }, ownedAuthoring));
  }
});

test("edit authoring permit and paired receipt bind owner, course, revision and the distinct selected actions", () => {
  const input = interactiveInput({ stage: "authoring", authoring: ownedAuthoringEdit });
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), "/admin/courses/" + ownedCourseId);
  const permit = interactivePermit(input), parts = permit.cookie.split(".");
  assert.equal(parts[6], authoringEditSelector(adminId));
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  for (const selector of [authoringSelector(adminId), authoringEditSelector(randomUUID())]) {
    const altered = parts.slice(); altered[6] = selector;
    assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: altered.join(".") }, input));
  }
  for (const change of [{ revision: 0 }, { courseId: "bad" }, { staleBodySha256: ownedAuthoringEdit.winnerBodySha256 },
    { bodySha256: "a".repeat(64) }]) {
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...ownedAuthoringEdit, ...change } }));
  }
  const pathname = "/api/admin/courses/" + ownedCourseId;
  const winner = { method: "PATCH", pathname, status: 200, requestId: randomUUID(),
    body: { courseId: ownedCourseId, slug: ownedDraft.slug, revision: 5, status: ownedDraftStatus } };
  const stale = { method: "PATCH", pathname, status: 409, requestId: randomUUID(), outcome: "conflict", dirtyInputPreserved: true };
  assert.deepEqual(validateP2AuthoringEditResponses({ winner, stale }, ownedAuthoringEdit), { winner, stale });
  for (const change of [{ requestId: winner.requestId }, { dirtyInputPreserved: false }, { outcome: "other" }, { body: { code: "conflict" } }]) {
    assert.throws(() => validateP2AuthoringEditResponses({ winner, stale: { ...stale, ...change } }, ownedAuthoringEdit));
  }
  assert.throws(() => validateP2AuthoringEditResponses({ winner: { ...winner, body: { ...winner.body, revision: 4 } }, stale }, ownedAuthoringEdit));
});

function ownedReorder(kind) {
  const parentId = kind === "module" ? ownedCourseId : randomUUID(), ids = Array.from({ length: 3 }, () => randomUUID());
  const [first, second, third] = ids;
  const winnerBody = { expectedCourseRevision: 4, ids: [second, first, third] }, staleBody = { expectedCourseRevision: 4, ids: [first, third, second] };
  const target = { actorId: adminId, operation: "reorder-and-stale-curriculum", courseId: ownedCourseId, slug: ownedDraft.slug, revision: 4,
    kind, parentId, winnerBodySha256: identityHash(winnerBody), staleBodySha256: identityHash(staleBody) };
  return { input: interactiveInput({ stage: "authoring", authoring: target }), target, winnerBody, staleBody };
}

test("reorder permit and paired browser receipt bind the selected parent, owner and keyboard evidence", () => {
  for (const kind of ["module", "lesson"]) {
    const { input, target, winnerBody } = ownedReorder(kind), permit = interactivePermit(input), pathname = p2AuthoringReorderPath(target);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(permit.cookie.split(".")[6], authoringReorderSelector(adminId));
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), "/admin/courses/" + ownedCourseId);
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, kind: "other" } }));
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, parentId: "invalid" } }));
    const parts = permit.cookie.split(".");
    for (const selector of [authoringSelector(adminId), authoringEditSelector(adminId), authoringReorderSelector(randomUUID())]) {
      parts[6] = selector;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
    }
    const winner = { method: "POST", pathname, status: 200, requestId: randomUUID(), keyboardActivated: true,
      body: { courseId: target.courseId, parentId: target.parentId, kind, revision: 5, ids: winnerBody.ids } };
    const stale = { method: "POST", pathname, status: 409, requestId: randomUUID(), keyboardActivated: true, outcome: "conflict" };
    assert.deepEqual(validateP2AuthoringReorderResponses({ winner, stale }, target), { winner, stale });
    assert.throws(() => validateP2AuthoringReorderResponses({ winner, stale: { ...stale, keyboardActivated: false } }, target));
    assert.throws(() => validateP2AuthoringReorderResponses({ winner, stale: { ...stale, controlLabel: "private" } }, target));
    assert.throws(() => validateP2AuthoringReorderResponses({ winner: { ...winner, body: { ...winner.body, ids: [winnerBody.ids[0], winnerBody.ids[0]] } }, stale }, target));
  }
});

function ownedCurriculum(kind, contentDocument = { version: 1, blocks: [] }) {
  const parentId = kind === "module" ? ownedCourseId : randomUUID(), childSlug = `owned-new-${kind}`;
  const fields = { expectedCourseRevision: 4, title: `Private ${kind} title`, slug: childSlug };
  const posted = kind === "module" ? { ...fields, description: "Private description", position: 2 }
    : { ...fields, position: 2, contentDocument, transcript: null, isPreview: false, captions: [] };
  const target = { actorId: adminId, operation: "create-curriculum", courseId: ownedCourseId, slug: ownedDraft.slug, revision: 4,
    kind, parentId, childSlug, bodySha256: identityHash(posted) };
  const itemId = randomUUID(), parentField = kind === "module" ? "courseId" : "moduleId";
  const item = { id: itemId, [parentField]: parentId, slug: childSlug, courseRevision: 5, title: posted.title, position: posted.position };
  return { input: interactiveInput({ stage: "authoring", authoring: target }), target, posted, item, parentField,
    response: { [kind]: item }, body: { courseId: ownedCourseId, parentId, kind, itemId, slug: childSlug, revision: 5 } };
}

test("curriculum create permit and compact receipt bind the owner, parent, child slug and revision", () => {
  for (const kind of ["module", "lesson"]) {
    const { input, target, body } = ownedCurriculum(kind), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(permit.cookie.split(".")[6], authoringCurriculumSelector(adminId));
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), `/admin/courses/${ownedCourseId}`);
    assert.throws(() => p2InteractiveBrowserEntryPath(input, "learner"));
    for (const variant of [{ childSlug: "BAD SLUG" }, { kind: "other" }, { revision: 0 }, { parentId: "other" }]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, ...variant } }));
    }
    const parts = permit.cookie.split(".");
    for (const selector of [authoringSelector(adminId), authoringReorderSelector(adminId), authoringCurriculumSelector(randomUUID())]) {
      parts[6] = selector;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
    }
    const receipt = { method: "POST", pathname: p2AuthoringCurriculumPath(target), status: 200, requestId: randomUUID(), body };
    assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, target), receipt);
    for (const variant of [{ slug: "other" }, { revision: 4 }, { parentId: randomUUID() }, { title: "Private" }]) {
      assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, body: { ...body, ...variant } }, target));
    }
  }
});

function ownedPublication(outcome) {
  const published = outcome === "published", courseId = ownedCourseId, revision = 4;
  const issueCodes = published ? [] : ["COURSE_MODULES_REQUIRED", "LESSON_CONTENT_REQUIRED"];
  const target = { actorId: adminId, operation: "qualify-publication", courseId, slug: ownedDraft.slug, revision, outcome, issueCodes };
  const { detail, readiness } = p2AuthoringPublicationPaths(target);
  const response = { courseId, courseRevision: revision, ready: published, issues: [...issueCodes, ...issueCodes].reverse()
    .map(code => ({ code, field: "contentDocument", message: "Private fixture detail", lessonId: randomUUID() })) };
  const body = { courseId, slug: target.slug, revision: revision + Number(published), status: published ? "published" : "draft", issueCodes };
  const receipt = { readiness: { method: "GET", pathname: readiness, status: 200, requestId: randomUUID() },
    ...(published ? { publication: { method: "PATCH", pathname: detail, status: 200, requestId: randomUUID() } } : {}), body };
  return { input: interactiveInput({ stage: "authoring", authoring: target }), target, detail, readiness, response, receipt };
}

const republishSelector = (actorId, outcome) => (outcome === "published" ? "7032712d617574682d7265702d763100" : "7032712d617574682d72626c2d763100")
  + actorId.replaceAll("-", "");

function ownedRepublish(outcome) {
  const fixture = ownedPublication(outcome);
  const target = { ...fixture.target, operation: "republish-paid-course", userId, grantId: randomUUID(), expectedAccess: outcome === "published" };
  const draft = { method: "PATCH", pathname: fixture.detail, status: 200, requestId: randomUUID() };
  const receipt = { draft, ...fixture.receipt, body: { ...fixture.receipt.body, revision: fixture.receipt.body.revision + 1 } };
  return { ...fixture, input: interactiveInput({ stage: "authoring", authoring: target }), target, receipt,
    response: { ...fixture.response, courseRevision: target.revision + 1 } };
}

test("paid republish permit and compact receipt bind both revisions and the reviewed outcome", () => {
  for (const outcome of ["blocked", "published"]) {
    const { input, target, receipt } = ownedRepublish(outcome), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), `/admin/courses/${ownedCourseId}`);
    const parts = permit.cookie.split(".");
    assert.equal(parts[6], republishSelector(adminId, outcome));
    for (const selector of [republishSelector(randomUUID(), outcome), republishSelector(adminId, outcome === "published" ? "blocked" : "published"),
      authoringPublicationSelector(adminId, outcome)]) {
      parts[6] = selector;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
    }
    for (const change of [{ revision: 2_147_483_646 }, { userId: "wrong" }, { grantId: "wrong" }, { expectedAccess: "true" },
      { issueCodes: ["B", "A"] }, { issueCodes: ["REPEATED", "REPEATED"] }]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, ...change } }));
    }
    assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, target), receipt);
    for (const change of [{ draft: { ...receipt.draft, requestId: receipt.readiness.requestId } },
      { body: { ...receipt.body, revision: target.revision } }, { body: { ...receipt.body, expectedAccess: target.expectedAccess } }]) {
      assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, ...change }, target));
    }
  }
});

function ownedQuiz(quizRevision) {
  const revision = 4, lessonId = randomUUID(), quizId = randomUUID();
  const options = [{ id: "option-4-1", text: "First private option" }, { id: "option-4-2", text: "Second private option" }];
  const question = { id: "question-4-1", prompt: "Private prompt", options, correctOptionId: options[0].id, feedback: "Private feedback" };
  const document = { version: 1, mode: "graded", passingPercent: 80, questions: [question] };
  const canonicalDocument = { mode: "graded", passingPercent: 80, questions: [{ correctOptionId: question.correctOptionId,
    feedback: question.feedback, id: question.id, options, prompt: question.prompt }], version: 1 };
  const posted = { expectedCourseRevision: revision, document };
  const target = { actorId: adminId, operation: "save-quiz-revision", courseId: ownedCourseId, slug: ownedDraft.slug,
    revision, lessonId, quizRevision, documentSha256: identityHash(canonicalDocument), bodySha256: identityHash(posted) };
  const saved = { id: quizId, lessonId, revision: quizRevision + 1, courseRevision: revision + 1,
    document: canonicalDocument, createdBy: adminId, createdAt: at };
  const prior = { ...saved, id: randomUUID(), revision: quizRevision, courseRevision: revision, createdBy: randomUUID() };
  const pathname = p2AuthoringQuizPath(target), input = interactiveInput({ stage: "authoring", authoring: target });
  const receipt = { prior: { method: "GET", pathname, status: quizRevision === 0 ? 404 : 200, requestId: randomUUID() },
    save: { method: "PUT", pathname, status: 200, requestId: randomUUID() },
    body: { courseId: target.courseId, slug: target.slug, lessonId, quizId, revision: revision + 1, quizRevision: quizRevision + 1,
      documentSha256: target.documentSha256 } };
  return { target, input, pathname, posted, prior, saved, receipt };
}

test("quiz save permit and compact receipt bind owner, lesson and both revisions", () => {
  for (const quizRevision of [0, 3]) {
    const { input, target, receipt } = ownedQuiz(quizRevision), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(permit.cookie.split(".")[6], authoringQuizSelector(adminId));
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), `/admin/courses/${ownedCourseId}`);
    const parts = permit.cookie.split(".");
    for (const selector of [authoringQuizSelector(randomUUID()), authoringPublicationSelector(adminId, "published"), authoringSelector(adminId)]) {
      parts[6] = selector;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
    }
    for (const variant of [{ quizRevision: -1 }, { revision: 0 }, { lessonId: "invalid" }, { documentSha256: "invalid" }]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, ...variant } }));
    }
    assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, target), receipt);
    for (const body of [{ ...receipt.body, documentSha256: "f".repeat(64) }, { ...receipt.body, quizRevision },
      { ...receipt.body, lessonId: randomUUID() }, { ...receipt.body, quizDocument: { private: true } }]) {
      assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, body }, target));
    }
    assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, prior: { ...receipt.prior, status: 403 } }, target));
  }
});

test("paid archive permit and compact receipt bind the owner and both dialog observations", () => {
  const target = {
    actorId: adminId, operation: "archive-paid-course", courseId: ownedCourseId, slug: ownedDraft.slug, revision: 4, userId,
    grantId: randomUUID(), bodySha256: identityHash({ expectedRevision: 4, status: "archived" }),
  };
  const input = interactiveInput({ stage: "authoring", authoring: target }), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), `/admin/courses/${ownedCourseId}`);
  const parts = permit.cookie.split(".");
  assert.equal(parts[6], authoringArchiveSelector(adminId));
  for (const selector of [authoringArchiveSelector(randomUUID()), authoringPublicationSelector(adminId, "published"), authoringSelector(adminId)]) {
    parts[6] = selector;
    assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
  }
  const body = { courseId: ownedCourseId, slug: target.slug, revision: target.revision + 1, status: "archived" };
  const receipt = { method: "PATCH", pathname: `/api/admin/courses/${ownedCourseId}`, status: 200, requestId: randomUUID(), body,
    warningObserved: true, cancelObservedWithoutMutation: true };
  assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, target), receipt);
  for (const changed of [{ warningObserved: false }, { cancelObservedWithoutMutation: false }, { method: "POST" },
    { body: { ...body, revision: target.revision } }, { body: { ...body, status: "published" } }])
    assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, ...changed }, target));
});

test("publication permit and receipt distinguish blocked and published outcomes", () => {
  for (const outcome of ["blocked", "published"]) {
    const { input, target, receipt } = ownedPublication(outcome), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), `/admin/courses/${ownedCourseId}`);
    const parts = permit.cookie.split(".");
    for (const selector of [authoringPublicationSelector(adminId, outcome === "published" ? "blocked" : "published"),
      authoringPublicationSelector(randomUUID(), outcome), authoringCurriculumSelector(adminId)]) {
      parts[6] = selector;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: parts.join(".") }, input));
    }
    for (const issueCodes of [["lowercase"], ["B", "A"], ["DUPLICATE", "DUPLICATE"], outcome === "published" ? ["NOT_EMPTY"] : []]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, issueCodes } }));
    }
    assert.deepEqual(validateP2AuthoringMutationReceipt(receipt, target), receipt);
    for (const change of [{ status: "archived" }, { revision: 0 }, { issueCodes: ["EXTRA_ISSUE"] }, { title: "Private" }]) {
      assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, body: { ...receipt.body, ...change } }, target));
    }
    const { publication, ...withoutPublication } = receipt;
    const wrongReceipt = publication ? withoutPublication : { ...receipt, publication: { ...receipt.readiness, method: "PATCH" } };
    assert.throws(() => validateP2AuthoringMutationReceipt(wrongReceipt, target));
  }
});

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

test("identity permit requires the reviewed actor family and the actual child refuses the other context", async () => {
  const input = interactiveInput(), permit = interactivePermit(input), runner = interactiveChild();
  const learner = interactiveInput({ identity: { actorKind: "customer", actorId: userId } });
  const customerPermit = interactivePermit(learner), parts = customerPermit.cookie.split(".");
  assert.equal(parts[6], customerIdentitySelector);
  assert.equal(validateP2InteractiveBrowserPermit(customerPermit, learner), customerPermit);
  const anotherCustomer = interactiveInput({ identity: { actorKind: "customer", actorId: randomUUID() } });
  assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit(anotherCustomer), learner));
  parts[6] = identityHash(["identity", "customer"]);
  assert.throws(() => validateP2InteractiveBrowserPermit({ ...customerPermit, cookie: parts.join(".") }, learner));
  assert.throws(() => validateP2InteractiveBrowserPermit(permit, learner));
  assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: permit.cookie.replace(/^v2/u, "v1") }, input));
  assert.throws(() => validateP2InteractiveBrowserInput(interactiveInput({ identity: { actorKind: "owner", actorId: adminId } })));
  try {
    assert.equal((await runner.command("initialize-interactive", input)).type, "interactive-initialized");
    assert.deepEqual(await runner.command("interactive-install", { ...binding(input), context: "learner", expires: permit.expires }), { type: "failed" });
    assert.deepEqual(await runner.exited, [1, null]);
    assert.deepEqual(runner.output, []);
  } finally { await runner.close(); }
});

test("first enrollment requires exactly the selected provider, nonce and selector shape", () => {
  for (const [provider, prefix] of [["google", "a1"], ["resend", "a2"]]) {
    const enrollment = ownedEnrollment(provider), input = interactiveInput({ identityEnrollment: enrollment }), permit = interactivePermit(input);
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    const parts = permit.cookie.split(".");
    assert.equal(parts[5], enrollment.nonce);
    assert.equal(parts[6], prefix + enrollment.emailSha256.slice(0, 62));
    for (const [index, replacement] of [[0, "v1"], [5, "0".repeat(32)], [6, (prefix === "a1" ? "a2" : "a1") + parts[6].slice(2)]]) {
      const altered = parts.slice(); altered[index] = replacement;
      assert.throws(() => validateP2InteractiveBrowserPermit({ ...permit, cookie: altered.join(".") }, input));
    }
    for (const change of [{ provider: "other" }, { nonce: "9".repeat(31) }, { emailSha256: "f".repeat(63) }, { email: enrollmentEmail }]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, identityEnrollment: { ...enrollment, ...change } }));
    }
    assert.throws(() => validateP2InteractiveBrowserInput({ ...input, identity: { actorKind: "customer", actorId: userId } }));
    assert.throws(() => validateP2InteractiveBrowserInput(interactiveInput({ stage: "learning", identityEnrollment: enrollment })));
    const receipt = { actorKind: "customer", actorId: enrollmentId, sessionVerified: true };
    assert.equal(validateP2InteractiveIdentityReceipt(receipt, input), receipt);
    for (const invalid of [{ actorKind: "admin" }, { actorId: "not-an-uuid" }, { email: enrollmentEmail }, { sessionVerified: false }]) {
      assert.throws(() => validateP2InteractiveIdentityReceipt({ ...receipt, ...invalid }, input));
    }
  }
});

const ownedGoogleSubject = "owned-private-google-subject";
function ownerSession(subject = ownedGoogleSubject, authenticatedAt = Math.floor(Date.now() / 1000)) {
  return { expires: new Date(Date.now() + 3_600_000).toISOString(),
    user: { providerUserId: subject, authenticatedAt, isEmailVerified: true, email: "owned-owner@example.invalid" } };
}
const customerSession = (id = userId, email = "owned-customer@example.invalid") => ({ expires: new Date(Date.now() + 3_600_000).toISOString(),
  user: { id, email, name: null, image: null } });
const ownerSubject = input => identityHash(["p2q-interactive-owner-v1", input.challenge, input.identity.actorId, ownedGoogleSubject]);

test("first-owner browser accepts only the scoped materialization receipt and its exact permit", async () => {
  const nonce = "9".repeat(32);
  const firstOwner = { nonce, identitySha256: p2FirstOwnerIdentitySha256(nonce, "owned-owner@example.invalid", ownedGoogleSubject) };
  const selected = interactiveInput({ firstOwner });
  validateP2InteractiveBrowserInput(selected);
  assert.throws(() => validateP2InteractiveBrowserInput({ ...selected, identity: { actorKind: "admin", actorId: adminId } }));
  assert.throws(() => validateP2InteractiveBrowserInput({ ...selected, firstOwner: { ...firstOwner, nonce: "0".repeat(32) } }));
  const permit = interactivePermit(selected);
  validateP2InteractiveBrowserPermit(permit, selected);
  assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...selected, firstOwner: { ...firstOwner, nonce: "8".repeat(32) } }));
  const body = { actorKind: "admin", actorId: adminId, sessionVerified: true };
  const observation = { context: "owner", openedAt: Date.now(), expires: permit.expires };
  const canonical = selected.browserOrigin + P2_FIRST_OWNER_PATH;
  let requests = 0;
  const page = (url, result) => ({
    url: () => url,
    request: { get: async requested => {
      requests++;
      assert.equal(requested, canonical);
      return { url: () => requested, status: () => 200, headersArray: () => [
        { name: "content-type", value: "application/json" }, { name: "cache-control", value: "private, no-store" },
      ], body: async () => Buffer.from(JSON.stringify(result)), dispose: async () => {} };
    } },
  });
  assert.equal(await observeP2InteractiveIdentitySession(page(selected.browserOrigin + "/admin", body), selected, observation), null);
  assert.equal(requests, 0);
  assert.deepEqual(await observeP2InteractiveIdentitySession(page(canonical, body), selected, observation), body);
  await assert.rejects(observeP2InteractiveIdentitySession(page(canonical, { ...body, actorKind: "customer" }), selected, observation),
    /IDENTITY_SESSION_REFUSED/u);
});

test("first-owner discovery derives only the strict later selection from a fresh window-bound auth session", async () => {
  const nonce = "8".repeat(32), email = "owned-owner@example.invalid";
  const firstOwnerDiscovery = { nonce, emailSha256: p2FirstOwnerDiscoveryEmailSha256(nonce, email) };
  const selected = interactiveInput({ firstOwnerDiscovery });
  assert.equal(validateP2InteractiveBrowserInput(selected), selected);
  assert.throws(() => validateP2InteractiveBrowserInput({ ...selected,
    firstOwner: { nonce, identitySha256: "6".repeat(64) } }));
  const permit = interactivePermit(selected), startedAt = Number(permit.cookie.split(".")[3]);
  assert.equal(validateP2InteractiveBrowserPermit(permit, selected), permit);
  const windowSha256 = identityHash(["p2q-first-owner-discovery-window-v1", nonce,
    firstOwnerDiscovery.emailSha256.slice(0, 62), selected.epoch, startedAt]);
  const body = { expires: new Date(Date.now() + 3_600_000).toISOString(), user: {
    name: "Owned owner", email, image: null, providerUserId: ownedGoogleSubject, isEmailVerified: true,
    authenticatedAt: Math.floor(Date.now() / 1000), firstOwnerDiscoveryWindowSha256: windowSha256,
  } };
  const observation = { context: "owner", openedAt: Date.now(), startedAt, expires: permit.expires };
  const page = value => ({
    url: () => selected.browserOrigin + "/admin/not-authorized",
    request: { get: async url => ({ url: () => url, status: () => 200, headersArray: () => [
      { name: "content-type", value: "application/json" }, { name: "cache-control", value: "private, no-store" },
    ], body: async () => Buffer.from(JSON.stringify(value)), dispose: async () => {} }) },
  });
  const receipt = await observeP2InteractiveIdentitySession(page(body), selected, observation);
  assert.deepEqual(receipt, { firstOwner: { nonce,
    identitySha256: p2FirstOwnerIdentitySha256(nonce, email, ownedGoogleSubject) }, sessionVerified: true });
  assert.equal(JSON.stringify(receipt).includes(email), false);
  assert.equal(JSON.stringify(receipt).includes(ownedGoogleSubject), false);
  for (const changed of [
    { ...body, user: { ...body.user, email: "other@example.invalid" } },
    { ...body, user: { ...body.user, firstOwnerDiscoveryWindowSha256: "6".repeat(64) } },
    { ...body, user: { ...body.user, authenticatedAt: startedAt - 1 } },
    { ...body, user: { ...body.user, isEmailVerified: false } },
  ]) await assert.rejects(observeP2InteractiveIdentitySession(page(changed), selected, observation), /IDENTITY_SESSION_REFUSED/u);
  assert.throws(() => validateP2InteractiveIdentityReceipt({ ...receipt,
    firstOwner: { ...receipt.firstOwner, identitySha256: firstOwnerDiscovery.emailSha256 } }, selected));
});

test("identity session refuses wrong or expired identity and waits for a newly authenticated verified owner", async () => {
  const owner = interactiveInput(), learner = interactiveInput({ identity: { actorKind: "customer", actorId: userId } });
  const selection = { context: "owner", ownerSubjectSha256: ownerSubject(owner), openedAt: Date.now(), expires: Math.floor(Date.now() / 1000) + 60 };
  let requests = 0, disposed = 0;
  const page = (body, expected = "/api/auth/session") => ({
    url: () => owner.browserOrigin + "/admin/sign-in",
    request: { get: async (url, options) => {
      requests++;
      assert.equal(url, owner.browserOrigin + expected);
      assert.equal(options.maxRedirects, 0);
      return { url: () => url, status: () => 200, headersArray: () => [
        { name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "private, no-cache, no-store" },
      ], body: async () => Buffer.from(JSON.stringify(body)), dispose: async () => { disposed++; } };
    } },
  });
  const observed = await observeP2InteractiveIdentitySession(page(ownerSession()), owner, selection);
  assert.deepEqual(observed, { actorKind: "admin", actorId: adminId, sessionVerified: true });
  assert.equal(JSON.stringify(observed).includes(ownedGoogleSubject), false);
  assert.equal(await observeP2InteractiveIdentitySession(page(ownerSession(ownedGoogleSubject, Math.floor(selection.openedAt / 1000) - 5)), owner, selection), null);
  await assert.rejects(observeP2InteractiveIdentitySession(page(ownerSession("other-owned-subject")), owner, selection), /IDENTITY_SESSION_REFUSED/u);
  await assert.rejects(observeP2InteractiveIdentitySession(page(ownerSession()), owner, { ...selection, context: "learner" }), /IDENTITY_SESSION_REFUSED/u);
  const customerSelection = { context: "learner", openedAt: selection.openedAt, expires: selection.expires };
  assert.deepEqual(await observeP2InteractiveIdentitySession(page(customerSession(), "/api/customer-auth/session"), learner, customerSelection),
    { actorKind: "customer", actorId: userId, sessionVerified: true });
  await assert.rejects(observeP2InteractiveIdentitySession(page(customerSession(randomUUID()), "/api/customer-auth/session"), learner, customerSelection),
    /IDENTITY_SESSION_REFUSED/u);
  const enrollment = ownedEnrollment("google"), newCustomer = interactiveInput({ identityEnrollment: enrollment });
  const captured = await observeP2InteractiveIdentitySession(page(customerSession(enrollmentId, enrollmentEmail), "/api/customer-auth/session"), newCustomer, customerSelection);
  assert.deepEqual(captured, { actorKind: "customer", actorId: enrollmentId, sessionVerified: true });
  assert.equal(JSON.stringify(captured).includes(enrollmentEmail), false);
  const wrongDigest = { ...enrollment, emailSha256: enrollment.emailSha256.slice(0, -1) + (enrollment.emailSha256.endsWith("0") ? "1" : "0") };
  await assert.rejects(observeP2InteractiveIdentitySession(page(customerSession(enrollmentId, enrollmentEmail), "/api/customer-auth/session"),
    interactiveInput({ identityEnrollment: wrongDigest }), customerSelection), /IDENTITY_SESSION_REFUSED/u);
  await assert.rejects(observeP2InteractiveIdentitySession(page(customerSession(enrollmentId), "/api/customer-auth/session"), newCustomer, customerSelection),
    /IDENTITY_SESSION_REFUSED/u);
  await assert.rejects(observeP2InteractiveIdentitySession(page(ownerSession()), owner, { ...selection, expires: Math.floor(Date.now() / 1000) }),
    /IDENTITY_SESSION_REFUSED/u);
  assert.equal(requests, 8);
  assert.equal(disposed, requests);
});

const ownedInteractiveBrowser = process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST === "true";
test("owned Chromium child refuses an authoring phase after clearing an unverified owner identity",
  { skip: !ownedInteractiveBrowser }, async () => {
    const first = interactiveInput(), permit = interactivePermit(first), runner = interactiveChild();
    const selection = { context: "owner", expires: permit.expires };
    const next = interactiveInput({ stage: "authoring", authoring: ownedAuthoring, epoch: "11", actionId: "owned-authoring", bindingSha256: "d".repeat(64) });
    try {
      assert.equal((await runner.command("initialize-interactive", first)).type, "interactive-initialized");
      assert.equal((await runner.command("interactive-install", { ...binding(first), ...selection }, privateFrame(first, selection.context, permit))).type,
        "interactive-permit-installed");
      assert.equal((await runner.command("interactive-clear", { ...binding(first), ...selection })).type, "interactive-permit-cleared");
      assert.deepEqual(await runner.command("interactive-select", { ...binding(first), next }), { type: "failed" });
      assert.deepEqual(await runner.exited, [1, null]);
      assert.deepEqual(runner.output, []);
    } finally { await runner.close(); }
  });

test("owned Chromium child refuses phase selection into or out of first enrollment",
  { skip: !ownedInteractiveBrowser }, async () => {
    const enrollment = interactiveInput({ identityEnrollment: ownedEnrollment("google") });
    const known = interactiveInput({ identity: { actorKind: "customer", actorId: userId } });
    for (const [first, successor] of [[enrollment, known], [known, enrollment]]) {
      const runner = interactiveChild(), permit = interactivePermit(first), context = "learner";
      const next = { ...successor, epoch: "11", actionId: "owned-forbidden-enrollment", bindingSha256: "d".repeat(64) };
      const selection = { context, expires: permit.expires };
      try {
        assert.equal((await runner.command("initialize-interactive", first)).type, "interactive-initialized");
        assert.equal((await runner.command("interactive-install", { ...binding(first), ...selection }, privateFrame(first, context, permit))).type,
          "interactive-permit-installed");
        assert.equal((await runner.command("interactive-clear", { ...binding(first), ...selection })).type, "interactive-permit-cleared");
        assert.deepEqual(await runner.command("interactive-select", { ...binding(first), next }), { type: "failed" });
        assert.deepEqual(await runner.exited, [1, null]);
        assert.deepEqual(runner.output, []);
      } finally { await runner.close(); }
    }
  });

test("owned Chromium observes a new customer and keeps reviewed sessions through lifecycle and authoring permit rotation",
  { skip: !ownedInteractiveBrowser, timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "owned-p2-identity-tls-"));
    const sockets = new Set(), hits = [], lifecycleRequestId = randomUUID(), authoringRequestId = randomUUID();
    const lifecycle = p2LifecycleMutationTarget({ actorKind: "customer", userId, operation: "preferences-on" });
    const enrollment = ownedEnrollment("resend"), enrollmentSelector = "a2" + enrollment.emailSha256.slice(0, 62);
    const bind = async server => {
      server.on("connection", socket => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    };
    const key = join(root, "key.pem"), cert = join(root, "cert.pem");
    let browser, https, proxy;
    try {
      assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=staging.lashher.com", "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
      https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
        const cookies = request.headers.cookie ?? "";
        const ownerCookie = cookies.includes("owned-owner=fixture"), customerCookie = cookies.includes("owned-customer=fixture");
        const enrollmentCookie = cookies.includes("owned-customer=enrollment");
        const customerPermit = cookies.includes("__Host-lash-p2q-window=v2.9.identity.") && cookies.includes("." + customerIdentitySelector + ".");
        const enrollmentPermit = cookies.includes("__Host-lash-p2q-window=v2.9.identity.") && cookies.includes("." + enrollment.nonce + "." + enrollmentSelector + ".");
        const lifecyclePermit = cookies.includes("__Host-lash-p2q-window=v2.11.lifecycle.");
        const authoringPermit = cookies.includes("__Host-lash-p2q-window=v2.11.authoring.") && cookies.includes("." + authoringSelector(adminId) + ".");
        if (request.method === "GET" && ["/sign-in", "/admin/sign-in"].includes(request.url)) {
          response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><main>Owned identity</main>
            <form method="POST" action="/api/customer-auth/signin/resend"><button>Sign in</button></form>`);
          return;
        }
        if (request.method === "POST" && request.url === "/api/customer-auth/signin/resend" && (customerPermit || enrollmentPermit) && !ownerCookie) {
          request.resume();
          response.writeHead(303, { location: "/api/customer-auth/callback/resend" }).end();
          return;
        }
        if (request.method === "GET" && request.url === "/api/customer-auth/callback/resend" && (customerPermit || enrollmentPermit) && !ownerCookie) {
          response.writeHead(303, { location: "/sign-in",
            "set-cookie": `owned-customer=${enrollmentPermit ? "enrollment" : "fixture"}; Path=/; Secure; HttpOnly; SameSite=Lax` }).end();
          return;
        }
        if (request.method === "GET" && request.url === "/account" && customerCookie && !ownerCookie && lifecyclePermit) {
          response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><button id="save">Save</button><script>
            document.querySelector("#save").onclick = () => fetch("/api/account/preferences", {
              method: "POST", headers: { "content-type": "application/json" }, body: '{"learningUpdates":true}'
            }).then(response => response.json());</script>`);
          return;
        }
        if (request.method === "POST" && request.url === lifecycle.pathname && customerCookie && !ownerCookie && lifecyclePermit) {
          request.resume();
          const body = '{"saved":true}';
          response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store",
            "content-length": Buffer.byteLength(body), "x-request-id": lifecycleRequestId }).end(body);
          return;
        }
        if (request.method === "GET" && request.url === "/admin/courses" && ownerCookie && !customerCookie && !enrollmentCookie && authoringPermit) {
          response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><form>
            <label>Title<input name="title"></label><label>Slug<input name="slug"></label><button>Create draft</button></form><script>
            document.querySelector("form").onsubmit = async event => {
              event.preventDefault();
              const form = new FormData(event.currentTarget), draft = ${JSON.stringify(ownedDraft)};
              const result = await fetch("/api/admin/courses", {
                method: "POST", headers: { "content-type": "application/json", "x-lash-csrf": "1" },
                body: JSON.stringify({ ...draft, title: form.get("title"), slug: form.get("slug") })
              });
              const { course } = await result.json();
              history.pushState(null, "", "/admin/courses/" + course.id);
            };</script>`);
          return;
        }
        if (request.method === "POST" && request.url === "/api/admin/courses" && ownerCookie && !customerCookie && !enrollmentCookie && authoringPermit) {
          request.resume();
          const body = JSON.stringify(ownedDraftResponse);
          response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-store",
            "content-length": Buffer.byteLength(body), "x-request-id": authoringRequestId }).end(body);
          return;
        }
        const owner = request.url === "/api/auth/session", customer = request.url === "/api/customer-auth/session";
        if (request.method !== "GET" || (!owner && !customer)) return response.writeHead(404).end();
        hits.push({ path: request.url, ownerCookie, customerCookie, enrollmentCookie, permitCookie: cookies.includes("__Host-lash-p2q-window=") });
        let value = null;
        if (owner && ownerCookie && !customerCookie && !enrollmentCookie) value = ownerSession();
        if (customer && customerCookie && !ownerCookie && customerPermit) value = customerSession();
        if (customer && enrollmentCookie && !ownerCookie && enrollmentPermit) value = customerSession(enrollmentId, enrollmentEmail);
        const body = JSON.stringify(value);
        response.writeHead(200, { "content-type": "application/json", "cache-control": "private, no-cache, no-store",
          "content-length": Buffer.byteLength(body) }).end(body);
      });
      const tlsPort = await bind(https);
      proxy = createHttpServer((_request, response) => response.writeHead(403).end());
      proxy.on("connect", (request, socket, head) => {
        if (request.url !== "staging.lashher.com:443") { socket.destroy(); return; }
        const target = connect(tlsPort, "127.0.0.1");
        sockets.add(target);
        target.once("close", () => sockets.delete(target));
        target.once("error", () => socket.destroy());
        socket.once("error", () => target.destroy());
        target.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
        });
      });
      const proxyPort = await bind(proxy), { chromium } = await import("playwright");
      browser = await chromium.launch();
      for (const [context, input, options] of [
        ["owner", interactiveInput(), { ownerSubjectSha256: ownerSubject(interactiveInput()) }],
        ["learner", interactiveInput({ identity: { actorKind: "customer", actorId: userId } }), {}],
        ["learner", interactiveInput({ identityEnrollment: enrollment }), {}],
      ]) {
        const owned = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true });
        try {
          owned.setDefaultTimeout(5000);
          const permit = interactivePermit(input);
          if (context === "owner") await owned.addCookies([{ name: "owned-owner", value: "fixture", url: input.browserOrigin + "/" }]);
          await installP2InteractiveBrowserCookie(owned, permit, input);
          const openedAt = Date.now(), page = await owned.newPage();
          await page.goto(input.browserOrigin + p2InteractiveBrowserPath("identity", context));
          if (context === "learner") {
            assert.equal(await observeP2InteractiveIdentitySession(page, input, { context, openedAt, expires: permit.expires }), null);
            const callback = page.waitForResponse(response => response.url() === input.browserOrigin + "/api/customer-auth/callback/resend");
            await page.getByRole("button", { name: "Sign in" }).click();
            assert.equal((await callback).status(), 303);
            await page.waitForLoadState();
          }
          assert.deepEqual(await observeP2InteractiveIdentitySession(page, input, { context, openedAt, expires: permit.expires, ...options }),
            { ...(input.identity ?? { actorKind: "customer", actorId: enrollmentId }), sessionVerified: true });
          await expireP2InteractiveBrowserCookie(owned);
          await page.close();
          if (context === "owner") {
            assert.deepEqual((await owned.cookies([input.browserOrigin])).map(cookie => cookie.name), ["owned-owner"]);
            const next = interactiveInput({ stage: "authoring", authoring: ownedAuthoring, epoch: "11",
              actionId: "owned-authoring", bindingSha256: "d".repeat(64) });
            const nextPermit = interactivePermit(next);
            await installP2InteractiveBrowserCookie(owned, nextPermit, next);
            const authoring = await owned.newPage(), watch = watchP2AuthoringMutation(owned, authoring, next);
            try {
              await authoring.goto(input.browserOrigin + "/admin/courses");
              await authoring.getByLabel("Title").fill(ownedDraft.title);
              await authoring.getByLabel("Slug").fill(ownedDraft.slug);
              await authoring.getByRole("button", { name: "Create draft" }).click();
              await watch.wait(Math.min(nextPermit.expires, Math.floor(Date.now() / 1000) + 5));
              await authoring.waitForURL(input.browserOrigin + "/admin/courses/" + ownedCourseId);
              await expireP2InteractiveBrowserCookie(owned);
              await authoring.close();
              assert.deepEqual(watch.finish(), { method: "POST", pathname: "/api/admin/courses", status: 200, requestId: authoringRequestId,
                body: { courseId: ownedCourseId, slug: ownedDraft.slug, revision: 1, status: "draft" } });
            } finally { watch.close(); }
          }
          if (context === "learner" && !input.identityEnrollment) {
            assert.deepEqual((await owned.cookies([input.browserOrigin])).map(cookie => cookie.name), ["owned-customer"]);
            const next = interactiveInput({ stage: "lifecycle", lifecycle, epoch: "11", actionId: "owned-lifecycle", bindingSha256: "d".repeat(64) });
            const nextPermit = interactivePermit(next);
            await installP2InteractiveBrowserCookie(owned, nextPermit, next);
            const account = await owned.newPage(), watch = watchP2LifecycleMutation(owned, account, next);
            try {
              await account.goto(input.browserOrigin + "/account");
              const saved = account.waitForResponse(response => response.url() === input.browserOrigin + lifecycle.pathname);
              await account.getByRole("button", { name: "Save" }).click();
              assert.equal((await saved).status(), 200);
              await watch.wait(Math.min(nextPermit.expires, Math.floor(Date.now() / 1000) + 5));
              await expireP2InteractiveBrowserCookie(owned);
              await account.close();
              assert.deepEqual(watch.finish(), { method: "POST", pathname: lifecycle.pathname, status: 200, requestId: lifecycleRequestId, body: { saved: true } });
            } finally { watch.close(); }
          }
        } finally { await owned.close(); }
      }
      assert.deepEqual(hits, [
        { path: "/api/auth/session", ownerCookie: true, customerCookie: false, enrollmentCookie: false, permitCookie: true },
        { path: "/api/customer-auth/session", ownerCookie: false, customerCookie: false, enrollmentCookie: false, permitCookie: true },
        { path: "/api/customer-auth/session", ownerCookie: false, customerCookie: true, enrollmentCookie: false, permitCookie: true },
        { path: "/api/customer-auth/session", ownerCookie: false, customerCookie: false, enrollmentCookie: false, permitCookie: true },
        { path: "/api/customer-auth/session", ownerCookie: false, customerCookie: false, enrollmentCookie: true, permitCookie: true },
      ]);
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, https].filter(server => server?.listening).map(server => new Promise(done => server.close(done))));
      rmSync(root, { recursive: true, force: true });
    }
  });

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

test("lifecycle response requires the reviewed path, method, action and exact status-specific body", () => {
  const { lifecycle } = interactiveInput({ stage: "lifecycle" });
  const receipt = { method: "POST", pathname: lifecycle.pathname, status: 202, requestId: randomUUID(),
    body: { commandId, action: "suspend", accountVersion: 1, status: "pending" } };
  assert.deepEqual(validateP2LifecycleMutationReceipt(receipt, lifecycle), receipt);
  for (const change of [{ method: "GET" }, { pathname: lifecycle.pathname + "?token=private" }, { status: 200 }, { requestId: "private" },
    { body: { ...receipt.body, action: "delete" } }, { body: { ...receipt.body, raw: "private" } }]) {
    assert.throws(() => validateP2LifecycleMutationReceipt({ ...receipt, ...change }, lifecycle));
  }
  const selection = p2LifecycleMutationTarget({ actorKind: "customer", userId, operation: "preferences-on" });
  assert.deepEqual(selection, { context: "learner", pathname: "/api/account/preferences", operation: "preferences-on" });
  assert.deepEqual(validateP2LifecycleMutationReceipt({ ...receipt, pathname: selection.pathname, status: 200, body: { saved: true } }, selection).body, { saved: true });
  for (const target of [{ ...selection, context: "owner" }, { ...selection, pathname: lifecycle.pathname }, { ...selection, operation: "restore" }]) {
    assert.throws(() => validateP2InteractiveBrowserInput(interactiveInput({ stage: "lifecycle", lifecycle: target })));
  }
});

async function ownedMutationPage(browser, input, pathname, contextName, response, watchMutation, document = "<!doctype html><main>Owned fixture</main>") {
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "text/html", body: document });
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" } });
    if (url.origin !== input.browserOrigin || url.pathname !== pathname) return route.fulfill({
      status: 200, headers: { "access-control-allow-origin": "*" }, body: "owned unrelated response",
    });
    return route.fulfill(response);
  });
  const page = await context.newPage(), watch = watchMutation(context, page, input);
  await page.goto(input.browserOrigin + p2InteractiveBrowserEntryPath(input, contextName));
  const post = (target, body) => page.evaluate(async ({ target, body }) => {
    const result = await fetch(target, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await result.arrayBuffer();
  }, { target, body });
  const close = async () => { watch.close(); await context.close(); };
  return { input, page, watch, post, close, expires: Math.floor(Date.now() / 1000) + 60 };
}

function ownedLifecyclePage(browser, lifecycle, response, document) {
  return ownedMutationPage(browser, interactiveInput({ stage: "lifecycle", lifecycle }), lifecycle.pathname, lifecycle.context,
    response, watchP2LifecycleMutation, document);
}

test("owned Chromium reorder accepts trusted keyboard activations and rejects mouse, synthetic and wrong-kind controls",
  { skip: !ownedInteractiveBrowser, timeout: 18_000 }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const run = async (kind, variant) => {
      const context = await browser.newContext(), { input, target, winnerBody, staleBody } = ownedReorder(kind);
      const detail = p2InteractiveBrowserEntryPath(input, "owner"), pathname = p2AuthoringReorderPath(target);
      const winnerId = randomUUID(), staleId = randomUUID(), wrongKind = kind === "module" ? "lesson" : "module";
      const receiptIds = variant === "wrong-order" ? [...winnerBody.ids].reverse() : winnerBody.ids;
      const result = kind === "module" ? { course: { id: target.courseId, slug: target.slug, status: "draft", revision: 5, modules: receiptIds.map(id => ({ id })) } }
        : { module: { id: target.parentId, courseId: target.courseId, courseRevision: 5, lessons: receiptIds.map(id => ({ id })) } };
      const conflict = { error: { code: "conflict", message: "Owned fixture conflict." }, requestId: staleId };
      const effects = [];
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== input.browserOrigin) return route.abort();
        if (url.pathname === detail && request.method() === "GET") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8",
          body: `<!doctype html><p>draft · Revision 4</p>
            <button id="winner" aria-label="Move ${kind} Owned first down">Down</button>
            <button id="stale" aria-label="Move ${kind} Owned third up">Up</button>
            <button id="wrong" aria-label="Move ${wrongKind} Owned unrelated down">Down</button>
            <div id="feedback"></div><script>
            async function submit(body) {
              const result = await fetch(${JSON.stringify(pathname)}, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
              const feedback = document.querySelector("#feedback");
              if (result.ok) {
                await result.json();
                await (await fetch(${JSON.stringify(pathname)})).json();
                feedback.setAttribute("role", "status");
                feedback.textContent = "Curriculum order saved.";
              } else {
                feedback.setAttribute("role", "alert");
                feedback.textContent = "This course changed or is not ready for this operation. Reload before trying again. Reference: " + result.headers.get("x-request-id");
              }
            }
            document.querySelector("#winner").onclick = document.querySelector("#wrong").onclick = () => submit(${JSON.stringify(winnerBody)});
            document.querySelector("#stale").onclick = () => submit(${JSON.stringify(staleBody)});
            </script>` });
        if (url.pathname !== pathname) return route.abort();
        if (request.method() === "GET") return route.fulfill({ status: 200, json: result });
        if (request.method() !== "POST") return route.abort();
        const digest = identityHash(request.postDataJSON());
        assert.ok([target.winnerBodySha256, target.staleBodySha256].includes(digest));
        const won = digest === target.winnerBodySha256;
        effects.push(won ? "winner" : "stale");
        return route.fulfill({ status: won ? 200 : 409, headers: { "content-type": "application/json",
          "cache-control": "private, no-store", "x-request-id": won ? winnerId : staleId }, body: JSON.stringify(won ? result : conflict) });
      });
      const winner = await context.newPage(), stale = await context.newPage(), watch = watchP2AuthoringEdits(context, winner, stale, input);
      try {
        const expires = Math.floor(Date.now() / 1000) + 7;
        await watch.open(expires);
        if (variant === "mouse") await winner.locator("#winner").click();
        else if (variant === "synthetic") await winner.locator("#winner").evaluate(button => {
          button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          button.click();
        });
        else await winner.locator(variant === "wrong-kind" ? "#wrong" : "#winner").press("Enter");
        await winner.getByRole("status").waitFor({ timeout: 3000 });
        if (variant !== "success") {
          await assert.rejects(watch.wait(expires), /AUTHORING_RESPONSE_REFUSED/u);
          assert.throws(() => watch.finish());
          assert.deepEqual(effects, ["winner"]);
          return;
        }
        await stale.locator("#stale").press("Space");
        await watch.wait(expires);
        await Promise.all([winner.close(), stale.close()]);
        const receipt = watch.finish();
        assert.deepEqual(receipt, {
          winner: { method: "POST", pathname, status: 200, requestId: winnerId, keyboardActivated: true,
            body: { courseId: target.courseId, parentId: target.parentId, kind, revision: 5, ids: winnerBody.ids } },
          stale: { method: "POST", pathname, status: 409, requestId: staleId, keyboardActivated: true, outcome: "conflict" },
        });
        assert.equal(JSON.stringify(receipt).includes("Owned"), false);
        assert.deepEqual(effects, ["winner", "stale"]);
      } finally { watch.close(); await context.close(); }
    };
    try {
      for (const kind of ["module", "lesson"]) await run(kind, "success");
      for (const variant of ["mouse", "synthetic", "wrong-kind", "wrong-order"]) await run("module", variant);
    } finally { await browser.close(); }
  });

test("owned Chromium two-tab editing captures the winner and proves the stale title survives the conflict",
  { skip: !ownedInteractiveBrowser, timeout: 15_000 }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const input = interactiveInput({ stage: "authoring", authoring: ownedAuthoringEdit });
    const detail = p2InteractiveBrowserEntryPath(input, "owner"), pathname = "/api/admin/courses/" + ownedCourseId;
    const winnerId = randomUUID(), staleId = randomUUID();
    const winnerBody = { course: { ...ownedDraftResponse.course, title: ownedWinner.title, revision: 5 } };
    const conflict = { error: { code: "conflict", message: "Owned fixture conflict." }, requestId: staleId };
    const expected = { winner: { method: "PATCH", pathname, status: 200, requestId: winnerId,
      body: { courseId: ownedCourseId, slug: ownedDraft.slug, revision: 5, status: "draft" } },
    stale: { method: "PATCH", pathname, status: 409, requestId: staleId, outcome: "conflict", dirtyInputPreserved: true } };
    const run = async (scenario) => {
      const context = await browser.newContext(), effects = [];
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== input.browserOrigin) return route.abort();
        if (url.pathname === detail && request.method() === "GET") return route.fulfill({ status: 200, contentType: "text/html",
          body: `<!doctype html><form><label>Course title <input name="title" value="Owned initial title"></label>
            <button>Save course details</button></form><div id="feedback"></div><script>
            document.querySelector("form").onsubmit = async event => {
              event.preventDefault();
              const title = new FormData(event.currentTarget).get("title"), fields = ${JSON.stringify(ownedEditFields)};
              const response = await fetch(${JSON.stringify(pathname)}, { method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...fields, title, expectedRevision: 4 }) });
              const feedback = document.querySelector("#feedback");
              if (response.ok) {
                await response.json();
                await (await fetch(${JSON.stringify(pathname)})).json();
                feedback.setAttribute("role", "status");
                feedback.textContent = "Course details saved.";
              } else {
                if (${scenario === "reset"}) document.querySelector("input[name=title]").value = "Owned initial title";
                feedback.setAttribute("role", "alert");
                feedback.textContent = "This course changed or is not ready for this operation. Reload before trying again. Reference: " + response.headers.get("x-request-id");
              }
            };</script>` });
        if (url.pathname === pathname && request.method() === "GET") return route.fulfill({ status: 200, json: winnerBody });
        if (url.pathname !== pathname || request.method() !== "PATCH") return route.abort();
        const selected = request.postDataJSON().title === ownedWinner.title ? "winner" : "stale";
        effects.push(selected);
        return route.fulfill({ status: selected === "winner" ? 200 : 409, headers: { "content-type": "application/json",
          "cache-control": "private, no-store", "x-request-id": selected === "winner" ? winnerId : staleId },
        body: JSON.stringify(selected === "winner" ? winnerBody : conflict) });
      });
      const winner = await context.newPage(), stale = await context.newPage(), watch = watchP2AuthoringEdits(context, winner, stale, input);
      try {
        const expires = Math.floor(Date.now() / 1000) + 10;
        await watch.open(expires);
        const submit = async (page, title) => {
          await page.getByRole("textbox", { name: "Course title" }).fill(title);
          await page.getByRole("button", { name: "Save course details" }).click();
        };
        if (scenario !== "early") {
          await submit(winner, ownedWinner.title);
          await winner.getByRole("status").waitFor();
        }
        await submit(stale, ownedStale.title);
        if (scenario === "early" || scenario === "reset") {
          await assert.rejects(watch.wait(expires));
          assert.throws(() => watch.finish());
          return;
        }
        await watch.wait(expires);
        const receipt = watch.finish();
        assert.deepEqual(receipt, expected);
        assert.equal(JSON.stringify(receipt).includes(ownedStale.title), false);
        if (scenario === "duplicate") {
          const reload = winner.waitForResponse(response => response.url() === input.browserOrigin + pathname && response.request().method() === "GET");
          await submit(winner, ownedWinner.title);
          await reload;
          assert.throws(() => watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } else {
          await Promise.all([winner.close(), stale.close()]);
          assert.deepEqual(watch.finish(), expected);
          assert.deepEqual(effects, ["winner", "stale"]);
        }
      } finally { watch.close(); await context.close(); }
    };
    try {
      for (const scenario of ["success", "early", "reset", "duplicate"]) await run(scenario);
    } finally { await browser.close(); }
  });

test("owned Chromium authoring watcher refuses digest changes, mismatched draft responses and duplicate success",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch(), input = interactiveInput({ stage: "authoring", authoring: ownedAuthoring });
    const pathname = "/api/admin/courses", requestId = randomUUID();
    const headers = { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId };
    const response = { status: 200, headers, body: JSON.stringify(ownedDraftResponse) };
    const open = result => ownedMutationPage(browser, input, pathname, "owner", result, watchP2AuthoringMutation);
    try {
      const owner = await open(response);
      try {
        await owner.post(pathname, ownedDraft);
        await owner.watch.wait(owner.expires);
        const receipt = owner.watch.finish();
        assert.deepEqual(receipt, { method: "POST", pathname, status: 200, requestId,
          body: { courseId: ownedCourseId, slug: ownedDraft.slug, revision: 1, status: "draft" } });
        assert.equal(JSON.stringify(receipt).includes(ownedDraft.title), false);
        await owner.post(pathname, ownedDraft);
        assert.throws(() => owner.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
      } finally { await owner.close(); }
      const { title, ...fields } = ownedDraft;
      for (const [result, payload] of [
        [response, { ...fields, title }],
        [{ ...response, status: 503 }, ownedDraft],
        [{ ...response, body: JSON.stringify({ course: { ...ownedDraftResponse.course, slug: "wrong-draft" } }) }, ownedDraft],
        [{ ...response, body: JSON.stringify({ course: { ...ownedDraftResponse.course, revision: 2 } }) }, ownedDraft],
      ]) {
        const rejected = await open(result);
        try {
          await rejected.post(pathname, payload);
          await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
      const foreignPage = await open(response);
      try {
        await foreignPage.page.goto(input.browserOrigin + "/admin/other");
        await foreignPage.post(pathname, ownedDraft);
        await assert.rejects(foreignPage.watch.wait(foreignPage.expires), /AUTHORING_RESPONSE_REFUSED/u);
      } finally { await foreignPage.close(); }
    } finally { await browser.close(); }
  });

test("owned Chromium curriculum capture waits for the normal saved status and refuses mismatched mutations",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const requestId = randomUUID(), headers = { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId };
    try {
      for (const kind of ["module", "lesson"]) {
        const fixture = ownedCurriculum(kind), { input, target, posted, item, parentField, response, body } = fixture;
        const pathname = p2AuthoringCurriculumPath(target), detail = p2InteractiveBrowserEntryPath(input, "owner");
        const add = kind === "module" ? "Add module" : "Add lesson", saved = kind === "module" ? "Module saved." : "Lesson saved.";
        const result = { status: 200, headers, body: JSON.stringify(response) };
        const document = `<!doctype html><button id="add">${add}</button><form hidden><label>Title<input name="title"></label>
          <label>Slug<input name="slug"></label><button>Save ${kind}</button></form><button id="readback" hidden>Complete readback</button>
          <div role="status"><p></p></div><script>
          const form = document.querySelector('form'), readback = document.querySelector('#readback');
          document.querySelector('#add').onclick = () => { form.hidden = false; };
          form.onsubmit = async event => {
            event.preventDefault();
            const fields = new FormData(form);
            const post = await fetch(${JSON.stringify(pathname)}, {method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({...${JSON.stringify(posted)},title:fields.get('title'),slug:fields.get('slug')})});
            await post.json();
            readback.hidden = false;
          };
          readback.onclick = async () => {
            await (await fetch(${JSON.stringify("/api" + detail)})).text();
            document.querySelector('[role="status"] p').textContent = ${JSON.stringify(saved)};
          };
          </script>`;
        const owner = await ownedMutationPage(browser, input, pathname, "owner", result, watchP2AuthoringMutation, document);
        try {
          const capture = owner.watch.wait(owner.expires);
          capture.catch(() => {});
          await owner.page.getByRole("button", { name: add, exact: true }).click();
          await owner.page.getByRole("textbox", { name: "Title", exact: true }).fill(posted.title);
          await owner.page.getByRole("textbox", { name: "Slug", exact: true }).fill(posted.slug);
          await owner.page.getByRole("button", { name: "Save " + kind, exact: true }).click();
          const readback = owner.page.getByRole("button", { name: "Complete readback", exact: true });
          await readback.waitFor({ state: "visible" });
          assert.throws(() => owner.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
          await readback.click();
          await capture;
          const receipt = owner.watch.finish();
          assert.deepEqual(receipt, { method: "POST", pathname, status: 200, requestId, body });
          assert.equal(JSON.stringify(receipt).includes(posted.title), false);
          await owner.post(pathname, posted);
          assert.throws(() => owner.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await owner.close(); }

        const wrongSlug = { ...posted, slug: "different-child" };
        for (const scenario of [
          { request: wrongSlug, response },
          { request: wrongSlug, response, digest: identityHash(wrongSlug) },
          { request: posted, response: { [kind]: { ...item, slug: "different-child" } } },
          { request: posted, response: { [kind]: { ...item, [parentField]: randomUUID() } } },
          { request: posted, response: { [kind]: { ...item, courseRevision: 4 } } },
          { request: posted, response, source: "/admin/courses/" + randomUUID() },
          { request: posted, response, path: pathname + "/wrong" },
          { request: posted, response },
        ]) {
          const selected = scenario.digest ? { ...input, authoring: { ...target, bodySha256: scenario.digest } } : input;
          const rejected = await ownedMutationPage(browser, selected, pathname, "owner", { ...result, body: JSON.stringify(scenario.response) },
            watchP2AuthoringMutation);
          try {
            if (scenario.source) await rejected.page.goto(input.browserOrigin + scenario.source);
            await rejected.post(scenario.path ?? pathname, scenario.request);
            const expires = scenario.path || scenario.request === posted && scenario.response === response && !scenario.source
              ? Math.floor(Date.now() / 1000) + 2 : rejected.expires;
            await assert.rejects(rejected.watch.wait(expires), /AUTHORING_RESPONSE_REFUSED/u);
            assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
          } finally { await rejected.close(); }
        }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium lesson capture accepts the exact rich v1 POST and refuses text, mark and link drift",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const contentDocument = { version: 1, blocks: [{ _type: "block", _key: "block-4-1", style: "h2",
      markDefs: [{ _type: "link", _key: "link-4-1", href: "https://owned-link.invalid/details" }],
      children: [{ _type: "span", _key: "span-4-1", text: "Private rich lesson text", marks: ["strong", "link-4-1"] }] }] };
    const { input, target, posted, item, body } = ownedCurriculum("lesson", contentDocument);
    const pathname = p2AuthoringCurriculumPath(target), detail = p2InteractiveBrowserEntryPath(input, "owner"), requestId = randomUUID();
    const response = { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId },
      body: JSON.stringify({ lesson: { ...item, contentDocument } }) };
    const fixture = `<!doctype html><form><label>Lesson content<textarea name="content"></textarea></label><button>Save lesson</button></form>
      <div role="status"><p></p></div><script>
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const contentDocument = JSON.parse(new FormData(event.currentTarget).get('content'));
        const result = await fetch(${JSON.stringify(pathname)}, {method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({...${JSON.stringify(posted)},contentDocument})});
        await result.json();
        await (await fetch(${JSON.stringify("/api" + detail)})).text();
        document.querySelector('[role="status"] p').textContent = 'Lesson saved.';
      };
      </script>`;
    const open = (selected, document) => ownedMutationPage(browser, selected, pathname, "owner", response, watchP2AuthoringMutation, document);
    try {
      const owner = await open(input, fixture);
      try {
        await owner.page.getByRole("textbox", { name: "Lesson content", exact: true }).fill(JSON.stringify(contentDocument));
        await owner.page.getByRole("button", { name: "Save lesson", exact: true }).click();
        await owner.watch.wait(owner.expires);
        assert.deepEqual(owner.watch.finish(), { method: "POST", pathname, status: 200, requestId, body });
      } finally { await owner.close(); }

      for (const change of [
        document => { document.blocks[0].children[0].text = "Different text"; },
        document => { document.blocks[0].children[0].marks[0] = "em"; },
        document => { document.blocks[0].markDefs[0].href = "https://changed-link.invalid/"; },
      ]) {
        const drift = structuredClone(contentDocument);
        change(drift);
        const rejected = await open(input);
        try {
          await rejected.post(pathname, { ...posted, contentDocument: drift });
          await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }

      for (const invalid of [{ ...posted, contentDocument: { ...contentDocument, version: 2 } },
        { ...posted, contentDocument: { ...contentDocument, blocks: Array.from({ length: 501 }, () => contentDocument.blocks[0]) } },
        { ...posted, captions: [{ language: "en", label: "English", url: "https://owned-caption.invalid/" }] }]) {
        const selected = { ...input, authoring: { ...target, bodySha256: identityHash(invalid) } };
        const rejected = await open(selected);
        try {
          await rejected.post(pathname, invalid);
          await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium publication checks the normal blocked UI or successful publish after readback",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const open = async (outcome, scenario) => {
      const fixture = ownedPublication(outcome), { input, target, detail, readiness, receipt, response } = fixture;
      const context = await browser.newContext(), effects = [];
      const document = `<!doctype html><meta charset="utf-8"><p id="revision">draft · Revision ${target.revision}</p><div role="status"><p id="feedback"></p></div>
        <button id="review">Review publication readiness</button><button id="publish" hidden>Publish course</button>
        <button id="reload" hidden>Complete readback</button><script>
        const feedback = document.querySelector('#feedback'), publish = document.querySelector('#publish'), reload = document.querySelector('#reload');
        const read = ${JSON.stringify(readiness)}, detail = ${JSON.stringify(detail)};
        document.querySelector('#review').onclick = async () => {
          const result = await (await fetch(read)).json();
          feedback.textContent = result.ready ? 'Ready to publish' : 'Resolve these items before publishing';
          publish.hidden = !result.ready && ${JSON.stringify(scenario !== "enabled-blocked")};
        };
        publish.onclick = async () => {
          const body = { expectedRevision:${target.revision}, status:${JSON.stringify(scenario === "bad-patch" ? "draft" : "published")} };
          await (await fetch(detail, {method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(body)})).json();
          reload.hidden = false;
        };
        reload.onclick = async () => {
          const result = await (await fetch(detail)).json();
          document.querySelector('#revision').textContent = result.course.status + ' · Revision ' + result.course.revision;
          feedback.textContent = 'Course published.';
        };
        </script>`;
      const send = (route, payload, requestId) => route.fulfill({ status: 200, body: JSON.stringify(payload),
        headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId } });
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: document });
        if (url.origin !== input.browserOrigin) return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "{}" });
        effects.push(request.method() + " " + url.pathname);
        if (url.pathname === readiness) return send(route, scenario === "wrong-issues" ? { ...response, issues: response.issues.slice(0, 1) } : response,
          receipt.readiness.requestId);
        const course = { ...ownedDraftResponse.course, id: target.courseId, revision: target.revision + 1, status: "published",
          ...(scenario === "wrong-result" ? { slug: "other-course" } : {}) };
        return send(route, { course }, request.method() === "PATCH" ? receipt.publication?.requestId ?? randomUUID() : randomUUID());
      });
      const page = await context.newPage(), watch = watchP2AuthoringMutation(context, page, input);
      await page.goto(input.browserOrigin + p2InteractiveBrowserEntryPath(input, "owner"));
      const review = page.getByRole("button", { name: "Review publication readiness", exact: true });
      const publish = page.getByRole("button", { name: "Publish course", exact: true });
      const expires = Math.floor(Date.now() / 1000) + 60;
      const close = async () => { watch.close(); await context.close(); };
      return { ...fixture, page, watch, review, publish, expires, effects, close };
    };
    try {
      const blocked = await open("blocked");
      try {
        await blocked.review.click();
        await blocked.watch.wait(blocked.expires);
        const receipt = blocked.watch.finish();
        assert.deepEqual(receipt, blocked.receipt);
        assert.equal(JSON.stringify(receipt).includes("Private fixture detail"), false);
        assert.deepEqual(blocked.effects, ["GET " + blocked.readiness]);
        await Promise.all([blocked.page.waitForResponse(response => response.url().endsWith(blocked.readiness)), blocked.review.click()]);
        assert.throws(() => blocked.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
      } finally { await blocked.close(); }

      const published = await open("published");
      try {
        await published.page.evaluate(async readiness => { await fetch("https://owned-foreign.invalid" + readiness); }, published.readiness);
        await published.review.click();
        await published.publish.click();
        const readback = published.page.getByRole("button", { name: "Complete readback", exact: true });
        await readback.waitFor({ state: "visible" });
        assert.throws(() => published.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        await readback.click();
        await published.watch.wait(published.expires);
        assert.deepEqual(published.watch.finish(), published.receipt);
        assert.deepEqual(published.effects, ["GET " + published.readiness, "PATCH " + published.detail, "GET " + published.detail]);
      } finally { await published.close(); }

      for (const [outcome, scenario] of [["blocked", "wrong-issues"], ["blocked", "enabled-blocked"], ["published", "bad-patch"],
        ["published", "wrong-result"], ["published", "early-patch"], ["blocked", "wrong-source"]]) {
        const rejected = await open(outcome, scenario);
        try {
          if (scenario === "early-patch") {
            await rejected.page.evaluate(async ({ detail, revision }) => {
              await (await fetch(detail, { method: "PATCH", body: JSON.stringify({ expectedRevision: revision, status: "published" }) })).json();
            }, { detail: rejected.detail, revision: rejected.target.revision });
          } else {
            if (scenario === "wrong-source") await rejected.page.goto(rejected.input.browserOrigin + "/admin/courses/" + randomUUID());
            await rejected.review.click();
            if (outcome === "published") await rejected.publish.click();
          }
          await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium paid republish requires draft readback, reviewed readiness and any published readback",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const open = async (outcome, scenario) => {
      const fixture = ownedRepublish(outcome), { input, target, detail, readiness, receipt, response } = fixture;
      const context = await browser.newContext(), effects = [];
      const document = `<!doctype html><meta charset="utf-8"><p id="revision">archived · Revision ${target.revision}</p>
        <div role="status"><p id="feedback"></p></div><button id="draft">Move to draft</button>
        <button id="review">Review publication readiness</button><button id="publish" hidden>Publish course</button><script>
        const feedback = document.querySelector('#feedback'), publish = document.querySelector('#publish'), draft = document.querySelector('#draft');
        const detail = ${JSON.stringify(detail)}, readiness = ${JSON.stringify(readiness)};
        const update = async (expectedRevision, status) => {
          const response = await fetch(detail, {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision,status})});
          const saved = await response.json();
          const { course } = ${scenario === "missing-draft-readback" ? "status === 'draft' ? saved : " : ""}await (await fetch(detail)).json();
          document.querySelector('#revision').textContent = course.status + ' · Revision ' + course.revision;
          draft.hidden = true;
          publish.hidden = true;
          feedback.textContent = status === 'draft' ? 'Course moved to draft.' : 'Course published.';
        };
        draft.onclick = () => update(${target.revision}, 'draft');
        document.querySelector('#review').onclick = async () => {
          const result = await (await fetch(readiness)).json();
          feedback.textContent = result.ready ? 'Ready to publish' : 'Resolve these items before publishing';
          publish.hidden = !result.ready && ${JSON.stringify(scenario !== "enabled-blocked")};
        };
        publish.onclick = () => update(${target.revision + Number(scenario !== "wrong-publish-revision")}, 'published');
        </script>`;
      let allowReadback;
      const readbackAllowed = new Promise(resolve => { allowReadback = resolve; });
      if (scenario !== "success" || outcome !== "published") allowReadback();
      const send = (route, payload, requestId) => route.fulfill({ status: 200, body: JSON.stringify(payload),
        headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId } });
      let course = { ...ownedDraftResponse.course, id: target.courseId, status: "archived", revision: target.revision };
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== input.browserOrigin) return route.abort();
        if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: document });
        effects.push(method + " " + url.pathname);
        if (url.pathname === readiness) return send(route, scenario === "stale-readiness" ? { ...response, courseRevision: target.revision }
          : scenario === "wrong-issues" ? { ...response, issues: response.issues.slice(0, 1) } : response, receipt.readiness.requestId);
        if (method === "PATCH") {
          const status = request.postDataJSON().status;
          course = { ...course, status, revision: target.revision + (status === "draft" ? 1 : 2) };
          return send(route, { course }, status === "draft" ? receipt.draft.requestId : receipt.publication?.requestId ?? randomUUID());
        }
        if (method === "GET" && course.status === "published") await readbackAllowed;
        const stale = scenario === "stale-draft-readback" && course.status === "draft" || scenario === "stale-published-readback" && course.status === "published";
        return send(route, { course: stale ? { ...course, revision: course.revision - 1 } : course }, randomUUID());
      });
      const page = await context.newPage(), watch = watchP2AuthoringMutation(context, page, input);
      await page.goto(input.browserOrigin + p2InteractiveBrowserEntryPath(input, "owner"));
      return { ...fixture, page, watch, effects, allowReadback, expires: Math.floor(Date.now() / 1000) + 60,
        draft: page.getByRole("button", { name: "Move to draft", exact: true }),
        review: page.getByRole("button", { name: "Review publication readiness", exact: true }),
        publish: page.getByRole("button", { name: "Publish course", exact: true }),
        close: async () => { allowReadback(); watch.close(); await context.close(); } };
    };
    const draftAndReview = async (owned, scenario) => {
      if (scenario !== "early-review") {
        await owned.draft.click();
        await owned.page.getByRole("status").getByText("Course moved to draft.", { exact: true }).waitFor();
        if (scenario === "alternate-write") await owned.page.evaluate(async () => { await fetch("/api/admin/other", { method: "POST" }); });
      }
      await owned.review.click();
    };
    try {
      for (const outcome of ["blocked", "published"]) {
        const owned = await open(outcome, "success");
        try {
          await draftAndReview(owned);
          const expected = ["PATCH " + owned.detail, "GET " + owned.detail, "GET " + owned.readiness];
          if (outcome === "published") {
            await Promise.all([owned.page.waitForRequest(request => request.url().endsWith(owned.detail) && request.method() === "GET"), owned.publish.click()]);
            assert.throws(() => owned.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
            owned.allowReadback();
            expected.push("PATCH " + owned.detail, "GET " + owned.detail);
          }
          await owned.watch.wait(owned.expires);
          assert.deepEqual(owned.watch.finish(), owned.receipt);
          assert.deepEqual(owned.effects, expected);
          await Promise.all([owned.page.waitForResponse(response => response.url().endsWith(owned.readiness)), owned.review.click()]);
          assert.throws(() => owned.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await owned.close(); }
      }
      for (const [outcome, scenario] of [["blocked", "early-review"], ["blocked", "missing-draft-readback"], ["blocked", "stale-draft-readback"],
        ["blocked", "stale-readiness"], ["blocked", "wrong-issues"], ["blocked", "enabled-blocked"], ["published", "wrong-publish-revision"],
        ["published", "stale-published-readback"], ["blocked", "alternate-write"]]) {
        const rejected = await open(outcome, scenario);
        try {
          await draftAndReview(rejected, scenario);
          if (outcome === "published") await rejected.publish.click();
          await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium quiz save captures first and later revisions and refuses tampered observations",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const open = async (quizRevision, scenario) => {
      const fixture = ownedQuiz(quizRevision), { input, target, pathname, posted, prior, saved, receipt } = fixture;
      const detail = "/api" + p2InteractiveBrowserEntryPath(input, "owner"), context = await browser.newContext(), effects = [];
      const submitted = scenario === "raw-drift" ? { document: posted.document, expectedCourseRevision: target.revision } : posted;
      const document = `<!doctype html><meta charset="utf-8"><p id="revision">draft · Revision ${target.revision}</p>
        <button id="open">Assessment</button><button id="save" hidden>Save new quiz revision</button><button id="reload" hidden>Complete readback</button>
        <div role="status"><p></p></div><script>
        const quizPath = ${JSON.stringify(pathname)}, detail = ${JSON.stringify(detail)}, save = document.querySelector('#save'), reload = document.querySelector('#reload');
        document.querySelector('#open').onclick = async () => {
          const result = await fetch(quizPath);
          if (result.ok) await result.json();
          save.hidden = false;
        };
        save.onclick = async () => {
          const result = await fetch(${JSON.stringify(scenario === "wrong-path" ? pathname + "/other" : pathname)},
            {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(submitted)})});
          await result.json();
          reload.hidden = false;
        };
        reload.onclick = async () => {
          const result = await (await fetch(detail)).json();
          document.querySelector('#revision').textContent = 'draft · Revision ' + result.course.revision;
          document.querySelector('[role="status"] p').textContent = 'Quiz revision saved. Previous attempts remain in history.';
        };
        </script>`;
      const send = (route, payload, requestId, status = 200) => route.fulfill({ status, body: JSON.stringify(payload),
        headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId } });
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: document });
        effects.push(request.method() + " " + url.pathname);
        if (url.pathname === pathname && request.method() === "GET") {
          const payload = quizRevision === 0 ? { error: { code: "not_found", message: "not found" }, requestId: receipt.prior.requestId }
            : { quiz: { ...prior, ...(scenario === "wrong-prior" ? { courseRevision: prior.courseRevision - 1 } : {}) } };
          return send(route, payload, receipt.prior.requestId, receipt.prior.status);
        }
        if (request.method() === "PUT") {
          const changed = scenario === "wrong-actor" ? { createdBy: randomUUID() } : scenario === "wrong-document"
            ? { document: { ...saved.document, questions: saved.document.questions.map(question => ({ ...question, feedback: "Tampered feedback" })) } }
            : scenario === "wrong-next" ? { revision: saved.revision + 1 } : scenario === "reused-id" ? { id: prior.id } : {};
          return send(route, { quiz: { ...saved, ...changed } }, receipt.save.requestId);
        }
        return send(route, { course: { revision: target.revision + 1 } }, randomUUID());
      });
      const page = await context.newPage();
      const selected = scenario === "wrong-reviewed-document" ? { ...input, authoring: { ...target, documentSha256: "1".repeat(64) } } : input;
      const watch = watchP2AuthoringMutation(context, page, selected);
      await page.goto(input.browserOrigin + p2InteractiveBrowserEntryPath(input, "owner"));
      return { ...fixture, detail, effects, page, watch, expires: Math.floor(Date.now() / 1000) + 60,
        assessment: page.getByRole("button", { name: "Assessment", exact: true }),
        save: page.getByRole("button", { name: "Save new quiz revision", exact: true }),
        readback: page.getByRole("button", { name: "Complete readback", exact: true }),
        close: async () => { watch.close(); await context.close(); } };
    };
    try {
      for (const revision of [0, 3]) {
        const owner = await open(revision);
        try {
          await owner.assessment.click();
          await owner.save.click();
          await owner.readback.waitFor({ state: "visible" });
          assert.throws(() => owner.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
          await owner.readback.click();
          await owner.watch.wait(owner.expires);
          const result = owner.watch.finish();
          assert.deepEqual(result, owner.receipt);
          assert.equal(JSON.stringify(result).includes("Private"), false);
          assert.deepEqual(owner.effects, ["GET " + owner.pathname, "PUT " + owner.pathname, "GET " + owner.detail]);
          await Promise.all([owner.page.waitForResponse(response => response.url().endsWith(owner.pathname) && response.request().method() === "PUT"),
            owner.save.click()]);
          assert.throws(() => owner.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await owner.close(); }
      }
      for (const scenario of ["wrong-prior", "wrong-actor", "wrong-document", "wrong-next", "reused-id", "raw-drift",
        "wrong-reviewed-document", "wrong-source", "wrong-path", "early-put"]) {
        const rejected = await open(3, scenario);
        try {
          if (scenario === "early-put") await rejected.page.evaluate(async ({ path, body }) => {
            await (await fetch(path, { method: "PUT", body: JSON.stringify(body) })).json();
          }, { path: rejected.pathname, body: rejected.posted });
          else {
            if (scenario === "wrong-source") await rejected.page.goto(rejected.input.browserOrigin + "/admin/courses/" + randomUUID());
            await rejected.assessment.click();
            await rejected.save.click();
          }
          const expires = scenario === "wrong-path" ? Math.floor(Date.now() / 1000) + 2 : rejected.expires;
          await assert.rejects(rejected.watch.wait(expires), /AUTHORING_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium free enrollment qualifies the exact grant and canonical protected course arrival",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const open = async scenario => {
      const fixture = ownedLearning(), { input, target, receipt, coursePath, academyPath, pathname } = fixture;
      const context = await browser.newContext();
      const destination = scenario === "wrong-destination" ? "/academy/courses/" + randomUUID() : academyPath;
      const apiPath = scenario === "wrong-api-path" ? pathname + "/other" : pathname;
      const key = scenario === "wrong-key" ? randomUUID() : target.idempotencyKey;
      const grant = scenario === "replayed" ? { ...receipt.body, idempotentReplay: true }
        : scenario === "wrong-course" ? { ...receipt.body, courseId: randomUUID() } : receipt.body;
      const courseDocument = `<!doctype html><main><button>Enroll for free</button></main><script>
        document.querySelector('button').onclick = async () => {
          const result = await fetch(${JSON.stringify(apiPath)}, {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({idempotencyKey:${JSON.stringify(key)}})});
          await result.json();
          const destination = ${JSON.stringify(destination)}, page = await (await fetch(destination)).text();
          history.pushState(null, '', destination);
          document.querySelector('main').innerHTML = page;
        };</script>`;
      let allowDestination;
      const destinationReady = new Promise(resolve => { allowDestination = resolve; });
      if (scenario !== "success") allowDestination();
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== input.browserOrigin) return route.abort();
        if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: courseDocument });
        if (request.method() === "POST") return route.fulfill({ status: 200, body: JSON.stringify(grant),
          headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": receipt.requestId } });
        await destinationReady;
        return route.fulfill({ status: 200, contentType: "text/html", body: scenario === "wrong-link"
          ? '<a href="/courses/other-course">Course overview</a>' : `<a href="${coursePath}">Course overview</a>` });
      });
      const page = await context.newPage(), watch = watchP2LearningEnrollment(context, page, input);
      await page.goto(input.browserOrigin + coursePath);
      const enroll = page.getByRole("button", { name: "Enroll for free", exact: true });
      return { ...fixture, page, watch, enroll, allowDestination, expires: Math.floor(Date.now() / 1000) + 60,
        close: async () => { allowDestination(); watch.close(); await context.close(); } };
    };
    try {
      const learner = await open("success");
      try {
        await Promise.all([learner.page.waitForRequest(request => request.url() === learner.input.browserOrigin + learner.academyPath), learner.enroll.click()]);
        assert.throws(() => learner.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
        learner.allowDestination();
        await learner.watch.wait(learner.expires);
        assert.deepEqual(learner.watch.finish(), learner.receipt);
        assert.equal(JSON.stringify(learner.watch.finish()).includes(learner.target.idempotencyKey), false);
        await learner.page.evaluate(async ({ pathname, idempotencyKey }) => {
          await (await fetch(pathname, { method: "POST", body: JSON.stringify({ idempotencyKey }) })).json();
        }, { pathname: learner.pathname, idempotencyKey: learner.target.idempotencyKey });
        assert.throws(() => learner.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
      } finally { await learner.close(); }
      for (const scenario of ["wrong-key", "replayed", "wrong-course", "wrong-destination", "wrong-link", "wrong-api-path", "wrong-source"]) {
        const rejected = await open(scenario);
        try {
          if (scenario === "wrong-source") await rejected.page.goto(rejected.input.browserOrigin + "/courses/other-course");
          await rejected.enroll.click();
          const expires = ["wrong-link", "wrong-api-path"].includes(scenario) ? Math.floor(Date.now() / 1000) + 2 : rejected.expires;
          await assert.rejects(rejected.watch.wait(expires), /LEARNING_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium free-enrollment replay sends one scoped POST from the unchanged academy page",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const open = async scenario => {
      const fixture = ownedLearningReplay(), { input, target, receipt, coursePath, pathname } = fixture;
      const context = await browser.newContext(), effects = [];
      const selectedActor = scenario === "wrong-actor" ? randomUUID() : target.actorId;
      await context.addCookies([{ name: "owned-customer", value: selectedActor, url: input.browserOrigin + "/" }]);
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        if (url.origin !== input.browserOrigin) return route.abort();
        if (request.isNavigationRequest()) {
          effects.push({ method, target: url.pathname });
          return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><h1>Owned enrolled course</h1>
            <a href="${scenario === "wrong-overview" ? "/courses/wrong" : coursePath}">Course overview</a>
            <script>const fetchOriginal = window.fetch; window.fetch = (target, options) => {
              if (target === ${JSON.stringify(pathname)} && options?.method === 'POST') throw new Error('Owned main-world wrapper');
              return fetchOriginal(target, options);
            };</script>` });
        }
        if (!url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, body: "" });
        effects.push({ method, target: url.pathname + url.search });
        if (url.pathname !== pathname || method !== "POST") return route.fulfill({ status: 404, body: "" });
        const sameActor = (await request.headerValue("cookie"))?.includes(`owned-customer=${target.actorId}`) === true;
        Object.assign(effects.at(-1), { sameActor, key: request.postData(), csrf: await request.headerValue("x-lash-csrf") });
        if (scenario === "redirect") return route.fulfill({ status: 302, headers: { location: "/api/academy/other" } });
        const changes = scenario === "new-grant" ? { grantId: randomUUID() } : scenario === "new-enrollment" ? { enrollmentId: randomUUID() }
          : scenario === "fresh-body" ? { idempotentReplay: false } : scenario === "extra-body" ? { idempotencyKey: target.idempotencyKey } : {};
        return route.fulfill({ status: sameActor ? 200 : 403, body: JSON.stringify({ ...receipt.body, ...changes }), headers: {
          "content-type": "application/json", "cache-control": scenario === "public-cache" ? "public" : "private, no-store",
          "x-request-id": scenario === "wrong-id" ? "not-a-gateway-id" : receipt.requestId,
        } });
      });
      const page = await context.newPage(), watch = watchP2LearningEnrollment(context, page, input);
      return { ...fixture, page, watch, effects, expires: Math.floor(Date.now() / 1000) + 60,
        close: async () => { watch.close(); await context.close(); } };
    };
    try {
      const owned = await open("success");
      try {
        await owned.watch.open(owned.expires);
        const navigation = { method: "GET", target: owned.academyPath };
        assert.deepEqual(owned.effects, [navigation]);
        assert.throws(() => owned.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
        await owned.watch.wait(owned.expires);
        assert.deepEqual(owned.watch.finish(), owned.receipt);
        assert.equal(owned.page.url(), owned.input.browserOrigin + owned.academyPath);
        assert.deepEqual(owned.effects, [navigation, { method: "POST", target: owned.pathname, sameActor: true,
          key: JSON.stringify({ idempotencyKey: owned.target.idempotencyKey }), csrf: "1" }]);
        assert.equal(JSON.stringify(owned.watch.finish()).includes(owned.target.idempotencyKey), false);
        await owned.page.evaluate(() => fetch("/api/academy/alternate"));
        assert.throws(() => owned.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
      } finally { await owned.close(); }
      for (const scenario of ["wrong-actor", "new-grant", "new-enrollment", "fresh-body", "extra-body", "public-cache", "wrong-id", "redirect", "wrong-overview", "unexpected-api"]) {
        const rejected = await open(scenario);
        try {
          if (scenario === "wrong-overview") {
            await assert.rejects(rejected.watch.open(Math.floor(Date.now() / 1000) + 2), /LEARNING_RESPONSE_REFUSED/u);
          } else {
            await rejected.watch.open(rejected.expires);
            if (scenario === "unexpected-api") await rejected.page.evaluate(() => fetch("/api/academy/alternate", { method: "POST" }));
            await assert.rejects(rejected.watch.wait(rejected.expires), /LEARNING_RESPONSE_REFUSED/u);
          }
          assert.equal(rejected.effects.filter(effect => effect.target === rejected.pathname).length,
            ["wrong-overview", "unexpected-api"].includes(scenario) ? 0 : 1);
          assert.throws(() => rejected.watch.finish(), /LEARNING_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

function ownedLessonEntry() {
  const target = { actorId: userId, operation: "open-lesson", courseId: ownedCourseId, lessonId: randomUUID(), grantId: randomUUID() };
  const input = interactiveInput({ stage: "lesson-entry", lessonEntry: target });
  const paths = p2LessonEntryPaths(target), expiresAt = "2026-11-06T12:10:00.000Z";
  const receipt = { page: { pathname: paths.lessonPath, flight: true },
    playback: { requestId: randomUUID(), expiresAt, thumbnailExpiresAt: expiresAt, lifetimeMs: 600_000 },
    progress: { requestId: randomUUID(), progressId: randomUUID(), enrollmentId: randomUUID(), revision: 1 } };
  return { target, input, receipt, ...paths };
}

test("lesson entry permit and compact receipt bind the exact actor, course, lesson and Flight arrival", () => {
  const { target, input, receipt, academyPath } = ownedLessonEntry(), permit = interactivePermit(input);
  assert.equal(validateP2InteractiveBrowserInput(input), input);
  assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
  assert.equal(permit.cookie.split(".")[6], (target.actorId + target.courseId + target.lessonId).replaceAll("-", ""));
  assert.equal(p2InteractiveBrowserEntryPath(input, "learner"), academyPath);
  assert.throws(() => p2InteractiveBrowserEntryPath(input, "owner"));
  assert.deepEqual(validateP2LessonEntryReceipt(receipt, target), receipt);
  for (const name of ["actorId", "courseId", "lessonId"]) {
    const other = { ...input, lessonEntry: { ...target, [name]: randomUUID() } };
    assert.throws(() => validateP2InteractiveBrowserPermit(interactivePermit(other), input));
  }
  for (const change of [{ page: { ...receipt.page, flight: false } }, { playback: { ...receipt.playback, lifetimeMs: 601_001 } },
    { progress: { ...receipt.progress, revision: 2 } }, { progress: { ...receipt.progress, requestId: receipt.playback.requestId } }]) {
    assert.throws(() => validateP2LessonEntryReceipt({ ...receipt, ...change }, target));
  }
});

test("owned Chromium lesson entry captures a trusted Flight click and native initial playback and progress",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright"), root = mkdtempSync(join(tmpdir(), "owned-p2-lesson-entry-"));
    const host = new URL(interactiveInput().browserOrigin).hostname, key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
    let browser, https, proxy, proxyPort, serve;
    const track = socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
    const bind = async server => {
      server.on("connection", track);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    };
    const open = async scenario => {
      const fixture = ownedLessonEntry(), { input, target, receipt, academyPath, lessonPath, playbackPath, progressPath } = fixture;
      const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true });
      await context.addCookies([{ name: "owned-customer", value: "fixture-session", url: input.browserOrigin + "/" }]);
      const effects = [], date = new Date(at).toUTCString();
      const document = `<!doctype html><main><h1>Owned academy course</h1><a href="${lessonPath}"><span>Owned lesson title</span><span>Open lesson</span></a></main>
        <script>
          const lesson = ${JSON.stringify(lessonPath)}, flight = lesson + '?_rsc=fixture';
          void fetch('/courses?_rsc=other', {headers:{rsc:'1','next-router-prefetch':'1'}});
          ${scenario === "prefetch" ? `void fetch(flight, {headers:{rsc:'1','next-router-prefetch':'1'}});` : ""}
          document.querySelector('a').onclick = async event => {
            if (${JSON.stringify(scenario === "document-fallback")}) return;
            event.preventDefault();
            const selected = await fetch(flight, {headers:{rsc:'1','next-router-state-tree':'fixture'}});
            await selected.text();
            history.pushState(null, '', lesson);
            document.querySelector('main').innerHTML = '<h1>Owned lesson title</h1><div aria-live="polite"></div>';
            const media = fetch(${JSON.stringify(playbackPath)}, {cache:'no-store'}).then(response => response.json());
            const progress = fetch(${JSON.stringify(progressPath)}, {method:'POST',cache:'no-store',headers:{'content-type':'application/json','x-lash-csrf':'1'},
              body:JSON.stringify({event:'lesson_started',expectedProgressRevision:${scenario === "wrong-revision" ? 1 : 0}})}).then(response => response.json());
            await Promise.all([media, progress]);
            document.querySelector('[aria-live]').textContent = 'Progress saved to your account.';
            ${scenario === "missing-player" ? "" : "document.querySelector('main').append(document.createElement('mux-player'));"}
          };
        </script>`;
      serve = (request, response) => {
        const send = (status, headers, body) => response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) }).end(body);
        const url = new URL(request.url, input.browserOrigin);
        if (url.pathname === academyPath) return send(200, { "content-type": "text/html",
          "cache-control": scenario === "public-document" ? "public" : "private, no-store" }, document);
        if (url.pathname === lessonPath) {
          effects.push({ method: request.method, pathname: url.pathname, flight: request.headers.rsc ?? null });
          return send(200, { "content-type": request.headers.rsc === "1" ? "text/x-component" : "text/html",
            "cache-control": scenario === "public-flight" ? "public" : "private, no-store", vary: scenario === "wrong-vary" ? "Accept-Encoding" : "RSC" }, "owned flight");
        }
        const playback = url.pathname === playbackPath;
        if (!playback && url.pathname !== progressPath) return send(404, { "content-type": "text/plain" }, "");
        effects.push({ method: request.method, pathname: url.pathname, credentialed: request.headers.cookie?.includes("owned-customer=fixture-session") === true });
        const body = playback ? { playbackId: "private-media-id", playbackToken: "private-media-token".repeat(3), thumbnailToken: "private-thumbnail-token".repeat(3),
          expiresAt: receipt.playback.expiresAt, thumbnailExpiresAt: receipt.playback.thumbnailExpiresAt }
          : { progress: { id: receipt.progress.progressId, userId: scenario === "wrong-actor" ? randomUUID() : target.actorId, lessonId: target.lessonId,
            enrollmentId: receipt.progress.enrollmentId, maxPositionSeconds: 0, resumePositionSeconds: 0, revision: 1,
            completedQuizRevision: null, completedAt: null, lastWatchedAt: null, createdAt: at, updatedAt: at } };
        request.resume();
        return send(200, { "content-type": "application/json", "cache-control": scenario === "public-cache" ? "public" : "private, no-store", date,
          "x-request-id": playback ? receipt.playback.requestId : receipt.progress.requestId }, JSON.stringify(body));
      };
      const page = await context.newPage(), watch = watchP2LessonEntry(context, page, input);
      return { ...fixture, page, watch, effects, expires: Math.floor(Date.now() / 1000) + 60,
        close: async () => { watch.close(); await context.close(); } };
    };
    try {
      assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", `/CN=${host}`, "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
      https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
        if (!serve || request.headers.host !== host) return response.writeHead(403).end();
        serve(request, response);
      });
      const tlsPort = await bind(https);
      proxy = createHttpServer((_request, response) => response.writeHead(403).end());
      proxy.on("connect", (request, socket, head) => {
        if (request.url !== `${host}:443`) { socket.destroy(); return; }
        const target = connect(tlsPort, "127.0.0.1");
        track(target);
        target.once("error", () => socket.destroy());
        socket.once("error", () => target.destroy());
        target.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
        });
      });
      proxyPort = await bind(proxy);
      browser = await chromium.launch();
      const owned = await open("success");
      try {
        await owned.watch.open(owned.expires);
        assert.deepEqual(owned.effects, []);
        await owned.watch.wait(owned.expires);
        assert.deepEqual(owned.watch.finish(), owned.receipt);
        assert.equal(owned.page.url(), owned.input.browserOrigin + owned.lessonPath);
        assert.deepEqual(owned.effects[0], { method: "GET", pathname: owned.lessonPath, flight: "1" });
        assert.deepEqual(owned.effects.slice(1).sort((a, b) => a.pathname.localeCompare(b.pathname)), [
          { method: "GET", pathname: owned.playbackPath, credentialed: true }, { method: "POST", pathname: owned.progressPath, credentialed: true },
        ]);
        assert.doesNotMatch(JSON.stringify(owned.watch.finish()), /private-media|private-thumbnail|fixture-session/u);
        await owned.page.evaluate(() => fetch("/api/academy/alternate"));
        assert.throws(() => owned.watch.finish(), /LESSON_ENTRY_RESPONSE_REFUSED/u);
      } finally { await owned.close(); }
      for (const scenario of ["prefetch", "document-fallback", "wrong-revision", "wrong-actor", "public-cache", "public-document", "public-flight", "wrong-vary", "missing-player"]) {
        const rejected = await open(scenario), expires = Math.floor(Date.now() / 1000) + 3;
        try {
          await assert.rejects(async () => { await rejected.watch.open(expires); await rejected.watch.wait(expires); }, /LESSON_ENTRY_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /LESSON_ENTRY_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, https].filter(server => server?.listening).map(server => new Promise(done => server.close(done))));
      rmSync(root, { recursive: true, force: true });
    }
  });

test("owned Chromium paid-grant capture binds approved request, audit, grant and visible confirmation",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const { target, input, pathname, submitted, response, receipt } = ownedPaidGrant();
    const headers = { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": receipt.requestId };
    const feedback = "Manual grant and audit confirmed. Community access has not been verified yet.";
    const document = `<!doctype html><section aria-label="Manual course access"><p>Selected published paid course revision: ${target.revision}.</p>
      <form><label>Customer UUID<input name="userId"></label><label>Grant reason<textarea name="reason"></textarea></label>
      <button>Grant manual access</button></form><button id="confirm" hidden>Show confirmation</button><p role="status"></p></section><script>
      const confirm = document.querySelector('#confirm');
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const result = await fetch(${JSON.stringify(pathname)}, {method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({userId:form.get('userId'),reason:form.get('reason'),expectedCourseRevision:${target.revision},
            idempotencyKey:${JSON.stringify(target.idempotencyKey)}})});
        await result.json();
        confirm.hidden = false;
      };
      confirm.onclick = () => { document.querySelector('[role="status"]').textContent = ${JSON.stringify(feedback)}; };
      </script>`;
    const open = (body = response, status = 200, html) => ownedMutationPage(browser, input, pathname, "owner",
      { status, headers, body: JSON.stringify(body) }, watchP2PaidGrant, html);
    try {
      const owner = await open(response, 200, document);
      try {
        await owner.page.getByRole("textbox", { name: "Customer UUID", exact: true }).fill(submitted.userId);
        await owner.page.getByRole("textbox", { name: "Grant reason", exact: true }).fill(submitted.reason);
        await owner.page.getByRole("button", { name: "Grant manual access", exact: true }).click();
        const confirmation = owner.page.getByRole("button", { name: "Show confirmation", exact: true });
        await confirmation.waitFor({ state: "visible" });
        assert.throws(() => owner.watch.finish(), /PAID_GRANT_RESPONSE_REFUSED/u);
        await confirmation.click();
        await owner.watch.wait(owner.expires);
        assert.deepEqual(owner.watch.finish(), receipt);
        const serialized = JSON.stringify(owner.watch.finish());
        assert.equal(serialized.includes(submitted.reason.trim()), false);
        assert.equal(serialized.includes(target.idempotencyKey), false);
        await owner.post(pathname, submitted);
        assert.throws(() => owner.watch.finish(), /PAID_GRANT_RESPONSE_REFUSED/u);
      } finally { await owner.close(); }

      for (const scenario of [
        { submitted: { ...submitted, reason: "Different reason" } },
        { submitted: { ...submitted, expectedCourseRevision: target.revision + 1 } },
        { submitted: { ...submitted, userId: randomUUID() } },
        { submitted: { ...submitted, idempotencyKey: randomUUID() } },
        { source: "/admin/courses/" + randomUUID() + "/manual-grants" },
        { pathname: pathname + "?unexpected=1" },
        { body: { ...response, command: { ...response.command, reason: "Different reason" } } },
        { body: { ...response, command: { ...response.command, actorUserId: randomUUID() } } },
        { body: { ...response, command: { ...response.command, effects: [{ ...response.command.effects[0], grantId: randomUUID() }] } } },
        { body: { ...response, grant: { ...response.grant, orderId: randomUUID() } } },
        { body: { ...response, grant: { ...response.grant, externalPaymentId: "payment", provider: "square" } } },
        { body: { ...response, mutationRetried: true } },
        { body: { ...response, communityDeliveryVerified: true } },
        { body: { ...response, state: "accepted-needs-review" }, status: 202 },
        { unconfirmed: true },
      ]) {
        const rejected = await open(scenario.body, scenario.status);
        try {
          if (scenario.source) await rejected.page.goto(input.browserOrigin + scenario.source);
          await rejected.post(scenario.pathname ?? pathname, scenario.submitted ?? submitted);
          const expires = scenario.unconfirmed ? Math.floor(Date.now() / 1000) + 2 : rejected.expires;
          await assert.rejects(rejected.watch.wait(expires), /PAID_GRANT_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /PAID_GRANT_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium paid revocation requires trusted checkbox confirmation and the exact audited grant",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const { target, input, pagePath, pathname, submitted, response, receipt } = ownedPaidRevoke();
    const feedback = "Manual revocation and audit confirmed. Community access has not been verified yet.";
    const open = async (scenario, body = response, status = 200) => {
      const context = await browser.newContext(), requests = [];
      const document = `<!doctype html><section aria-label="Revoke manual course access"><p>Selected paid course revision: ${target.revision}.</p>
        <form><label>Customer UUID<input name="userId"></label><label>Grant UUID<input name="grantId"></label>
        <label>Revocation reason<textarea name="reason"></textarea></label><label><input type="checkbox">Confirm grant revocation</label>
        <button>Revoke manual access</button></form><button id="show" hidden>Show confirmation</button><p role="status"></p></section><script>
        const show = document.querySelector('#show');
        document.querySelector('form').onsubmit = async event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const result = await fetch(${JSON.stringify(scenario === "wrong-path" ? pathname + "/other" : pathname)},
            {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:form.get('userId'),grantId:form.get('grantId'),
            expectedCourseRevision:${target.revision},reason:form.get('reason'),idempotencyKey:${JSON.stringify(target.idempotencyKey)}})});
          await result.json();
          show.hidden = false;
        };
        show.onclick = () => { document.querySelector('[role="status"]').textContent = ${JSON.stringify(feedback)}; };
        </script>`;
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== input.browserOrigin) return route.abort();
        if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: document });
        requests.push({ method: request.method(), pathname: url.pathname });
        return route.fulfill({ status, body: JSON.stringify(body), headers: { "content-type": "application/json",
          "cache-control": "private, no-store", "x-request-id": receipt.requestId } });
      });
      const page = await context.newPage(), watch = watchP2PaidRevoke(context, page, input);
      await installP2PaidRevokeObserver(page, input);
      await page.goto(input.browserOrigin + (scenario === "wrong-source" ? pagePath + "/other" : pagePath));
      return { page, watch, requests, expires: Math.floor(Date.now() / 1000) + 60,
        checkbox: page.getByRole("checkbox", { name: "Confirm grant revocation", exact: true }),
        submit: page.getByRole("button", { name: "Revoke manual access", exact: true }),
        show: page.getByRole("button", { name: "Show confirmation", exact: true }),
        close: async () => { watch.close(); await context.close(); } };
    };
    const submit = async (owned, scenario) => {
      await owned.page.getByRole("textbox", { name: "Customer UUID", exact: true }).fill(submitted.userId);
      await owned.page.getByRole("textbox", { name: "Grant UUID", exact: true }).fill(scenario === "wrong-grant" ? randomUUID() : submitted.grantId);
      await owned.page.getByRole("textbox", { name: "Revocation reason", exact: true }).fill(scenario === "wrong-reason" ? "Different reason" : submitted.reason);
      if (scenario !== "unchecked") await owned.checkbox.check();
      if (scenario === "synthetic") await owned.page.evaluate(() => {
        const form = document.querySelector("form");
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: form.querySelector("button") }));
      });
      else await owned.submit.click();
      await owned.show.waitFor({ state: "visible" });
    };
    try {
      const owner = await open("success");
      try {
        await submit(owner, "success");
        assert.throws(() => owner.watch.finish(), /PAID_REVOKE_RESPONSE_REFUSED/u);
        await owner.show.click();
        await owner.watch.wait(owner.expires);
        assert.deepEqual(owner.watch.finish(), receipt);
        assert.deepEqual(owner.requests, [{ method: "POST", pathname }]);
        assert.doesNotMatch(JSON.stringify(owner.watch.finish()), /Private approved revocation reason/u);
        assert.equal(JSON.stringify(owner.watch.finish()).includes(target.idempotencyKey), false);
        await owner.page.evaluate(async ({ pathname, submitted }) => {
          await (await fetch(pathname, { method: "POST", body: JSON.stringify(submitted) })).json();
        }, { pathname, submitted });
        assert.throws(() => owner.watch.finish(), /PAID_REVOKE_RESPONSE_REFUSED/u);
      } finally { await owner.close(); }

      for (const [scenario, body, status] of [["unchecked"], ["synthetic"], ["wrong-path"], ["wrong-source"], ["wrong-grant"], ["wrong-reason"],
        ["wrong-grant-receipt", { ...response, grant: { ...response.grant, grantId: randomUUID() } }],
        ["wrong-status", { ...response, grant: { ...response.grant, status: "active" } }],
        ["financial-reference", { ...response, grant: { ...response.grant, externalPaymentId: "private-payment" } }],
        ["community-claim", { ...response, communityDeliveryVerified: true }],
        ["unconfirmed", { ...response, state: "accepted-needs-review" }, 202]]) {
        const rejected = await open(scenario, body, status);
        try {
          await submit(rejected, scenario);
          await rejected.show.click();
          await assert.rejects(rejected.watch.wait(rejected.expires), /PAID_REVOKE_RESPONSE_REFUSED/u);
          assert.throws(() => rejected.watch.finish(), /PAID_REVOKE_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally { await browser.close(); }
  });

test("owned Chromium paid learner access checks the normal page and exact credentialed read-only endpoints",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    // Exercise native Fetch and the network observer against actual HTTPS.
    const root = mkdtempSync(join(tmpdir(), "owned-p2-learner-tls-"));
    const key = join(root, "key.pem"), cert = join(root, "cert.pem"), sockets = new Set();
    const host = new URL(interactiveInput().browserOrigin).hostname;
    let browser, https, proxy, proxyPort, serve;
    const track = socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    const bind = async server => {
      server.on("connection", track);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    };
    const open = async (outcome, scenario) => {
      const fixture = ownedPaidLearnerAccess(outcome), { input, target, targets, receipt, pagePath, lessonPath } = fixture;
      const expected = ownedAccessOutcomes[outcome], effects = [];
      const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${proxyPort}` }, ignoreHTTPSErrors: true });
      const now = Math.floor(Date.now() / 1000) * 1000, date = new Date(now).toUTCString(), expiresAt = new Date(now + 600_000).toISOString();
      const moduleId = randomUUID(), lesson = { id: target.lessonId, moduleId, isPreview: false, title: "Private lesson text" };
      const question = { id: "question", prompt: "Private question", options: [{ id: "first", text: "First" }, { id: "second", text: "Second" }] };
      const bodies = [
        { course: { id: target.courseId, accessMode: "paid", currency: "CAD", priceCents: 100, modules: [{ id: moduleId, lessons: [lesson] }] } },
        { lesson: scenario === "preview" ? { ...lesson, isPreview: true } : scenario === "stream-forgery" ? { ...lesson, id: randomUUID() } : lesson },
        { playbackId: "private-playback-id", playbackToken: "private-playback-token".repeat(3), thumbnailToken: "private-thumbnail-token".repeat(3),
          expiresAt, thumbnailExpiresAt: scenario === "long-thumbnail" ? new Date(now + 700_000).toISOString() : expiresAt },
        { progress: [{ id: randomUUID(), userId: scenario === "foreign-progress" ? randomUUID() : target.actorId, lessonId: target.lessonId,
          enrollmentId: randomUUID(), resumePositionSeconds: 45 }] },
        { quiz: { id: randomUUID(), lessonId: target.lessonId, revision: 2, document: { version: 1, mode: "graded", passingPercent: 80,
          questions: [scenario === "answer-key" ? { ...question, correctOptionId: "first" } : question] } } },
        { attempts: [{ id: randomUUID(), lessonId: target.lessonId, quizRevisionId: randomUUID(), results: [{ feedback: "Private feedback" }] }] },
      ];
      const forgedLesson = JSON.stringify({ lesson });
      if (scenario === "stream-forgery") assert.equal(Buffer.byteLength(forgedLesson), Buffer.byteLength(JSON.stringify(bodies[1])));
      const document = `<!doctype html><script src="/_next/static/owned-asset.js"></script>
        <script>
          fetch('/courses/owned-link-prefetch?_rsc=fixture');
          const fixtureFetch = window.fetch;
          window.fetch = (target, options) => {
            if (target === ${JSON.stringify(targets[0])}) throw new Error('Owned page fetch wrapper');
            return fixtureFetch(target, options);
          };
          ${scenario === "page-header-override" ? `const fixtureGetHeader = Headers.prototype.get;
            Headers.prototype.get = function(name) {
              return name === 'x-request-id' ? ${JSON.stringify(randomUUID())} : fixtureGetHeader.call(this, name);
            };` : ""}
          ${scenario === "stream-forgery" ? `const fixtureBody = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;
            Object.defineProperty(Response.prototype, 'body', { get() {
              if (this.url.endsWith(${JSON.stringify(targets[1])})) {
                return new ReadableStream({ start(controller) {
                  controller.enqueue(new TextEncoder().encode(${JSON.stringify(forgedLesson)}));
                  controller.close();
                } });
              }
              return fixtureBody.call(this);
            } });` : ""}
        </script>
        <h1>${outcome === "allowed" ? "Owned paid course" : scenario === "wrong-heading" ? "Sign in to continue" : expected.heading}</h1>
        ${outcome === "allowed" || scenario === "leaked-link" ? `<a href="${lessonPath}">Open lesson</a>` : ""}`;
      await context.addCookies([{ name: "owned-customer", value: "fixture-session", url: input.browserOrigin + "/" }]);
      serve = (request, response) => {
        const send = (status, headers, body = "") => response.writeHead(status, { ...headers, "content-length": Buffer.byteLength(body) }).end(body);
        if (request.method === "GET" && request.url === pagePath) return send(200, { "content-type": "text/html" }, document);
        const index = targets.indexOf(request.url);
        if (index < 0) return send(200, { "content-type": "text/javascript" });
        effects.push({ target: targets[index], method: request.method, session: request.headers.cookie?.includes("owned-customer=fixture-session") });
        if (scenario === "redirect" && index === 0) return send(302, { location: "/api/academy/other" });
        const id = receipt.reads[index].requestId;
        const body = outcome === "allowed" ? bodies[index] : { error: { code: expected.code,
          message: scenario === "unsafe-error" ? "Private upstream detail" : expected.message }, requestId: scenario === "wrong-error-id" ? randomUUID() : id };
        const bytes = JSON.stringify(body), headers = { "content-type": "application/json", date, "x-request-id": id,
          "cache-control": scenario === "public-cache" ? "public" : "private, no-store" };
        if (scenario === "truncated" && index === 0) {
          return response.writeHead(expected.status, { ...headers, "content-length": Buffer.byteLength(bytes) + 1, connection: "close" }).end(bytes);
        }
        return send(expected.status, headers, bytes);
      };
      const page = await context.newPage(), watch = watchP2PaidLearnerAccess(context, page, input);
      return { ...fixture, page, watch, effects, expires: Math.floor(Date.now() / 1000) + 60,
        close: async () => { watch.close(); await context.close(); } };
    };
    try {
      assert.equal(spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", `/CN=${host}`, "-keyout", key, "-out", cert], { stdio: "ignore" }).status, 0);
      https = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
        if (!serve || request.headers.host !== host) return response.writeHead(403).end();
        serve(request, response);
      });
      const tlsPort = await bind(https);
      proxy = createHttpServer((_request, response) => response.writeHead(403).end());
      proxy.on("connect", (request, socket, head) => {
        if (request.url !== `${host}:443`) { socket.destroy(); return; }
        const target = connect(tlsPort, "127.0.0.1");
        track(target);
        target.once("error", () => socket.destroy());
        socket.once("error", () => target.destroy());
        target.once("connect", () => {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head.length) target.write(head);
          socket.pipe(target).pipe(socket);
        });
      });
      proxyPort = await bind(proxy);
      browser = await chromium.launch();
      for (const outcome of Object.keys(ownedAccessOutcomes)) {
        const owned = await open(outcome, outcome === "allowed" ? "page-header-override" : undefined);
        try {
          await owned.watch.open(owned.expires);
          assert.throws(() => owned.watch.finish(), /LEARNER_ACCESS_RESPONSE_REFUSED/u);
          await owned.watch.wait(owned.expires);
          const receipt = owned.watch.finish();
          assert.deepEqual(receipt, owned.receipt);
          assert.deepEqual(owned.effects, owned.targets.map(target => ({ target, method: "GET", session: true })));
          assert.doesNotMatch(JSON.stringify(receipt), /Private|private-playback|private-thumbnail|fixture-session/u);
          await owned.page.evaluate(() => fetch("/api/academy/alternate"));
          assert.throws(() => owned.watch.finish(), /LEARNER_ACCESS_RESPONSE_REFUSED/u);
        } finally { await owned.close(); }
      }

      for (const [outcome, scenario] of [["allowed", "preview"], ["allowed", "long-thumbnail"], ["allowed", "foreign-progress"],
        ["allowed", "answer-key"], ["allowed", "public-cache"], ["allowed", "redirect"], ["allowed", "stream-forgery"], ["allowed", "truncated"], ["archived", "unsafe-error"],
        ["draft", "wrong-error-id"], ["archived", "leaked-link"], ["restricted", "wrong-heading"], ["allowed", "write"], ["allowed", "navigate"]]) {
        const rejected = await open(outcome, scenario);
        try {
          if (["leaked-link", "wrong-heading"].includes(scenario)) {
            await assert.rejects(rejected.watch.open(Math.floor(Date.now() / 1000) + 2), /LEARNER_ACCESS_RESPONSE_REFUSED/u);
          } else {
            await rejected.watch.open(rejected.expires);
            if (scenario === "write") await rejected.page.evaluate(() => fetch("/api/academy/progress", { method: "POST" }));
            if (scenario === "navigate") await rejected.page.evaluate(path => history.pushState(null, "", path), rejected.lessonPath);
            if (scenario === "stream-forgery") {
              assert.equal(await rejected.page.evaluate(async path => {
                const response = new Response('{"lesson":null}');
                Object.defineProperty(response, "url", { value: location.origin + path });
                return (await new Response(response.body).json()).lesson.id;
              }, rejected.targets[1]), rejected.target.lessonId);
            }
            await assert.rejects(rejected.watch.wait(rejected.expires), /LEARNER_ACCESS_RESPONSE_REFUSED/u);
            if (scenario === "stream-forgery") assert.deepEqual(rejected.effects.map(effect => effect.target), rejected.targets.slice(0, 2));
            if (scenario === "truncated") assert.deepEqual(rejected.effects.map(effect => effect.target), rejected.targets.slice(0, 1));
          }
          assert.throws(() => rejected.watch.finish(), /LEARNER_ACCESS_RESPONSE_REFUSED/u);
        } finally { await rejected.close(); }
      }
    } finally {
      await browser?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all([proxy, https].filter(server => server?.listening).map(server => new Promise(done => server.close(done))));
      rmSync(root, { recursive: true, force: true });
    }
  });

test("owned Chromium lifecycle watcher captures only selected command and preference responses",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const requestId = randomUUID(), responseHeaders = { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId };
    try {
      const command = p2LifecycleMutationTarget({ actorKind: "admin", userId, operation: "suspend" });
      const commandBody = { commandId, action: "suspend", accountVersion: 2, status: "pending" };
      const owner = await ownedLifecyclePage(browser, command, { status: 202, headers: responseHeaders, body: JSON.stringify(commandBody) });
      const posted = { action: "suspend", idempotencyKey: randomUUID() };
      try {
        await owner.post("https://owned-foreign.invalid" + command.pathname, posted);
        await owner.post("/api/account/preferences", { learningUpdates: true });
        await owner.post(command.pathname, posted);
        await owner.watch.wait(owner.expires);
        await owner.page.close();
        const result = owner.watch.finish();
        assert.deepEqual(result, { method: "POST", pathname: command.pathname, status: 202, requestId, body: commandBody });
        assert.equal(JSON.stringify(result).includes(posted.idempotencyKey), false);
      } finally { await owner.close(); }
      const preference = p2LifecycleMutationTarget({ actorKind: "customer", userId, operation: "preferences-off" });
      const learner = await ownedLifecyclePage(browser, preference, { status: 200, headers: responseHeaders, body: '{"saved":true}' },
        `<!doctype html><script>window.ownedEarly = fetch(${JSON.stringify(preference.pathname)}, {
          method: "POST", headers: { "content-type": "application/json" }, body: '{"learningUpdates":false}'
        }).then(response => response.text());</script>`);
      try {
        await learner.page.evaluate(() => window.ownedEarly);
        await learner.watch.wait(learner.expires);
        await learner.page.close();
        assert.deepEqual(learner.watch.finish(), { method: "POST", pathname: preference.pathname, status: 200, requestId, body: { saved: true } });
      } finally { await learner.close(); }
    } finally { await browser.close(); }
  });

test("owned Chromium lifecycle watcher refuses a second selected success and ambiguous selected responses",
  { skip: !ownedInteractiveBrowser }, async () => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    const selection = p2LifecycleMutationTarget({ actorKind: "customer", userId, operation: "preferences-on" });
    const responseHeaders = { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": randomUUID() };
    const success = { status: 200, headers: responseHeaders, body: '{"saved":true}' };
    try {
      const duplicate = await ownedLifecyclePage(browser, selection, success);
      try {
        await duplicate.post(selection.pathname, { learningUpdates: true });
        await duplicate.watch.wait(duplicate.expires);
        await duplicate.post(selection.pathname, { learningUpdates: true });
        assert.throws(() => duplicate.watch.finish(), { message: "P2_INTERACTIVE_LIFECYCLE_RESPONSE_REFUSED" });
      } finally { await duplicate.close(); }
      for (const [response, suffix, posted] of [
        [{ ...success, status: 503 }, "", { learningUpdates: true }],
        [{ status: 302, headers: { location: "/sign-in" }, body: "" }, "", { learningUpdates: true }],
        [success, "?unexpected=owned", { learningUpdates: true }],
        [success, "", { learningUpdates: false }],
        [{ ...success, body: '{"saved":true,"saved":true}' }, "", { learningUpdates: true }],
        [{ ...success, body: JSON.stringify({ saved: true, raw: "a".repeat(4096) }) }, "", { learningUpdates: true }],
      ]) {
        const browserCase = await ownedLifecyclePage(browser, selection, response);
        try {
          await browserCase.post(selection.pathname + suffix, posted);
          await assert.rejects(browserCase.watch.wait(browserCase.expires), { message: "P2_INTERACTIVE_LIFECYCLE_RESPONSE_REFUSED" });
          assert.throws(() => browserCase.watch.finish());
        } finally { await browserCase.close(); }
      }
    } finally { await browser.close(); }
  });

{
  const actorId = randomUUID(), courseId = randomUUID(), revision = 4, slug = "owned-paid-archive", requestId = randomUUID();
  const posted = { expectedRevision: revision, status: "archived" };
  const target = { actorId, operation: "archive-paid-course", courseId, slug, revision, userId: randomUUID(), grantId: randomUUID(),
    bodySha256: createHash("sha256").update(JSON.stringify(posted)).digest("hex") };
  const input = { version: 2, environment: "staging", actionId: "owned-paid-archive", challenge: "1".repeat(64), bindingSha256: "2".repeat(64),
    sourceCommit: "a".repeat(40), deploymentId: "dpl_ownedArchive", deploymentUrl: "https://owned-archive.vercel.app",
    browserOrigin: "https://staging.lashher.com", stage: "authoring", epoch: "9", windowSeconds: 120, authoring: target };
  const entry = "/admin/courses/" + courseId, pathname = "/api" + entry;
  const receipt = { method: "PATCH", pathname, status: 200, requestId,
    body: { courseId, slug, revision: revision + 1, status: "archived" }, warningObserved: true, cancelObservedWithoutMutation: true };

  test("paid archive browser input, permit and receipt bind the exact approved mutation", () => {
    assert.equal(validateP2InteractiveBrowserInput(input), input);
    assert.equal(p2InteractiveBrowserEntryPath(input, "owner"), entry);
    assert.throws(() => p2InteractiveBrowserEntryPath(input, "learner"));
    const issued = Math.floor(Date.now() / 1000), expires = issued + 60;
    const cookie = ["v2", input.epoch, "authoring", issued, expires, "3".repeat(32),
      "7032712d617574682d6172632d763100" + actorId.replaceAll("-", ""), "4".repeat(64)].join(".");
    const permit = { stage: "authoring", epoch: input.epoch, expires, cookie };
    assert.equal(validateP2InteractiveBrowserPermit(permit, input), permit);
    assert.throws(() => validateP2InteractiveBrowserPermit(permit, { ...input, authoring: { ...target, actorId: randomUUID() } }));
    for (const change of [{ bodySha256: "5".repeat(64) }, { userId: "other" }, { grantId: "other" }, { revision: 2_147_483_647 }]) {
      assert.throws(() => validateP2InteractiveBrowserInput({ ...input, authoring: { ...target, ...change } }));
    }
    assert.equal(validateP2AuthoringMutationReceipt(receipt, target), receipt);
    for (const change of [{ cancelObservedWithoutMutation: false }, { warningObserved: false }, { method: "POST" }, { customerDenied: true },
      { body: { ...receipt.body, status: "published" } }]) {
      assert.throws(() => validateP2AuthoringMutationReceipt({ ...receipt, ...change }, target));
    }
  });

  const warning = `<section aria-labelledby="paid-archive-heading"><h3 id="paid-archive-heading">Before archiving this paid course</h3>
    <p>Archiving denies protected lessons, new playback, assessments and progress updates, including access from existing purchases.
      Already issued video access may continue for up to 600 seconds.</p>
    <p>Course and lesson identifiers, independent grants, progress and assessment and audit history remain.
      Community access depends on remaining eligible courses and grants.</p>
    <p>Archiving does not issue a refund or cancel a payment. Support and refund requests follow existing applicable terms and owner review.</p>
    <p>Restoring access requires an explicit republish that passes current publication checks.
      Republish cannot override revoked or expired grants, suspension or account deletion.</p>
    <button id="cancel">Cancel archive</button><button id="confirm">Archive paid course</button></section>`;

  test("owned Chromium paid archive requires two genuine warnings, cancellation and normal readback",
    { skip: process.env.P2_INTERACTIVE_BROWSER_OWNED_TEST !== "true" }, async () => {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const open = async scenario => {
        const context = await browser.newContext(), page = await context.newPage(), requests = [];
        let allowReadback;
        const readbackAllowed = new Promise(resolve => { allowReadback = resolve; });
        if (scenario !== "success") allowReadback();
        const policy = scenario === "wrong-policy" ? warning.replace("600 seconds", "60 seconds") : warning;
        const body = scenario === "wrong-patch" ? { ...posted, expectedRevision: revision - 1 } : posted;
        const document = `<!doctype html><meta charset="utf-8"><p id="revision">published · Revision ${revision}</p>
          <button id="archive">Archive course</button><div id="warning"></div><div role="status"><p></p></div><script>
          const area = document.querySelector('#warning');
          document.querySelector('#archive').onclick = () => {
            area.innerHTML = ${JSON.stringify(policy)};
            document.querySelector('#cancel').onclick = () => { area.replaceChildren(); };
            document.querySelector('#confirm').onclick = async () => {
              const result = await fetch(${JSON.stringify(pathname)}, {method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
              await result.json();
              const { course } = await (await fetch(${JSON.stringify(pathname)})).json();
              area.replaceChildren();
              document.querySelector('#revision').textContent = course.status + ' · Revision ' + course.revision;
              document.querySelector('[role="status"] p').textContent = 'Course archived. Historical references remain available.';
            };
          };</script>`;
        await context.route("**/*", async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== input.browserOrigin) return route.abort();
          if (request.isNavigationRequest()) return route.fulfill({ status: 200, contentType: "text/html", body: document });
          requests.push(request.method() + " " + url.pathname);
          if (request.method() === "GET") await readbackAllowed;
          const course = { id: courseId, slug, revision: revision + 1, status: "archived", title: "Private fixture title" };
          if (scenario === "wrong-response" && request.method() === "PATCH") course.status = "published";
          return route.fulfill({ status: 200, body: JSON.stringify({ course }),
            headers: { "content-type": "application/json", "cache-control": "private, no-store", "x-request-id": requestId } });
        });
        const watch = watchP2AuthoringMutation(context, page, input);
        await installP2PaidArchiveObserver(page, input);
        await page.goto(input.browserOrigin + entry);
        return { page, watch, requests, allowReadback, expires: Math.floor(Date.now() / 1000) + 60,
          archive: page.getByRole("button", { name: "Archive course", exact: true }), cancel: page.getByRole("button", { name: "Cancel archive", exact: true }),
          confirm: page.getByRole("button", { name: "Archive paid course", exact: true }),
          heading: page.getByRole("heading", { name: "Before archiving this paid course", exact: true }),
          close: async () => { allowReadback(); watch.close(); await context.close(); } };
      };
      const prepare = async (owned, scenario) => {
        await owned.archive.click();
        await owned.heading.waitFor({ state: "visible" });
        if (scenario === "no-cancel") return;
        if (scenario === "synthetic-cancel") await owned.page.evaluate(() => document.querySelector("#cancel").click());
        else await owned.cancel.click();
        await owned.heading.waitFor({ state: "hidden" });
        assert.deepEqual(owned.requests, []);
        if (scenario === "alternate-write") await owned.page.evaluate(async () => { await (await fetch("/api/admin/other", { method: "POST" })).json(); });
        await owned.archive.click();
        await owned.heading.waitFor({ state: "visible" });
      };
      try {
        const owned = await open("success");
        try {
          await prepare(owned, "success");
          await Promise.all([owned.page.waitForRequest(request => request.method() === "GET" && request.url().endsWith(pathname)), owned.confirm.click()]);
          assert.throws(() => owned.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
          owned.allowReadback();
          await owned.watch.wait(owned.expires);
          assert.deepEqual(owned.watch.finish(), receipt);
          assert.deepEqual(owned.requests, ["PATCH " + pathname, "GET " + pathname]);
          await owned.page.evaluate(async ({ pathname, posted }) => {
            await (await fetch(pathname, { method: "PATCH", body: JSON.stringify(posted) })).json();
          }, { pathname, posted });
          assert.throws(() => owned.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
        } finally { await owned.close(); }
        for (const scenario of ["no-cancel", "synthetic-cancel", "wrong-policy", "alternate-write", "wrong-patch", "wrong-response"]) {
          const rejected = await open(scenario);
          try {
            await prepare(rejected, scenario);
            await rejected.confirm.click();
            await assert.rejects(rejected.watch.wait(rejected.expires), /AUTHORING_RESPONSE_REFUSED/u);
            assert.throws(() => rejected.watch.finish(), /AUTHORING_RESPONSE_REFUSED/u);
          } finally { await rejected.close(); }
        }
      } finally { await browser.close(); }
    });
}

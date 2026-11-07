// Source-parent browser/pending composition. A plan or caller JSON is not an
// issued browser artifact. Live authority comes from this fixed child process.
import { P2_CANONICAL_BROWSER_ORIGIN } from "./p2-canonical-browser-origin.mjs";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { prepareP2LifecyclePersistencePlan } from "./p2-lifecycle-persistence-probe.mjs";
import { frontendAdmissionTargetSha256 } from "./frontend-admission-bootstrap.mjs";
import { frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { P2_CERTIFICATION_PROFILE } from "./p2-certification-profile.mjs";
import { p2SuspensionEvidenceSha256 as hash, observeP2SuspensionPending } from "./p2-lifecycle-pending-probe.mjs";
import { isP2InteractiveAuthoringDetail, isP2InteractiveAuthoringPair, p2AuthoringCurriculumPath, p2AuthoringPublicationPaths, p2AuthoringQuizPath, p2AuthoringReorderPath,
  p2InteractiveBrowserEntryPath, p2InteractiveBrowserPath,
  p2InteractiveIdentityContext, p2LifecycleMutationTarget, validateP2AuthoringEditResponses, validateP2AuthoringMutationReceipt,
  validateP2AuthoringReorderResponses, validateP2InteractiveBrowserInput,
  validateP2InteractiveBrowserPermit, validateP2InteractiveIdentityReceipt, validateP2LearningEnrollmentReceipt,
  validateP2LessonEntryReceipt, validateP2LessonDenialReceipt, validateP2LessonAssessmentReceipt, validateP2LessonResumeReceipt,
  validateP2LifecycleMutationReceipt, validateP2PaidGrantReceipt, validateP2PaidLearnerAccessReceipt, validateP2PaidRevokeReceipt } from "./p2-lifecycle-browser-recorder.mjs";
import { parseQualificationTargetProfileRef, QualificationTargetProfileError, requireQualificationTargetProfile,
  resolveQualificationTargetProfile } from "./qualification-target-profile.mjs";

const plans = new WeakMap(), controllers = new WeakMap(), artifacts = new WeakMap();
const controlledCaptures = new WeakMap(), naturalArtifacts = new WeakMap(), pendingArtifacts = new WeakMap();
const authenticationArtifacts = new WeakMap();
const interactiveControllers = new WeakMap();
const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_SUSPENSION_EVIDENCE_REFUSED"); };
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const sourceRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const childFile = fileURLToPath(new URL("./p2-lifecycle-browser-recorder.mjs", import.meta.url));
export const P2_LIFECYCLE_BROWSER_LAUNCHER = "\nawait runP2LifecycleBrowserChild();\n";
const commit = () => execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${sourceRoot}`, "rev-parse", "--verify", "HEAD^{commit}"],
  { cwd: sourceRoot, encoding: "utf8", timeout: 10_000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
function committedProgramBytes(sourceCommit, file) {
  const bytes = execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${sourceRoot}`,
    "show", "--no-ext-diff", "--no-textconv", `${sourceCommit}:${file}`], { cwd: sourceRoot, timeout: 10_000, maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  demand(bytes.equals(readFileSync(new URL(`../../${file}`, import.meta.url)))); return bytes;
}
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const hasProfile = value => value && typeof value === "object" && Object.hasOwn(value, "qualificationTargetProfile");
function profileContext(expected, ...carriers) {
  if (expected === undefined) {
    if (carriers.some(hasProfile)) throw new QualificationTargetProfileError("QUALIFICATION_TARGET_PROFILE_REFUSED");
    return undefined;
  }
  const profile = parseQualificationTargetProfileRef(expected), definition = resolveQualificationTargetProfile(profile);
  demand(definition.id === "staging-current" && definition.environment === "staging" && definition.kind === "existing-staging");
  return requireQualificationTargetProfile(profile, ...carriers);
}
const candidateProfileCarriers = candidate => [candidate, candidate?.sourceApproval, candidate?.integration,
  ...Object.values(candidate?.sources ?? {}), candidate?.workload, candidate?.approval,
  ...(candidate?.frontendMigration === undefined ? [] : [candidate.frontendMigration])];

export function prepareP2LifecycleSuspensionPlan(candidate, input, expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  const persistenceTargets = input?.persistencePlan?.targets && typeof input.persistencePlan.targets === "object" ? Object.values(input.persistencePlan.targets) : [];
  const profile = profileContext(expectedProfile, input, input?.persistencePlan, ...persistenceTargets, input?.target, ...candidateProfileCarriers(candidate));
  demand(closed(input, ["version", ...(profile ? ["qualificationTargetProfile"] : []), "actionId", "candidateSha256", "persistencePlan", "deployment", "target", "owner", "producer", "resources", "windowSeconds", "drainSeconds", "operatorSourceCommit"])
    && input.version === (profile ? 2 : 1) && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && sha(input.candidateSha256)
    && input.windowSeconds === 840 && Number.isInteger(input.drainSeconds) && input.drainSeconds >= 1 && input.drainSeconds <= 180
    && closed(input.resources, ["userId", "courseId", "lessonId"]) && Object.values(input.resources).every(uuid)
    && input.operatorSourceCommit === commit());
  const fields = ["version", ...(profile ? ["qualificationTargetProfile"] : []), "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
    "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations"];
  const persistencePlan = prepareP2LifecyclePersistencePlan(Object.fromEntries(fields.map(name => [name, input.persistencePlan?.[name]])), profile), sourceCommit = persistencePlan.sources.frontend;
  demand(isDeepStrictEqual(input.persistencePlan, persistencePlan));
  demand(candidate?.version === (profile ? 3 : 2) && candidate.environment === "staging" && candidate.contractPhase === "p2"
    && candidate.integration?.state === "passed" && candidate.sourceApproval?.mode === "single-operator-dispatch"
    && candidate.sourceApproval.operatorGithubUserId === "8996309" && candidate.releaseId === persistencePlan.releaseId
    && candidate.sources?.frontend?.repository === "https://github.com/princessdardan/lash-her-frontend.git"
    && candidate.sources.frontend.requiredChecks === "passed" && candidate.sources.frontend.commit === sourceCommit
    && input.candidateSha256 === persistencePlan.candidateSha256 && input.operatorSourceCommit === sourceCommit
    && ["course", "community"].every(service => candidate.sources?.[service]?.commit === persistencePlan.sources[service]
      && candidate.sources[service].repository === `https://github.com/princessdardan/lash-her-${service}-api.git` && candidate.sources[service].requiredChecks === "passed")
    && candidate.workload?.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM" && candidate.workload.environment === "production");
  const deployment = input.deployment;
  demand(closed(deployment, ["deploymentId", "deploymentUrl", "configurationRecordSha256", "featureControls", "writerAdmissionBinding"])
    && /^dpl_[A-Za-z0-9]+$/u.test(deployment.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(deployment.deploymentUrl)
    && sha(deployment.configurationRecordSha256) && isDeepStrictEqual(deployment.featureControls, P2_CERTIFICATION_PROFILE.featureControls)
    && closed(input.owner, ["name", "oid"]) && closed(input.producer, ["producerSha256", "role"])
    && closed(input.producer.role, ["name", "oid"]) && sha(input.producer.producerSha256)
    && [input.owner, input.producer.role].every(role => /^[a-z][a-z0-9_]{0,62}$/u.test(role.name) && /^[1-9][0-9]{0,9}$/u.test(role.oid))
    && input.owner.oid !== input.producer.role.oid && input.owner.name !== input.producer.role.name
    && closed(input.target, ["host", "port", "database", "user", "serverMajor", ...(profile ? ["qualificationTargetProfile"] : [])])
    && input.target.host === persistencePlan.targets.frontend.host && input.target.port === persistencePlan.targets.frontend.port
    && input.target.database === persistencePlan.targets.frontend.database && input.target.serverMajor === persistencePlan.targets.frontend.serverMajor
    && input.target.user !== input.producer.role.name);
  const expectedBinding = { mode: "enforce", targetSha256: frontendAdmissionTargetSha256("staging", input.target),
    producerSha256: input.producer.producerSha256, sourceCommit, roleName: input.producer.role.name };
  demand(isDeepStrictEqual(expectedBinding, deployment.writerAdmissionBinding));
  const value = freeze({ version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}), status: "P2_LIFECYCLE_SUSPENSION_SOURCE_PLAN", environment: "staging", profile: "normal-ui-suspension-pending-v1",
    actionId: input.actionId, releaseId: persistencePlan.releaseId, candidateSha256: input.candidateSha256, candidateObjectSha256: hash(candidate),
    sourceCommit, operatorSourceCommit: input.operatorSourceCommit, operatorSourceEligibility: "same-as-immutable-frontend-candidate",
    configurationSha256: persistencePlan.configurationSha256, configurationRecordSha256: deployment.configurationRecordSha256,
    resourceBindingSha256: hash(input.resources),
    targetSha256: expectedBinding.targetSha256, hostMachineId: persistencePlan.hostMachineId, deploymentId: deployment.deploymentId,
    deploymentUrl: deployment.deploymentUrl, browserOrigin: P2_CANONICAL_BROWSER_ORIGIN, featureControls: deployment.featureControls,
    writerAdmissionBinding: deployment.writerAdmissionBinding, browserProgramSha256: hash(Buffer.concat([committedProgramBytes(sourceCommit, "ops/platform/p2-lifecycle-browser-recorder.mjs"), Buffer.from(P2_LIFECYCLE_BROWSER_LAUNCHER)])),
    pendingProgramSha256: hash(committedProgramBytes(sourceCommit, "ops/platform/p2-lifecycle-pending-probe.mjs")),
    parentProgramSha256: hash(committedProgramBytes(sourceCommit, "ops/platform/p2-lifecycle-suspension-evidence.mjs")),
    hostProgramSha256: hash(committedProgramBytes(sourceCommit, "ops/platform/host/p2_lifecycle_suspension_evidence.py")),
    windowSeconds: 840, drainSeconds: input.drainSeconds, initialAdmission: { newWork: true, recovery: false },
    finalDisposition: "native-off-and-admission-closed", fixtureCreationAuthorized: false,
    workerInvocationAuthorized: false, automaticReplayAllowed: false, releaseAccepted: false });
  plans.set(value, structuredClone(input)); return value;
}

export function validateP2SuspensionBrowserRecord(record, input) {
  demand(record?.version === 1 && record.status === "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED" && record.environment === "staging"
    && record.actionId === input.actionId && record.challenge === input.challenge && record.bindingSha256 === input.bindingSha256
    && record.sourceCommit === input.sourceCommit && record.deploymentId === input.deploymentId && record.deploymentUrl === input.deploymentUrl && record.browserOrigin === P2_CANONICAL_BROWSER_ORIGIN && record.browserOrigin === input.browserOrigin
    && record.userId === input.userId && record.courseId === input.courseId && record.lessonId === input.lessonId
    && record.contextsIsolated === true && record.sessionsFabricated === false && record.clockChanged === false && record.requestsIntercepted === false
    && record.tokensRetained === false && record.rawHarRetained === false && record.releaseAccepted === false
    && Array.isArray(record.events) && record.events.map(row => row.type).join() === "ordinary-playback-authorized,player-present,ordinary-owner-suspension-accepted,ordinary-renewal-denied,player-removed");
  const [baseline, present, suspension, denied, removed] = record.events;
  demand(record.events.every((row, index) => Number.isInteger(row.elapsedMs) && row.elapsedMs >= 0 && Number.isFinite(Date.parse(row.observedAt))
      && (index === 0 || row.elapsedMs >= record.events[index - 1].elapsedMs))
    && baseline.httpStatus === 200 && baseline.lifetimeMs >= 590000 && baseline.lifetimeMs <= 601000 && baseline.privateNoStore === true
    && present.muxPlayerCount === 1 && uuid(suspension.commandId) && uuid(suspension.requestId)
    && suspension.action === "suspend" && suspension.status === "pending" && Number.isSafeInteger(suspension.accountVersion) && suspension.accountVersion >= 1
    && denied.httpStatus === 401 && denied.errorCode === "sign_in_required" && uuid(denied.requestId) && denied.privateNoStore === true
    && removed.muxPlayerCount === 0 && removed.sessionEndedAlert === true && removed.elapsedMs <= input.windowSeconds * 1000
    && record.playbackRemovalAfterSuspensionMs === removed.elapsedMs - suspension.elapsedMs);
  return record;
}

export function launchP2LifecycleBrowserRecorder(plan, directory) {
  const reviewed = plans.get(plan); demand(reviewed && process.versions.node.split(".")[0] === "24" && commit() === plan.sourceCommit);
  const program = Buffer.concat([readFileSync(childFile), Buffer.from(P2_LIFECYCLE_BROWSER_LAUNCHER)]);
  demand(hash(program) === plan.browserProgramSha256);
  const store = frontendReleaseReceiptStore(directory), challenge = randomBytes(32).toString("hex");
  const input = { version: 1, environment: "staging", actionId: plan.actionId, challenge, bindingSha256: hash(plan),
    sourceCommit: plan.sourceCommit, deploymentId: plan.deploymentId, deploymentUrl: plan.deploymentUrl, browserOrigin: plan.browserOrigin, ...reviewed.resources, windowSeconds: 840 };
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program.toString("utf8")], { cwd: sourceRoot, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
  const waiting = new Map(), values = new Map(); let failed = false, ended = false, armed = false, suspended = false, authenticationStarted = false, closePromise, authenticationWaiter;
  const fail = () => { if (failed) return; failed = true; for (const { reject } of waiting.values()) reject(new Error("P2_BROWSER_SOURCE_CHILD_FAILED")); waiting.clear(); authenticationWaiter?.reject(new Error("P2_BROWSER_SOURCE_CHILD_FAILED")); };
  child.on("error", fail);
  child.on("message", message => {
    try {
      if (message?.type === "authentication-current") {
        demand(!failed && !armed && message.challenge === challenge && authenticationWaiter
          && closed(message.value, ["customerAuthenticated", "ownerFresh", "observedAt"])
          && typeof message.value.customerAuthenticated === "boolean" && typeof message.value.ownerFresh === "boolean"
          && Number.isFinite(Date.parse(message.value.observedAt)));
        const waiter = authenticationWaiter; authenticationWaiter = undefined; waiter.resolve(message.value); return;
      }
      demand(!failed && message && message.challenge === challenge && ["initialized", "authenticated", "baseline", "suspended", "complete"].includes(message.type)
        && !values.has(message.type));
      const expected = ["initialized", "authenticated", "baseline", "suspended", "complete"][values.size]; demand(message.type === expected);
      values.set(message.type, message.value ?? true); const waiter = waiting.get(message.type); if (waiter) { waiting.delete(message.type); waiter.resolve(message.value ?? true); }
    } catch { fail(); }
  });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => { ended = true; if (code !== 0 || signal || !values.has("complete")) fail(); resolve({ code, signal }); }));
  const overall = setTimeout(() => { fail(); void close(); }, 1800000);
  const wait = type => {
    demand(!failed); if (values.has(type)) return Promise.resolve(values.get(type));
    return new Promise((resolve, reject) => { demand(!waiting.has(type)); waiting.set(type, { resolve, reject }); });
  };
  const send = (type, value) => { demand(!failed && !ended); child.send({ type, input: value }, error => { if (error) fail(); }); };
  const close = () => closePromise ??= (async () => {
    clearTimeout(overall); if (!ended) { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); try { await exit; } finally { clearTimeout(timer); } }
  })();
  const authentication = value => {
    demand(closed(value, ["customerAuthenticated", "ownerFresh", "observedAt"]) && typeof value.customerAuthenticated === "boolean"
      && typeof value.ownerFresh === "boolean" && Number.isFinite(Date.parse(value.observedAt)));
    const handle = freeze({ version: 1, status: "P2_BROWSER_AUTHENTICATION_SOURCE_ISSUED", customerAuthenticated: value.customerAuthenticated, ownerFresh: value.ownerFresh });
    authenticationArtifacts.set(handle, { plan, controller, value }); return handle;
  };
  const controller = Object.freeze({
    initialized: () => wait("initialized"),
    beginAuthentication: async authStageHandle => {
      demand(!authenticationStarted && !armed); await wait("initialized");
      const { readP2CertificationAuthenticationStage } = await import("./p2-certification-transport.mjs");
      const held = readP2CertificationAuthenticationStage(authStageHandle, plan);
      demand(held?.status === "P2_CERTIFICATION_AUTHENTICATION_STAGE_HELD" && held.bindingSha256 === hash(plan));
      authenticationStarted = true; send("authenticate", challenge);
    },
    authenticated: async () => authentication(await wait("authenticated")),
    recheckAuthenticated: async () => { demand(!armed && !authenticationWaiter); await wait("authenticated");
      const result = new Promise((resolve, reject) => { authenticationWaiter = { resolve, reject }; }); send("check-authentication", challenge); return authentication(await result); },
    start: async stageHandle => { demand(!armed); await wait("authenticated"); await actualSuspensionStage(plan, stageHandle);
      controllers.get(controller).stageHandle = stageHandle; armed = true; send("arm", challenge); return wait("baseline"); },
    suspend: async controlledHandle => { const captured = controlledCaptures.get(controlledHandle);
      demand(armed && !suspended && captured?.plan === plan && captured.stageHandle === controllers.get(controller).stageHandle);
      await wait("baseline"); await actualSuspensionStage(plan, captured.stageHandle); suspended = true; send("suspend", challenge); return wait("suspended"); },
    complete: async () => {
      const record = validateP2SuspensionBrowserRecord(await wait("complete"), input), result = await exit;
      demand(!failed && result.code === 0 && !result.signal); clearTimeout(overall);
      store.record("p2-lifecycle-browser-source.json", record);
      const handle = Object.freeze({ version: 1, status: "P2_LIFECYCLE_BROWSER_ARTIFACT_ISSUED", recordSha256: hash(readFileSync(`${directory}/p2-lifecycle-browser-source.json`)),
        browserProgramSha256: plan.browserProgramSha256, bindingSha256: input.bindingSha256 });
      artifacts.set(handle, { plan, record, directory }); return handle;
    }, close,
  });
  controllers.set(controller, { plan, input, values, active: () => !failed && !ended }); send("initialize", input); return controller;
}

const interactiveBinding = input => ({ challenge: input.challenge, bindingSha256: input.bindingSha256, stage: input.stage, epoch: input.epoch });

async function reviewedInteractiveInput(plan, challenge) {
  const { p2CertificationParentContext } = await import("./p2-certification.mjs");
  p2CertificationParentContext(plan);
  demand(plan.mode === "interactive-browser" && plan.version === 2 && plan.maximumSeconds === 300
    && process.versions.node.split(".")[0] === "24" && plan.sourceCommit === plan.operatorSourceCommit
    && commit() === plan.sourceCommit && /^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch));
  const action = plan.scopedAction;
  let authoring, learning, lessonEntry, lessonDenial, assessment, resume, paidGrant, learnerAccess, paidRevoke;
  if (action.stage === "authoring") {
    const selected = action.authoringAction, [, first, second, third] = action.requests;
    if (["edit-and-stale-draft", "reorder-and-stale-curriculum"].includes(selected?.operation)) {
      const reorder = selected.operation === "reorder-and-stale-curriculum";
      const path = "/course/v1" + (reorder ? p2AuthoringReorderPath(selected).slice(4) : "/admin/courses/" + selected.courseId);
      demand([first, second].every(request => request?.method === (reorder ? "POST" : "PATCH") && request.target === path));
      authoring = { actorId: action.actorId, operation: selected.operation, courseId: selected.courseId, slug: selected.slug,
        revision: selected.revision, winnerBodySha256: first.bodySha256, staleBodySha256: second.bodySha256,
        ...(reorder ? { kind: selected.kind, parentId: selected.parentId } : {}) };
    } else if (selected?.operation === "create-curriculum") {
      demand(first?.method === "POST" && first.target === "/course/v1" + p2AuthoringCurriculumPath(selected).slice(4));
      authoring = { actorId: action.actorId, operation: selected.operation, courseId: selected.courseId, slug: selected.slug,
        revision: selected.revision, kind: selected.kind, parentId: selected.parentId, childSlug: selected.childSlug, bodySha256: first.bodySha256 };
    } else if (selected?.operation === "qualify-publication") {
      const { detail, readiness } = p2AuthoringPublicationPaths(selected), published = selected.outcome === "published";
      demand(first?.method === "GET" && first.target === "/course/v1" + readiness.slice(4)
        && (published ? second?.method === "PATCH" && second.target === "/course/v1" + detail.slice(4) : second === undefined));
      authoring = { actorId: action.actorId, operation: selected.operation, courseId: selected.courseId, slug: selected.slug,
        revision: selected.revision, outcome: selected.outcome, issueCodes: selected.issueCodes };
    } else if (selected?.operation === "save-quiz-revision") {
      const target = "/course/v1" + p2AuthoringQuizPath(selected).slice(4);
      demand(first?.method === "GET" && first.target === target && second?.method === "PUT" && second.target === target);
      authoring = { actorId: action.actorId, operation: selected.operation, courseId: selected.courseId, slug: selected.slug,
        revision: selected.revision, lessonId: selected.lessonId, quizRevision: selected.quizRevision,
        documentSha256: selected.documentSha256, bodySha256: second.bodySha256 };
    } else if (selected?.operation === "archive-paid-course") {
      const target = "/course/v1/admin/courses/" + selected.courseId;
      demand(first?.method === "PATCH" && first.target === target && second === undefined);
      authoring = { actorId: action.actorId, ...selected, bodySha256: first.bodySha256 };
    } else if (selected?.operation === "republish-paid-course") {
      const target = "/course/v1/admin/courses/" + selected.courseId;
      demand(first?.method === "PATCH" && first.target === target
        && second?.method === "GET" && second.target === target + "/publication-readiness"
        && (selected.outcome === "published" ? third?.method === "PATCH" && third.target === target : third === undefined));
      authoring = { actorId: action.actorId, ...selected };
    } else {
      demand(selected?.operation === "create-draft" && first?.method === "POST" && first.target === "/course/v1/admin/courses");
      authoring = { actorId: action.actorId, slug: selected.slug, bodySha256: first.bodySha256 };
    }
  }
  if (action.stage === "learning") {
    const selected = action.learningAction;
    const replay = selected?.operation === "replay-free-enrollment";
    demand(replay || selected?.operation === "enroll-free-course");
    const detail = "/course/v1/student/courses/" + selected.courseId, empty = hash("");
    const progress = { method: "GET", target: "/course/v1/student/progress?courseId=" + selected.courseId, bodySha256: empty, uses: 1 };
    const enrollment = { method: "POST", target: detail + "/enrollments", bodySha256: hash(JSON.stringify({ idempotencyKey: selected.idempotencyKey })), uses: 1 };
    demand(isDeepStrictEqual(action.requests, replay ? [
      { method: "GET", target: detail, bodySha256: empty, uses: 1 }, progress, enrollment,
    ] : [
      { method: "GET", target: "/course/v1/courses/" + selected.slug, bodySha256: empty, uses: 1 },
      { method: "GET", target: detail, bodySha256: empty, uses: 2 },
      enrollment, progress,
    ]));
    learning = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "paid-grant") {
    const selected = action.paidGrantAction;
    demand(selected?.operation === "grant-paid-access" && action.requests.length === 4);
    const [detail, command, write, grants] = action.requests, empty = hash(""), key = "owner-paid%3A" + selected.idempotencyKey;
    const grantTarget = "/course/v1/admin/entitlements/grants";
    demand(isDeepStrictEqual(detail, { method: "GET", target: "/course/v1/admin/courses/" + selected.courseId, bodySha256: empty, uses: 3 })
      && isDeepStrictEqual(command, { method: "GET", target: "/course/v1/admin/entitlements/commands?idempotencyKey=" + key + "&limit=2",
        bodySha256: empty, uses: 2 })
      && closed(write, ["method", "target", "bodySha256", "uses"]) && write.method === "POST" && write.target === grantTarget
      && sha(write.bodySha256) && write.bodySha256 !== empty && write.uses === 1
      && isDeepStrictEqual(grants, { method: "GET", target: `${grantTarget}?userId=${selected.userId}&courseId=${selected.courseId}&idempotencyKey=${key}&limit=2`,
        bodySha256: empty, uses: 1 }));
    const { operation, courseId, userId, revision, idempotencyKey, reasonSha256 } = selected;
    paidGrant = { actorId: action.actorId, operation, courseId, userId, revision, idempotencyKey, reasonSha256 };
  }
  if (action.stage === "learner-access") {
    const selected = action.learnerAccessAction;
    demand(selected?.operation === "observe-paid-access");
    learnerAccess = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "lesson-entry") {
    const selected = action.lessonEntryAction;
    demand(selected?.operation === "open-lesson");
    lessonEntry = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "lesson-denial") {
    const selected = action.lessonDenialAction;
    demand(selected?.operation === "deny-cross-account");
    lessonDenial = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "lesson-assessment") {
    const selected = action.assessmentAction;
    demand(selected?.operation === "fail-then-pass");
    assessment = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "lesson-resume") {
    const selected = action.resumeAction;
    demand(selected?.operation === "play-and-rewind");
    resume = { actorId: action.actorId, ...selected };
  }
  if (action.stage === "paid-revoke") {
    const selected = action.paidRevokeAction;
    demand(selected?.operation === "revoke-paid-grant");
    paidRevoke = { actorId: action.actorId, ...selected };
  }
  return validateP2InteractiveBrowserInput({ version: 2, environment: "staging", actionId: plan.certificationActionId,
    challenge, bindingSha256: plan.planSha256, stage: action.stage, epoch: (BigInt(plan.initialEpoch) + 1n).toString(),
    sourceCommit: plan.sourceCommit, deploymentId: plan.nativePlan.deploymentId, deploymentUrl: plan.nativePlan.deploymentUrl,
    browserOrigin: P2_CANONICAL_BROWSER_ORIGIN, windowSeconds: action.windowSeconds,
    ...(action.stage === "identity" ? Object.hasOwn(action, "identityEnrollment")
      ? { identityEnrollment: action.identityEnrollment } : { identity: action.identityActor } : {}),
    ...(action.stage === "lifecycle" ? { lifecycle: p2LifecycleMutationTarget(action.frontendAction) } : {}),
    ...(authoring ? { authoring } : {}), ...(learning ? { learning } : {}), ...(paidGrant ? { paidGrant } : {}),
    ...(learnerAccess ? { learnerAccess } : {}), ...(lessonEntry ? { lessonEntry } : {}), ...(lessonDenial ? { lessonDenial } : {}),
    ...(assessment ? { assessment } : {}), ...(resume ? { resume } : {}), ...(paidRevoke ? { paidRevoke } : {}) });
}

// A dedicated stdin pipe carries one permit per reviewed phase. All IPC data
// is challenge-bound control or sanitized evidence, including on failure.
export async function launchP2InteractiveBrowserRecorder(plan) {
  let input = await reviewedInteractiveInput(plan, randomBytes(32).toString("hex")), binding = interactiveBinding(input);
  committedProgramBytes(plan.sourceCommit, "ops/platform/p2-lifecycle-suspension-evidence.mjs");
  const program = Buffer.concat([committedProgramBytes(plan.sourceCommit, "ops/platform/p2-lifecycle-browser-recorder.mjs"),
    Buffer.from(P2_LIFECYCLE_BROWSER_LAUNCHER)]);
  const programSha256 = hash(program), actions = new Set([input.actionId]);
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program.toString("utf8")], { cwd: sourceRoot,
    stdio: ["pipe", "ignore", "ignore", "ipc"],
    env: Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
  let activePlan = plan, pending, selected, phaseTimer, force, closePromise, verifiedIdentity;
  let ended = false, failed = false, closing = false, phase = "initializing";
  const failure = () => new Error("P2_INTERACTIVE_BROWSER_CHILD_FAILED");
  const fail = () => {
    if (failed) return;
    failed = true;
    clearTimeout(overall);
    clearTimeout(phaseTimer);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure());
      pending = undefined;
    }
    child.stdin.destroy();
    if (!ended) {
      child.kill("SIGTERM");
      force = setTimeout(() => { if (!ended) child.kill("SIGKILL"); }, 5000);
    }
  };
  const overall = setTimeout(fail, 1_800_000);
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("message", message => {
    try {
      const lifecycle = pending?.type === "interactive-lifecycle-captured";
      const authoring = pending?.type === "interactive-authoring-captured";
      const learning = pending?.type === "interactive-learning-captured";
      const lessonEntry = pending?.type === "interactive-lesson-entry-captured";
      const lessonDenial = pending?.type === "interactive-lesson-denial-captured";
      const assessment = pending?.type === "interactive-lesson-assessment-captured";
      const resume = pending?.type === "interactive-lesson-resume-captured";
      const paidGrant = pending?.type === "interactive-paid-grant-captured";
      const learnerAccess = pending?.type === "interactive-learner-access-captured";
      const paidRevoke = pending?.type === "interactive-paid-revoke-captured";
      const edit = pending?.type === "interactive-authoring-edit-captured";
      const identity = pending?.type === "interactive-identity-captured";
      demand(pending && !failed && closed(message, ["type", ...Object.keys(pending.binding), ...Object.keys(pending.selection),
        ...(pending.type === "interactive-page-opened" ? ["path", "httpStatus"] : []),
        ...(lifecycle || authoring || learning || lessonEntry || lessonDenial || assessment || resume || paidGrant || learnerAccess || paidRevoke ? ["response"] : edit ? ["responses"] : identity ? ["identity"] : [])])
        && message.type === pending.type
        && Object.entries({ ...pending.binding, ...pending.selection }).every(([key, value]) => message[key] === value));
      if (pending.type === "interactive-page-opened") {
        demand(message.path === p2InteractiveBrowserEntryPath(input, pending.selection.context)
          && Number.isInteger(message.httpStatus) && message.httpStatus >= 100 && message.httpStatus <= 599
          && (!(isP2InteractiveAuthoringDetail(input) || ["learning", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "paid-grant", "learner-access", "paid-revoke"].includes(input.stage)) || message.httpStatus === 200));
      }
      if (lifecycle) validateP2LifecycleMutationReceipt(message.response, input.lifecycle);
      if (authoring) validateP2AuthoringMutationReceipt(message.response, input.authoring);
      if (learning) validateP2LearningEnrollmentReceipt(message.response, input.learning);
      if (lessonEntry) validateP2LessonEntryReceipt(message.response, input.lessonEntry);
      if (lessonDenial) validateP2LessonDenialReceipt(message.response, input.lessonDenial);
      if (assessment) validateP2LessonAssessmentReceipt(message.response, input.assessment);
      if (resume) validateP2LessonResumeReceipt(message.response, input.resume);
      if (paidGrant) validateP2PaidGrantReceipt(message.response, input.paidGrant);
      if (learnerAccess) validateP2PaidLearnerAccessReceipt(message.response, input.learnerAccess);
      if (paidRevoke) validateP2PaidRevokeReceipt(message.response, input.paidRevoke);
      if (edit) {
        if (input.authoring.operation === "reorder-and-stale-curriculum") validateP2AuthoringReorderResponses(message.responses, input.authoring);
        else validateP2AuthoringEditResponses(message.responses, input.authoring);
      }
      if (identity) validateP2InteractiveIdentityReceipt(message.identity, input);
      const waiter = pending;
      pending = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(freeze(message));
    } catch { fail(); }
  });
  const exit = new Promise(resolve => child.once("close", (code, signal) => {
    ended = true;
    clearTimeout(overall);
    clearTimeout(phaseTimer);
    clearTimeout(force);
    if (!closing || pending || code !== 0 || signal) fail();
    resolve({ code, signal });
  }));
  const command = (type, packet, expect, selection = {}, timeout = 30_000, expectedBinding = binding) => {
    demand(!pending && !ended && !failed && child.connected);
    return new Promise((resolve, reject) => {
      pending = { type: expect, binding: expectedBinding, selection, resolve, reject, timer: setTimeout(fail, timeout) };
      child.send({ type, input: packet }, error => { if (error) fail(); });
    });
  };
  const ready = command("initialize-interactive", input, "interactive-initialized").then(value => {
    phase = "ready";
    phaseTimer = setTimeout(fail, plan.maximumSeconds * 1000);
    return value;
  });
  ready.catch(() => {});
  const requireSelection = context => {
    demand(!failed && !ended && selected?.context === context);
    return selected;
  };
  const captureMutation = async (context, stage, expectedContext, edit = false) => {
    const selection = requireSelection(context);
    const remaining = selection.expires * 1000 - Date.now();
    demand(phase === "opened" && !closing && binding.stage === stage && context === expectedContext
      && edit === isP2InteractiveAuthoringPair(input)
      && remaining > 0 && remaining <= input.windowSeconds * 1000);
    phase = "capturing";
    const protocolStage = edit ? "authoring-edit" : stage;
    const receipt = await command("interactive-capture-" + protocolStage, { ...binding, ...selection },
      "interactive-" + protocolStage + "-captured", selection, remaining + 5000);
    phase = "cleared";
    clearTimeout(phaseTimer);
    return edit ? receipt.responses : receipt.response;
  };
  const controller = Object.freeze({
    initialized: () => ready,
    async installPermit(permit, context) {
      await ready;
      demand(phase === "ready" && !failed && !ended && !closing);
      phase = "installing";
      try {
        p2InteractiveBrowserPath(binding.stage, context);
        validateP2InteractiveBrowserPermit(permit, input);
        if (binding.stage === "identity") demand(context === p2InteractiveIdentityContext(input));
        if (binding.stage === "lifecycle") {
          const { actorId, frontendAction: { actorKind, userId, operation } } = activePlan.scopedAction;
          demand(context === (actorKind === "admin" ? "owner" : "learner")
            && permit.cookie.split(".")[6] === hash(JSON.stringify([actorKind, actorId, userId, operation])));
        }
        selected = { context, expires: permit.expires };
        const installed = command("interactive-install", { ...binding, ...selected }, "interactive-permit-installed", selected);
        installed.catch(() => {});
        const privatePermit = { stage: permit.stage, epoch: permit.epoch, expires: permit.expires, cookie: permit.cookie };
        const frame = Buffer.from(JSON.stringify({ challenge: binding.challenge, bindingSha256: binding.bindingSha256, context, permit: privatePermit }) + "\n");
        privatePermit.cookie = "";
        try { child.stdin.write(frame, () => frame.fill(0)); }
        catch { frame.fill(0); throw failure(); }
        const receipt = await installed;
        phase = "installed";
        return receipt;
      } catch { fail(); throw failure(); }
    },
    async open(context) {
      const selection = requireSelection(context);
      demand(phase === "installed" && !closing && Date.now() < selection.expires * 1000);
      phase = "opening";
      const receipt = await command("interactive-open", { ...binding, ...selection }, "interactive-page-opened", selection, 40_000);
      phase = "opened";
      return receipt;
    },
    captureLifecycleResponse: context => captureMutation(context, "lifecycle", input.lifecycle?.context),
    captureAuthoringResponse: context => captureMutation(context, "authoring", "owner"),
    captureAuthoringResponses: context => captureMutation(context, "authoring", "owner", true),
    captureLearningResponse: context => captureMutation(context, "learning", "learner"),
    capturePaidGrantResponse: context => captureMutation(context, "paid-grant", "owner"),
    captureLearnerAccessResponse: context => captureMutation(context, "learner-access", "learner"),
    captureLessonEntryResponse: context => captureMutation(context, "lesson-entry", "learner"),
    captureLessonDenialResponse: context => captureMutation(context, "lesson-denial", "learner"),
    captureAssessmentResponse: context => captureMutation(context, "lesson-assessment", "learner"),
    captureResumeResponse: context => captureMutation(context, "lesson-resume", "learner"),
    capturePaidRevokeResponse: context => captureMutation(context, "paid-revoke", "owner"),
    async captureIdentity(context, ownerSubjectSha256) {
      const selection = requireSelection(context);
      const remaining = selection.expires * 1000 - Date.now();
      demand(phase === "opened" && !closing && binding.stage === "identity"
        && context === p2InteractiveIdentityContext(input)
        && (context === "owner" ? sha(ownerSubjectSha256) : ownerSubjectSha256 === undefined)
        && remaining > 0 && remaining <= input.windowSeconds * 1000);
      phase = "capturing";
      const packet = { ...binding, ...selection, ...(context === "owner" ? { ownerSubjectSha256 } : {}) };
      const receipt = await command("interactive-capture-identity", packet, "interactive-identity-captured", selection, remaining + 5000);
      verifiedIdentity = receipt.identity;
      phase = "cleared";
      clearTimeout(phaseTimer);
      return verifiedIdentity;
    },
    async clearPermit(context) {
      const selection = requireSelection(context);
      demand((phase === "installed" || phase === "opened") && !closing);
      phase = "clearing";
      const receipt = await command("interactive-clear", { ...binding, ...selection }, "interactive-permit-cleared", selection);
      phase = "cleared";
      clearTimeout(phaseTimer);
      return receipt;
    },
    async selectPlan(nextPlan) {
      demand(phase === "cleared" && !failed && !ended && !closing && actions.size < 24
        && !input.identityEnrollment && !nextPlan?.scopedAction?.identityEnrollment);
      phase = "selecting";
      try {
        const next = await reviewedInteractiveInput(nextPlan, binding.challenge), nextBinding = interactiveBinding(next);
        demand(["candidateSha256", "originalReleaseId", "targetSha256", "sourceCommit"].every(key => nextPlan[key] === plan[key])
          && ["deploymentId", "deploymentUrl", "configurationRecordSha256"].every(key => nextPlan.nativePlan[key] === plan.nativePlan[key])
          && !actions.has(next.actionId) && next.bindingSha256 !== input.bindingSha256 && BigInt(next.epoch) > BigInt(input.epoch));
        if (input.stage === "identity" || ["authoring", "learning", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "paid-grant", "learner-access", "paid-revoke"].includes(next.stage)) {
          demand(input.stage === "identity" && verifiedIdentity?.sessionVerified === true
            && nextPlan.scopedAction.actorId === verifiedIdentity.actorId && BigInt(next.epoch) === BigInt(input.epoch) + 2n
            && (next.stage === "lifecycle" && nextPlan.scopedAction.frontendAction.actorKind === verifiedIdentity.actorKind
              || ["authoring", "paid-grant", "paid-revoke"].includes(next.stage) && verifiedIdentity.actorKind === "admin"
              || ["learning", "lesson-entry", "lesson-denial", "lesson-assessment", "lesson-resume", "learner-access"].includes(next.stage) && verifiedIdentity.actorKind === "customer"));
        }
        const receipt = await command("interactive-select", { ...binding, next }, "interactive-selected", {}, 30_000, nextBinding);
        actions.add(next.actionId);
        activePlan = nextPlan;
        input = next;
        binding = nextBinding;
        selected = undefined;
        phase = "ready";
        phaseTimer = setTimeout(fail, nextPlan.maximumSeconds * 1000);
        const source = interactiveControllers.get(controller);
        source.plan = nextPlan;
        source.binding = freeze({ challenge: binding.challenge, bindingSha256: binding.bindingSha256, browserProgramSha256: programSha256 });
        return receipt;
      } catch { fail(); throw failure(); }
    },
    close: () => closePromise ??= (async () => {
      closing = true;
      let acknowledged = false;
      if (!failed && !ended && !pending) {
        try { await command("interactive-close", binding, "interactive-closed", {}, 5000); acknowledged = true; }
        catch { fail(); }
      } else if (!ended) fail();
      child.stdin.destroy();
      const reap = setTimeout(() => { if (!ended) child.kill("SIGKILL"); }, 5000);
      try {
        const result = await exit;
        return { childClosed: true, browserCleanupAcknowledged: acknowledged && !failed && result.code === 0 && result.signal === null };
      } finally { clearTimeout(reap); }
    })(),
  });
  interactiveControllers.set(controller, { plan, active: () => !failed && !ended && !closing,
    binding: freeze({ challenge: binding.challenge, bindingSha256: binding.bindingSha256, browserProgramSha256: programSha256 }) });
  return controller;
}

export function readP2InteractiveBrowserControllerBinding(plan, controller) {
  const source = interactiveControllers.get(controller);
  demand(source?.plan === plan && source.active());
  return { ...source.binding };
}

export function readP2LifecycleBrowserControllerBinding(plan, controller) {
  const source = controllers.get(controller); demand(plans.has(plan) && source?.plan === plan && source.active());
  return { challenge: source.input.challenge, bindingSha256: source.input.bindingSha256 };
}
export function readP2LifecycleBrowserAuthentication(plan, handle) {
  const source = authenticationArtifacts.get(handle), controller = controllers.get(source?.controller);
  demand(plans.has(plan) && source?.plan === plan && controller?.plan === plan && controller.active());
  return structuredClone(source.value);
}
export function readP2LifecycleBrowserSuspensionEvent(plan, controller) {
  const source = controllers.get(controller); demand(plans.has(plan) && source?.plan === plan && source.active() && source.values.has("suspended"));
  return structuredClone(source.values.get("suspended"));
}

export function readP2LifecycleBrowserSourceArtifact(plan, handle) {
  const source = artifacts.get(handle); demand(plans.has(plan) && source?.plan === plan);
  const bytes = readFrontendReleaseEvidence(source.directory, "p2-lifecycle-browser-source.json");
  demand(hash(bytes) === handle.recordSha256 && isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), source.record));
  return { bytes, record: structuredClone(source.record), recordSha256: handle.recordSha256 };
}

async function actualSuspensionStage(plan, handle) {
  demand(plans.has(plan));
  // Fixed source import only. No module path, callback object or JSON class is
  // accepted. The transport owns the process/lifetime WeakMap for this handle.
  const { readP2CertificationSuspensionStage } = await import("./p2-certification-transport.mjs");
  return readP2CertificationSuspensionStage(handle, plan);
}

export async function captureP2SuspensionControlledAuthority(plan, stageHandle) {
  const stage = await actualSuspensionStage(plan, stageHandle), value = await stage.captureControlled();
  const profile = profileContext(hasProfile(plan) ? plan.qualificationTargetProfile : undefined, plan, value);
  demand(closed(value, ["version", ...(profile ? ["qualificationTargetProfile"] : []), "status", "bindingSha256", "capturePublic", "controlledCaptureMetadataSha256", "tokenBytesOutput", "credentialHashesOutput"])
    && value.version === (profile ? 2 : 1) && value.status === "P2_SUSPENSION_CONTROLLED_CAPTURED" && value.bindingSha256 === hash(plan)
    && value.tokenBytesOutput === false && value.credentialHashesOutput === false && hash(value.capturePublic) === value.controlledCaptureMetadataSha256
    && value.capturePublic.controlledUser.exp-value.capturePublic.controlledUser.iat === 300
    && value.capturePublic.controlledUser.baseline.status === 200 && value.capturePublic.playback.courseAuthorization.status === 200
    && [200,206].includes(value.capturePublic.playback.initialProviderAccess.status));
  const handle = freeze({ version: 1, status: "P2_SUSPENSION_CONTROLLED_SOURCE_ISSUED", metadataSha256: value.controlledCaptureMetadataSha256 });
  controlledCaptures.set(handle, { plan, stageHandle, capturePublic: structuredClone(value.capturePublic), used: false }); return handle;
}

function naturalWindow(value, boundary, allowed, denied) {
  demand(closed(value, ["lastAccepted", "firstDenied", "pollResolutionMs"]) && value.pollResolutionMs === 2000
    && allowed.includes(value.lastAccepted?.status) && denied.includes(value.firstDenied?.status)
    && Date.parse(value.lastAccepted.requestStartedAt) < boundary && Date.parse(value.firstDenied.requestStartedAt) >= boundary
    && Date.parse(value.firstDenied.requestStartedAt)-boundary <= 2000
    && Date.parse(value.firstDenied.responseEndedAt) >= Date.parse(value.firstDenied.requestStartedAt));
}

export async function observeP2SuspensionControlledAuthority(plan, captureHandle) {
  const source = controlledCaptures.get(captureHandle); demand(source?.plan === plan && !source.used); source.used = true;
  const stage = await actualSuspensionStage(plan, source.stageHandle), value = await stage.captureNaturalExpiry();
  const profile = profileContext(hasProfile(plan) ? plan.qualificationTargetProfile : undefined, plan, value);
  demand(closed(value, ["version", ...(profile ? ["qualificationTargetProfile"] : []), "status", "bindingSha256", "user", "mux", "userWindowSha256", "muxWindowSha256", "tokenBytesOutput", "credentialHashesOutput"])
    && value.version === (profile ? 2 : 1) && value.status === "P2_SUSPENSION_NATURAL_EXPIRY_OBSERVED" && value.bindingSha256 === hash(plan)
    && value.tokenBytesOutput === false && value.credentialHashesOutput === false
    && hash(value.user) === value.userWindowSha256 && hash(value.mux) === value.muxWindowSha256);
  naturalWindow(value.user, (source.capturePublic.controlledUser.exp+30)*1000, [200], [401]);
  naturalWindow(value.mux, source.capturePublic.playback.exp*1000, [200,206], [401,403]);
  await actualSuspensionStage(plan, source.stageHandle);
  const handle = freeze({ version: 1, status: "P2_SUSPENSION_NATURAL_SOURCE_ISSUED", userWindowSha256: value.userWindowSha256, muxWindowSha256: value.muxWindowSha256 });
  naturalArtifacts.set(handle, { plan, stageHandle: source.stageHandle, value: structuredClone(value), capturePublic: source.capturePublic }); return handle;
}

export async function captureP2SuspensionPending(plan, browserHandle, naturalHandle, client, dependencies) {
  const reviewed = plans.get(plan), browser = readP2LifecycleBrowserSourceArtifact(plan, browserHandle), natural = naturalArtifacts.get(naturalHandle);
  demand(reviewed && natural?.plan === plan); await actualSuspensionStage(plan, natural.stageHandle);
  const event = browser.record.events.find(row => row.type === "ordinary-owner-suspension-accepted");
  const selection = { userId: browser.record.userId, commandId: event.commandId, accountVersion: event.accountVersion, requestId: event.requestId,
    responseObservedAt: event.observedAt, controlledDenialObservedAt: natural.value.user.firstDenied.responseEndedAt };
  const pending = await observeP2SuspensionPending(client, reviewed.target, selection, dependencies);
  await actualSuspensionStage(plan, natural.stageHandle);
  const store = frontendReleaseReceiptStore(dependencies.directory);
  const record = { version: 1, status: "P2_SUSPENSION_PENDING_SOURCE_CAPTURED", planSha256: hash(plan),
    browserRecordSha256: browser.recordSha256, userWindowSha256: naturalHandle.userWindowSha256, pendingProgramSha256: plan.pendingProgramSha256, pending };
  store.record("p2-lifecycle-suspension-pending-source.json", record);
  const bytes = readFrontendReleaseEvidence(dependencies.directory, "p2-lifecycle-suspension-pending-source.json");
  const handle = freeze({ version: 1, status: "P2_SUSPENSION_PENDING_SOURCE_ISSUED", recordSha256: hash(bytes), pendingDeliveries: 2, attempts: 0 });
  pendingArtifacts.set(handle, { plan, record, directory: dependencies.directory }); return handle;
}

export function readP2SuspensionPendingSourceArtifact(plan, handle) {
  const source = pendingArtifacts.get(handle); demand(plans.has(plan) && source?.plan === plan);
  const bytes = readFrontendReleaseEvidence(source.directory, "p2-lifecycle-suspension-pending-source.json");
  demand(hash(bytes) === handle.recordSha256 && isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), source.record));
  return { bytes, record: structuredClone(source.record.pending), recordSha256: handle.recordSha256 };
}

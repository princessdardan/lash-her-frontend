// Source-parent browser/pending composition. A plan or caller JSON is not an
// issued browser artifact. Live authority comes from this fixed child process.
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

const plans = new WeakMap(), controllers = new WeakMap(), artifacts = new WeakMap();
const controlledCaptures = new WeakMap(), naturalArtifacts = new WeakMap(), pendingArtifacts = new WeakMap();
const authenticationArtifacts = new WeakMap();
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

export function prepareP2LifecycleSuspensionPlan(candidate, input) {
  demand(closed(input, ["version", "actionId", "candidateSha256", "persistencePlan", "deployment", "target", "owner", "producer", "resources", "windowSeconds", "drainSeconds", "operatorSourceCommit"])
    && input.version === 1 && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && sha(input.candidateSha256)
    && input.windowSeconds === 840 && Number.isInteger(input.drainSeconds) && input.drainSeconds >= 1 && input.drainSeconds <= 180
    && closed(input.resources, ["userId", "courseId", "lessonId"]) && Object.values(input.resources).every(uuid)
    && input.operatorSourceCommit === commit());
  const fields = ["version", "environment", "releaseId", "hostMachineId", "candidateSha256", "configurationSha256", "sources", "targets", "containerImages",
    "operatorSourceSha256", "frontendDeploymentSha256", "originalReleaseSha256", "expectedMigrations"];
  const persistencePlan = prepareP2LifecyclePersistencePlan(Object.fromEntries(fields.map(name => [name, input.persistencePlan?.[name]]))), sourceCommit = persistencePlan.sources.frontend;
  demand(isDeepStrictEqual(input.persistencePlan, persistencePlan));
  demand(candidate?.version === 2 && candidate.environment === "staging" && candidate.contractPhase === "p2"
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
    && closed(input.target, ["host", "port", "database", "user", "serverMajor"])
    && input.target.host === persistencePlan.targets.frontend.host && input.target.port === persistencePlan.targets.frontend.port
    && input.target.database === persistencePlan.targets.frontend.database && input.target.serverMajor === persistencePlan.targets.frontend.serverMajor
    && input.target.user !== input.producer.role.name);
  const expectedBinding = { mode: "enforce", targetSha256: frontendAdmissionTargetSha256("staging", input.target),
    producerSha256: input.producer.producerSha256, sourceCommit, roleName: input.producer.role.name };
  demand(isDeepStrictEqual(expectedBinding, deployment.writerAdmissionBinding));
  const value = freeze({ version: 1, status: "P2_LIFECYCLE_SUSPENSION_SOURCE_PLAN", environment: "staging", profile: "normal-ui-suspension-pending-v1",
    actionId: input.actionId, releaseId: persistencePlan.releaseId, candidateSha256: input.candidateSha256, candidateObjectSha256: hash(candidate),
    sourceCommit, operatorSourceCommit: input.operatorSourceCommit, operatorSourceEligibility: "same-as-immutable-frontend-candidate",
    configurationSha256: persistencePlan.configurationSha256, configurationRecordSha256: deployment.configurationRecordSha256,
    resourceBindingSha256: hash(input.resources),
    targetSha256: expectedBinding.targetSha256, hostMachineId: persistencePlan.hostMachineId, deploymentId: deployment.deploymentId,
    deploymentUrl: deployment.deploymentUrl, browserProgramSha256: hash(Buffer.concat([committedProgramBytes(sourceCommit, "ops/platform/p2-lifecycle-browser-recorder.mjs"), Buffer.from(P2_LIFECYCLE_BROWSER_LAUNCHER)])),
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
    && record.sourceCommit === input.sourceCommit && record.deploymentId === input.deploymentId && record.deploymentUrl === input.deploymentUrl
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
    sourceCommit: plan.sourceCommit, deploymentId: plan.deploymentId, deploymentUrl: plan.deploymentUrl, ...reviewed.resources, windowSeconds: 840 };
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
  controllers.set(controller, { plan, input, values }); send("initialize", input); return controller;
}

export function readP2LifecycleBrowserControllerBinding(plan, controller) {
  const source = controllers.get(controller); demand(plans.has(plan) && source?.plan === plan);
  return { challenge: source.input.challenge, bindingSha256: source.input.bindingSha256 };
}
export function readP2LifecycleBrowserAuthentication(plan, handle) {
  const source = authenticationArtifacts.get(handle); demand(plans.has(plan) && source?.plan === plan && controllers.get(source.controller)?.plan === plan);
  return structuredClone(source.value);
}
export function readP2LifecycleBrowserSuspensionEvent(plan, controller) {
  const source = controllers.get(controller); demand(plans.has(plan) && source?.plan === plan && source.values.has("suspended"));
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
  demand(closed(value, ["version", "status", "bindingSha256", "capturePublic", "controlledCaptureMetadataSha256", "tokenBytesOutput", "credentialHashesOutput"])
    && value.version === 1 && value.status === "P2_SUSPENSION_CONTROLLED_CAPTURED" && value.bindingSha256 === hash(plan)
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
  demand(closed(value, ["version", "status", "bindingSha256", "user", "mux", "userWindowSha256", "muxWindowSha256", "tokenBytesOutput", "credentialHashesOutput"])
    && value.version === 1 && value.status === "P2_SUSPENSION_NATURAL_EXPIRY_OBSERVED" && value.bindingSha256 === hash(plan)
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

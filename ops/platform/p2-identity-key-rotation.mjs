// Fixed private child and public receipt qualifier for the deliberate P2
// application-user JWT rotation. The host controller is plan-only until the
// source-owned config-only certification parent is integrated.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { PROFILES, signProbeToken } from "./p2-identity-negative-probe.mjs";

const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const IMAGE = /^ghcr\.io\/princessdardan\/lash-her-platform-[a-z0-9-]+@sha256:[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PROFILES_ORDER = Object.freeze(Object.keys(PROFILES).sort());
const EVIDENCE_CLASS = Object.freeze({
  "course-learner": "actual-protected-course-http",
  "course-admin": "actual-protected-course-http",
  "community-member": "deployed-private-community-verifier",
  "community-admin": "deployed-private-community-verifier",
});
const TTL_SECONDS = 300;
const SKEW_SECONDS = 30;

export class RotationFailure extends Error {
  constructor(check) { super("P2_IDENTITY_KEY_ROTATION_REFUSED"); this.check = check; }
}
const demand = (value, check) => { if (!value) throw new RotationFailure(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());
const secret = value => typeof value === "string" && Buffer.byteLength(value) >= 32 && Buffer.byteLength(value) <= 8192
  && value.trim() === value && /^[!-~]+$/u.test(value);
const equal = (left, right) => typeof left === "string" && typeof right === "string"
  && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const digest = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");

function claims(profile, subject, now, random = randomUUID) {
  const admin = profile.endsWith("-admin");
  return { version: 1, iss: "lash-her-frontend", aud: PROFILES[profile].audience, sub: subject, iat: now,
    exp: now + TTL_SECONDS, jti: random(), ...(admin ? { capabilities: profile === "course-admin"
      ? ["course-editor", "course-support"] : ["community-moderator"] } : {}) };
}

export function validateRotationPrivateInput(input) {
  demand(closed(input, ["version", "mode", "environment", "bindingSha256", "phase", "profile", "subject", "courseId",
    "oldKey", "newKey", "oldToken", "newToken", "tokenIssuedAt", "tokenExpiresAt", "gatewayCaSha256", "configurationSha256",
    "runtimeEnvironment"]), "input-shape");
  demand(input.version === 1 && input.environment === "staging"
    && ["rotation-capture", "rotation-course-http", "rotation-community-verifier"].includes(input.mode)
    && ["pre-removal-overlap", "overlap", "current-only"].includes(input.phase) && PROFILES_ORDER.includes(input.profile)
    && (input.mode === "rotation-capture") === (input.phase === "pre-removal-overlap") && SHA.test(input.bindingSha256)
    && SHA.test(input.configurationSha256) && UUID.test(input.subject) && UUID.test(input.courseId)
    && secret(input.oldKey) && secret(input.newKey) && !equal(input.oldKey, input.newKey) && SHA.test(input.gatewayCaSha256), "rotation-binding");
  if (input.mode === "rotation-capture") {
    demand([input.oldToken, input.newToken, input.tokenIssuedAt, input.tokenExpiresAt, input.runtimeEnvironment].every(value => value === null),
      "capture-input");
  } else {
    demand(TOKEN.test(input.oldToken) && TOKEN.test(input.newToken) && input.oldToken !== input.newToken
      && ISO.test(input.tokenIssuedAt) && ISO.test(input.tokenExpiresAt)
      && Date.parse(input.tokenExpiresAt) - Date.parse(input.tokenIssuedAt) === TTL_SECONDS * 1000,
    "retained-token-input");
    validateRetainedToken(input.oldToken, input.oldKey, input, "old");
    validateRetainedToken(input.newToken, input.newKey, input, "new");
    demand((input.mode === "rotation-course-http") === (PROFILES[input.profile].service === "course"), "profile-evidence-class");
    demand(input.mode === "rotation-course-http" ? input.runtimeEnvironment === null
      : input.runtimeEnvironment && typeof input.runtimeEnvironment === "object" && !Array.isArray(input.runtimeEnvironment)
        && Object.entries(input.runtimeEnvironment).every(([key, value]) => /^[A-Z][A-Z0-9_]*$/u.test(key) && typeof value === "string"),
    "runtime-environment");
  }
  return input;
}

function decodeTokenPart(value, check) {
  try {
    const decoded = Buffer.from(value, "base64url");
    demand(decoded.toString("base64url") === value, check);
    return JSON.parse(decoded.toString("utf8"));
  }
  catch { throw new RotationFailure(check); }
}

function validateRetainedToken(token, key, input, label) {
  const parts = token.split(".");
  demand(parts.length === 3, `${label}-token-shape`);
  const header = decodeTokenPart(parts[0], `${label}-token-header`);
  const payload = decodeTokenPart(parts[1], `${label}-token-payload`);
  demand(closed(header, ["alg", "typ"]) && header.alg === "HS256" && header.typ === "JWT", `${label}-token-header`);
  const admin = input.profile.endsWith("-admin");
  const payloadFields = ["version", "iss", "aud", "sub", "iat", "exp", "jti", ...(admin ? ["capabilities"] : [])];
  const expectedCapabilities = input.profile === "course-admin" ? ["course-editor", "course-support"]
    : input.profile === "community-admin" ? ["community-moderator"] : null;
  demand(closed(payload, payloadFields) && payload.version === 1 && payload.iss === "lash-her-frontend"
    && payload.aud === PROFILES[input.profile].audience && payload.sub === input.subject
    && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp) && payload.exp - payload.iat === TTL_SECONDS
    && new Date(payload.iat * 1000).toISOString() === input.tokenIssuedAt
    && new Date(payload.exp * 1000).toISOString() === input.tokenExpiresAt
    && UUID.test(payload.jti) && (expectedCapabilities === null || canonical(payload.capabilities) === canonical(expectedCapabilities)),
  `${label}-token-claims`);
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  demand(equal(expected, parts[2]), `${label}-token-signature`);
  return payload;
}

export function captureRotationTokens(input, options = {}) {
  validateRotationPrivateInput(input); demand(input.mode === "rotation-capture", "capture-mode");
  const now = Math.floor((options.nowMs ?? Date.now)() / 1000);
  const oldClaims = claims(input.profile, input.subject, now, options.randomUuid);
  const newClaims = { ...oldClaims, jti: (options.randomUuid ?? randomUUID)() };
  demand(oldClaims.jti !== newClaims.jti, "token-jti-distinct");
  return Object.freeze({ version: 1, status: "P2_IDENTITY_ROTATION_PRIVATE_TOKENS_CAPTURED", environment: "staging",
    bindingSha256: input.bindingSha256, profile: input.profile, configurationSha256: input.configurationSha256,
    oldToken: signProbeToken(oldClaims, input.oldKey), newToken: signProbeToken(newClaims, input.newKey),
    tokenIssuedAt: new Date(now * 1000).toISOString(), tokenExpiresAt: new Date((now + TTL_SECONDS) * 1000).toISOString(),
    privateCredentialBytes: true, commonTokenBytesOutput: false, releaseAccepted: false });
}

function boundedRequest(options, makeRequest = request) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const pending = makeRequest({ ...options, agent: false, signal: AbortSignal.timeout(8_000) }, response => {
      let bytes = 0;
      response.on("data", chunk => { bytes += chunk.length; if (bytes > 65_536) response.destroy(new Error("P2_ROTATION_RESPONSE_BOUND")); });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400) return reject(new RotationFailure("redirect-refused"));
        const requestId = response.headers["x-request-id"];
        demand(typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(requestId), "request-id");
        resolve({ status: response.statusCode, requestId, observedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
      });
    });
    pending.once("error", reject); pending.end();
  });
}

function courseReader(ca, makeRequest) {
  return (path, token) => boundedRequest({ hostname: "course-tls", port: 8443, servername: "course-tls", rejectUnauthorized: true,
    minVersion: "TLSv1.2", ca, method: "GET", path, headers: { accept: "application/json", connection: "close",
      authorization: "Bearer " + token } }, makeRequest);
}

export async function observeCourseRotation(input, options = {}) {
  validateRotationPrivateInput(input); demand(input.mode === "rotation-course-http", "course-mode");
  const ca = options.ca ?? readFileSync("/tls/ca.pem");
  demand(digest(ca) === input.gatewayCaSha256, "running-ca-binding");
  const path = input.profile === "course-admin" ? `/v1/admin/courses/${input.courseId}` : `/v1/student/courses/${input.courseId}`;
  const read = options.read ?? courseReader(ca, options.request);
  const oldResult = await read(path, input.oldToken);
  const newResult = await read(path, input.newToken);
  const expectedOld = input.phase === "overlap" ? 200 : 401;
  demand(oldResult.status === expectedOld && newResult.status === 200, "course-rotation-response");
  let capabilityEnforced = true;
  if (input.profile === "course-admin") {
    const issued = Math.floor(Date.parse(input.tokenIssuedAt) / 1000);
    const supportOnly = { ...claims(input.profile, input.subject, issued, options.randomUuid), capabilities: ["course-support"] };
    capabilityEnforced = (await read(path, signProbeToken(supportOnly, input.newKey))).status === 403;
    demand(capabilityEnforced, "course-capability-enforcement");
  }
  return privateReceipt(input, oldResult.status === 200 ? "accepted" : "rejected", "accepted", {
    oldHttpStatus: oldResult.status, newHttpStatus: newResult.status, oldRequestId: oldResult.requestId, newRequestId: newResult.requestId,
    observedAt: newResult.observedAt, capabilityEnforced,
  });
}

async function loadCommunityVerifier(options) {
  if (options.loadVerifier) return options.loadVerifier();
  const implementation = await import("/app/dist/auth/community-user-auth.js");
  const configured = { ...await import("/app/dist/config/env.js"), ...await import("/app/dist/config/runtime.js") };
  return { implementation, configured };
}

export async function observeCommunityRotation(input, options = {}) {
  validateRotationPrivateInput(input); demand(input.mode === "rotation-community-verifier", "community-mode");
  const environment = options.environment ?? process.env, prefix = PROFILES[input.profile].prefix;
  demand(environment.DATABASE_TARGET === "staging" && Object.entries(input.runtimeEnvironment).every(([key, value]) => equal(environment[key], value)),
    "running-runtime-configuration");
  demand(equal(environment[`${prefix}_JWT_CURRENT_SECRET`], input.newKey)
    && (input.phase === "overlap" ? equal(environment[`${prefix}_JWT_PREVIOUS_SECRET`], input.oldKey)
      : environment[`${prefix}_JWT_PREVIOUS_SECRET`] === undefined), "running-key-configuration");
  const { implementation, configured } = await loadCommunityVerifier(options);
  demand(typeof configured.resolveCommunityUserRuntime === "function" && configured.env && typeof configured.env === "object",
    "community-runtime-module");
  demand(equal(configured.env[`${prefix}_JWT_CURRENT_SECRET`], input.newKey)
    && (input.phase === "overlap" ? equal(configured.env[`${prefix}_JWT_PREVIOUS_SECRET`], input.oldKey)
      : configured.env[`${prefix}_JWT_PREVIOUS_SECRET`] === undefined), "parsed-runtime-key-configuration");
  const runtime = configured.resolveCommunityUserRuntime(configured.env);
  const verifier = implementation.createCommunityUserVerifier(runtime);
  const verify = token => verifier[input.profile === "community-admin" ? "verifyAdmin" : "verifyMember"]("Bearer " + token);
  const oldResult = verify(input.oldToken);
  const newResult = verify(input.newToken);
  demand(Boolean(oldResult) === (input.phase === "overlap") && Boolean(newResult), "community-rotation-response");
  let capabilityEnforced = true;
  if (input.profile === "community-admin") {
    const issued = Math.floor(Date.parse(input.tokenIssuedAt) / 1000);
    const invalid = { ...claims(input.profile, input.subject, issued, options.randomUuid), capabilities: [] };
    capabilityEnforced = verify(signProbeToken(invalid, input.newKey)) === null;
    demand(capabilityEnforced, "community-capability-enforcement");
  }
  return privateReceipt(input, oldResult ? "accepted" : "rejected", "accepted", {
    oldHttpStatus: null, newHttpStatus: null, oldRequestId: null, newRequestId: null,
    observedAt: new Date((options.nowMs ?? Date.now)()).toISOString(), capabilityEnforced,
  });
}

function privateReceipt(input, oldResult, newResult, extra) {
  const configuredVerifier = input.mode === "rotation-community-verifier";
  return { version: 1, status: "P2_IDENTITY_ROTATION_PRIVATE_OBSERVED", environment: "staging", bindingSha256: input.bindingSha256,
    phase: input.phase, profile: input.profile, evidenceClass: EVIDENCE_CLASS[input.profile], configurationSha256: input.configurationSha256,
    previousConfigured: configuredVerifier ? input.phase === "overlap" : null, oldResult, newResult,
    oldTokenIssuedAt: input.tokenIssuedAt, oldTokenExpiresAt: input.tokenExpiresAt,
    runtimeConfigurationBindingVerified: configuredVerifier, retainedTokenContinuityVerified: true,
    ...extra, tokenBytesOutput: false, credentialHashesOutput: false, releaseAccepted: false };
}

function evidenceRow(value, phase) {
  demand(closed(value, ["profile", "evidenceClass", "configurationSha256", "sourceCommit", "containers", "previousConfigured",
    "oldResult", "newResult", "oldTokenIssuedAt", "oldTokenExpiresAt", "observedAt", "runtimeConfigurationBindingVerified",
    "retainedTokenContinuityVerified", "capabilityEnforced", "oldHttpStatus", "newHttpStatus", "oldRequestId", "newRequestId", "moduleSha256"])
    && PROFILES_ORDER.includes(value.profile) && value.evidenceClass === EVIDENCE_CLASS[value.profile] && SHA.test(value.configurationSha256)
    && COMMIT.test(value.sourceCommit) && Array.isArray(value.containers)
    && value.previousConfigured === (phase === "overlap") && value.oldResult === (phase === "overlap" ? "accepted" : "rejected")
    && value.newResult === "accepted" && ISO.test(value.oldTokenIssuedAt) && ISO.test(value.oldTokenExpiresAt) && ISO.test(value.observedAt)
    && Date.parse(value.oldTokenExpiresAt) - Date.parse(value.oldTokenIssuedAt) === TTL_SECONDS * 1000
    && Date.parse(value.oldTokenIssuedAt) <= Date.parse(value.observedAt) && Date.parse(value.oldTokenExpiresAt) > Date.parse(value.observedAt)
    && value.runtimeConfigurationBindingVerified === true && value.retainedTokenContinuityVerified === true
    && value.capabilityEnforced === true && value.moduleSha256 && typeof value.moduleSha256 === "object" && !Array.isArray(value.moduleSha256)
    && Object.keys(value.moduleSha256).length >= 1 && Object.keys(value.moduleSha256).length <= 10
    && Object.values(value.moduleSha256).every(item => SHA.test(item)), "rotation-evidence");
  if (value.profile.startsWith("course-")) demand(value.oldHttpStatus === (phase === "overlap" ? 200 : 401)
    && value.newHttpStatus === 200 && typeof value.oldRequestId === "string" && typeof value.newRequestId === "string", "course-http-evidence");
  else demand([value.oldHttpStatus, value.newHttpStatus, value.oldRequestId, value.newRequestId].every(item => item === null), "community-private-evidence");
  const expectedServices = value.profile.startsWith("course-") ? ["course-api", "gateway"] : ["community-api"];
  demand(value.containers.length === expectedServices.length && value.containers.every(row => closed(row, ["service", "containerId", "image"])
    && expectedServices.includes(row.service) && /^[a-f0-9]{64}$/u.test(row.containerId) && IMAGE.test(row.image))
    && value.containers.map(row => row.service).sort().join() === expectedServices.join(), "profile-container-evidence");
  return value;
}

export function qualifyIdentityKeyRotation(input) {
  demand(closed(input, ["version", "environment", "actionId", "bindingSha256", "candidateSha256", "sourceCommit", "hostMachineId", "parent",
    "baselineConfigurationSha256", "overlap", "currentOnly", "restorationTargetSha256"])
    && input.version === 1 && input.environment === "staging" && /^p2-key-rotation-[a-z0-9-]{1,40}$/u.test(input.actionId)
    && [input.bindingSha256, input.candidateSha256, input.baselineConfigurationSha256, input.restorationTargetSha256].every(item => SHA.test(item))
    && COMMIT.test(input.sourceCommit)
    && /^[a-f0-9]{32}$/u.test(input.hostMachineId), "qualification-input");
  demand(closed(input.parent, ["sourceOwnedFixedAction", "hostLockHeld", "frontendPhysicalLockHeld", "configOnly", "sqlExecuted",
    "rolesPrepared", "loginChanged", "serviceCredentialsUnchanged", "providerStateReconciled", "restorationQualified"])
    && Object.entries(input.parent).every(([key, value]) => ["sqlExecuted", "rolesPrepared", "loginChanged"].includes(key) ? value === false : value === true),
  "parent-authority");
  for (const [name, phase] of [["overlap", input.overlap], ["currentOnly", input.currentOnly]]) {
    demand(closed(phase, ["configurationSha256", "startedAt", "completedAt", "frontendIssuanceCutoffAt", "profiles"])
      && SHA.test(phase.configurationSha256) && ISO.test(phase.startedAt) && ISO.test(phase.completedAt) && ISO.test(phase.frontendIssuanceCutoffAt)
      && Date.parse(phase.startedAt) <= Date.parse(phase.frontendIssuanceCutoffAt)
      && Date.parse(phase.frontendIssuanceCutoffAt) <= Date.parse(phase.completedAt)
      && Array.isArray(phase.profiles) && phase.profiles.length === 4,
    "phase-evidence");
    phase.profiles.forEach(row => evidenceRow(row, name === "overlap" ? "overlap" : "current-only"));
    demand(phase.profiles.map(row => row.profile).sort().join() === PROFILES_ORDER.join()
      && phase.profiles.every(row => row.configurationSha256 === phase.configurationSha256 && row.sourceCommit === input.sourceCommit
        && Date.parse(row.observedAt) >= Date.parse(phase.frontendIssuanceCutoffAt)
        && Date.parse(row.observedAt) <= Date.parse(phase.completedAt)),
    "complete-profile-evidence");
  }
  demand(Date.parse(input.overlap.completedAt) <= Date.parse(input.currentOnly.startedAt), "phase-order");
  demand(Date.parse(input.currentOnly.startedAt) - Date.parse(input.overlap.frontendIssuanceCutoffAt) >= (TTL_SECONDS + SKEW_SECONDS) * 1000,
    "overlap-drain-window");
  for (const profile of PROFILES_ORDER) {
    const before = input.overlap.profiles.find(row => row.profile === profile);
    const after = input.currentOnly.profiles.find(row => row.profile === profile);
    demand(before.oldTokenIssuedAt === after.oldTokenIssuedAt && before.oldTokenExpiresAt === after.oldTokenExpiresAt,
      "retained-token-continuity");
    demand(Date.parse(before.oldTokenIssuedAt) >= Date.parse(input.overlap.frontendIssuanceCutoffAt)
        + (TTL_SECONDS + SKEW_SECONDS) * 1000
      && Date.parse(before.oldTokenIssuedAt) <= Date.parse(input.overlap.completedAt)
      && Date.parse(before.oldTokenIssuedAt) < Date.parse(input.currentOnly.startedAt), "retained-token-capture-window");
  }
  demand([input.baselineConfigurationSha256, input.overlap.configurationSha256].includes(input.restorationTargetSha256),
    "restoration-target");
  return Object.freeze({ version: 1, status: "P2_IDENTITY_KEY_ROTATION_QUALIFIED", environment: "staging", actionId: input.actionId,
    bindingSha256: input.bindingSha256, candidateSha256: input.candidateSha256, sourceCommit: input.sourceCommit, hostMachineId: input.hostMachineId,
    baselineConfigurationSha256: input.baselineConfigurationSha256, overlapConfigurationSha256: input.overlap.configurationSha256,
    currentOnlyConfigurationSha256: input.currentOnly.configurationSha256, restorationTargetSha256: input.restorationTargetSha256,
    configuredUserTtlSeconds: TTL_SECONDS, configuredClockSkewSeconds: SKEW_SECONDS, overlapDrainSeconds: TTL_SECONDS + SKEW_SECONDS,
    profileEvidence: input.currentOnly.profiles.map(row => ({ profile: row.profile, evidenceClass: row.evidenceClass,
      oldResult: row.oldResult, newResult: row.newResult, previousConfigured: row.previousConfigured, observedAt: row.observedAt,
      configurationSha256: row.configurationSha256, sourceCommit: row.sourceCommit, containers: row.containers })),
    serviceCredentialsUnchanged: true, actualProtectedCourseHttp: true, communityEvidenceClass: "deployed-private-community-verifier",
    tokenBytesOutput: false, credentialHashesOutput: false, sqlExecuted: false, rolesPrepared: false, loginChanged: false,
    keyRemovalVerified: true, releaseAccepted: false });
}

export async function runPrivateRotationFromStdin() {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; demand(size <= 262_144, "input-bound"); chunks.push(chunk); }
    const input = validateRotationPrivateInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const value = input.mode === "rotation-capture" ? captureRotationTokens(input)
      : input.mode === "rotation-course-http" ? await observeCourseRotation(input) : await observeCommunityRotation(input);
    process.stdout.write(canonical(value) + "\n");
  } catch (error) {
    const check = error instanceof RotationFailure && /^[a-z0-9.-]{1,100}$/u.test(error.check) ? error.check : "private-rotation-failed";
    process.stdout.write(canonical({ version: 1, status: "P2_IDENTITY_ROTATION_PRIVATE_REFUSED", check,
      tokenBytesOutput: false, credentialHashesOutput: false, releaseAccepted: false }) + "\n");
    process.exitCode = 1;
  }
}

export const P2_IDENTITY_ROTATION_CONSTANTS = Object.freeze({ TTL_SECONDS, SKEW_SECONDS, PROFILES_ORDER, EVIDENCE_CLASS });

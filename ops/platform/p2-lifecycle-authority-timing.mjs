// Private S13 child and receipt qualifier. This module is embedded with the
// reviewed identity helper and evaluated only in the selected gateway image.
// Credential-bearing child results are private input to the host controller;
// public receipts are constructed only by qualifyS13AuthorityTiming.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { pathToFileURL } from "node:url";
import { PROFILES, signProbeToken } from "./p2-identity-negative-probe.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PLAYBACK_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const USER_TTL_SECONDS = 300;
const USER_SKEW_SECONDS = 30;
const PLAYBACK_TTL_SECONDS = 600;
const MAX_RESPONSE_BYTES = 131_072;

export class P2AuthorityTimingError extends Error {
  constructor(check) { super("P2_AUTHORITY_TIMING_REFUSED"); this.check = check; }
}
const demand = (condition, check) => { if (!condition) throw new P2AuthorityTimingError(check); };
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());
const integer = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const sha = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const iso = value => new Date(value).toISOString();

function decodeJwt(token) {
  demand(typeof token === "string" && TOKEN.test(token) && token.length <= 16_384, "jwt-shape");
  try {
    const [header, payload] = token.split(".").slice(0, 2).map(part => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    demand(header && typeof header === "object" && !Array.isArray(header) && payload && typeof payload === "object" && !Array.isArray(payload), "jwt-shape");
    return { header, payload };
  } catch (error) {
    if (error instanceof P2AuthorityTimingError) throw error;
    throw new P2AuthorityTimingError("jwt-shape");
  }
}

function validateCommon(input) {
  demand(input.version === 1 && input.environment === "staging" && SHA.test(input.bindingSha256), "staging-binding");
  return input;
}

export function validatePrivateTimingInput(input) {
  demand(input && typeof input === "object" && !Array.isArray(input), "input-shape");
  if (input.mode === "s13-capture") {
    demand(closed(input, ["version", "mode", "environment", "bindingSha256", "subject", "courseId", "lessonId", "currentKey", "gatewayCaSha256"]), "input-shape");
    validateCommon(input);
    demand(UUID.test(input.subject) && UUID.test(input.courseId) && UUID.test(input.lessonId) && input.courseId !== input.lessonId,
      "owned-fixture-binding");
    demand(typeof input.currentKey === "string" && Buffer.byteLength(input.currentKey) >= 32 && Buffer.byteLength(input.currentKey) <= 8192
      && /^[!-~]+$/u.test(input.currentKey) && SHA.test(input.gatewayCaSha256), "private-key-binding");
    return input;
  }
  if (input.mode === "s13-user-observe") {
    demand(closed(input, ["version", "mode", "environment", "bindingSha256", "subject", "courseId", "userToken", "iat", "exp", "gatewayCaSha256"]), "input-shape");
    validateCommon(input);
    demand(UUID.test(input.subject) && UUID.test(input.courseId) && integer(input.iat) && integer(input.exp)
      && input.exp - input.iat === USER_TTL_SECONDS && SHA.test(input.gatewayCaSha256), "user-observation-binding");
    const token = decodeJwt(input.userToken).payload;
    demand(token.version === 1 && token.iss === "lash-her-frontend" && token.aud === PROFILES["course-learner"].audience
      && token.sub === input.subject && token.iat === input.iat && token.exp === input.exp && UUID.test(token.jti)
      && Object.keys(token).sort().join() === ["aud", "exp", "iat", "iss", "jti", "sub", "version"].sort().join(), "controlled-user-token-binding");
    return input;
  }
  if (input.mode === "s13-mux-observe") {
    demand(closed(input, ["version", "mode", "environment", "bindingSha256", "requestUrl", "playbackId", "exp"]), "input-shape");
    validateCommon(input);
    validateMuxUrl(input.requestUrl, input.playbackId, input.exp);
    return input;
  }
  throw new P2AuthorityTimingError("input-mode");
}

function validateMuxUrl(raw, expectedPlaybackId, expectedExp) {
  demand(typeof raw === "string" && raw.length <= 20_000 && PLAYBACK_ID.test(expectedPlaybackId) && integer(expectedExp), "mux-private-binding");
  let url;
  try { url = new URL(raw); } catch { throw new P2AuthorityTimingError("mux-url"); }
  demand(url.protocol === "https:" && url.hostname === "stream.mux.com" && url.port === "" && url.username === "" && url.password === ""
    && url.hash === "" && url.pathname === `/${expectedPlaybackId}.m3u8` && [...url.searchParams.keys()].join() === "token"
    && url.searchParams.getAll("token").length === 1, "mux-url");
  const token = url.searchParams.get("token"), decoded = decodeJwt(token);
  demand(decoded.payload.sub === expectedPlaybackId && decoded.payload.aud === "v" && decoded.payload.exp === expectedExp
    && integer(decoded.payload.exp), "mux-token-binding");
  return { url, token };
}

function httpDate(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  demand(Number.isFinite(parsed), "http-date");
  return new Date(parsed).toISOString();
}

function boundedRequest(options, makeRequest = request) {
  const startedAtMs = Date.now(), startedMonotonicMs = performance.now();
  return new Promise((resolve, reject) => {
    const pending = makeRequest({ ...options, agent: false, signal: AbortSignal.timeout(10_000) }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) response.destroy(new Error("P2_S13_RESPONSE_BOUND"));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400) return reject(new P2AuthorityTimingError("redirect-refused"));
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks),
          contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"].split(";", 1)[0].trim().toLowerCase() : null,
          cacheControl: typeof response.headers["cache-control"] === "string" ? response.headers["cache-control"] : null,
          requestId: typeof response.headers["x-request-id"] === "string" && REQUEST_ID.test(response.headers["x-request-id"]) ? response.headers["x-request-id"] : null,
          serverDate: httpDate(response.headers.date),
          requestStartedAt: iso(startedAtMs),
          responseEndedAt: iso(Date.now()),
          elapsedMs: Math.max(0, Math.ceil(performance.now() - startedMonotonicMs)),
        });
      });
    });
    pending.once("error", reject); pending.end();
  });
}

function courseReader(ca, makeRequest) {
  return (path, token) => {
    demand(/^\/v1\/student\/(?:courses\/[a-f0-9-]{36}|lessons\/[a-f0-9-]{36}\/playback)$/u.test(path), "course-path");
    return boundedRequest({ hostname: "course-tls", port: 8443, servername: "course-tls", rejectUnauthorized: true, minVersion: "TLSv1.2",
      ca, method: "GET", path, headers: { accept: "application/json", connection: "close", authorization: `Bearer ${token}` } }, makeRequest);
  };
}

async function muxRead(rawUrl, makeRequest) {
  const url = new URL(rawUrl);
  return boundedRequest({ hostname: "stream.mux.com", port: 443, servername: "stream.mux.com", rejectUnauthorized: true, minVersion: "TLSv1.2",
    method: "GET", path: url.pathname + url.search, headers: { accept: "application/vnd.apple.mpegurl", connection: "close" } }, makeRequest);
}

export async function captureAuthorityTiming(input, options = {}) {
  validatePrivateTimingInput(input); demand(input.mode === "s13-capture", "capture-mode");
  const ca = options.ca ?? readFileSync("/tls/ca.pem");
  demand(sha(ca) === input.gatewayCaSha256, "running-ca-binding");
  const now = Math.floor((options.nowMs ?? Date.now)() / 1000);
  const claims = { version: 1, iss: "lash-her-frontend", aud: PROFILES["course-learner"].audience, sub: input.subject,
    iat: now, exp: now + USER_TTL_SECONDS, jti: (options.randomUuid ?? randomUUID)() };
  const userToken = signProbeToken(claims, input.currentKey);
  const readCourse = options.readCourse ?? courseReader(ca, options.courseRequest);
  const course = await readCourse(`/v1/student/courses/${input.courseId}`, userToken);
  demand(course.status === 200 && course.contentType === "application/json" && course.cacheControl?.includes("no-store"), "controlled-user-baseline");
  const playback = await readCourse(`/v1/student/lessons/${input.lessonId}/playback`, userToken);
  demand(playback.status === 200 && playback.contentType === "application/json" && playback.cacheControl?.includes("no-store"), "course-playback-baseline");
  let body;
  try { body = JSON.parse(playback.body.toString("utf8")); } catch { throw new P2AuthorityTimingError("course-playback-body"); }
  demand(body && typeof body === "object" && !Array.isArray(body) && PLAYBACK_ID.test(body.playbackId)
    && typeof body.playbackToken === "string" && ISO.test(body.expiresAt), "course-playback-body");
  const token = decodeJwt(body.playbackToken), playbackExp = token.payload.exp;
  demand(integer(playbackExp) && token.payload.sub === body.playbackId && token.payload.aud === "v"
    && Date.parse(body.expiresAt) === playbackExp * 1000, "course-playback-token");
  const courseDateSeconds = Math.floor(Date.parse(playback.serverDate) / 1000);
  demand(playbackExp - courseDateSeconds >= 598 && playbackExp - courseDateSeconds <= PLAYBACK_TTL_SECONDS, "course-playback-freshness");
  const requestUrl = `https://stream.mux.com/${body.playbackId}.m3u8?token=${encodeURIComponent(body.playbackToken)}`;
  validateMuxUrl(requestUrl, body.playbackId, playbackExp);
  const mux = await (options.readMux ?? muxRead)(requestUrl, options.muxRequest);
  demand([200, 206].includes(mux.status), "mux-initial-access");
  return { version: 1, status: "P2_S13_PRIVATE_CAPTURED", bindingSha256: input.bindingSha256,
    controlledUser: { token: userToken, iat: claims.iat, exp: claims.exp, jti: claims.jti, baseline: publicHttp(course) },
    playback: { requestUrl, playbackId: body.playbackId, exp: playbackExp, courseAuthorization: publicHttp(playback), initialProviderAccess: publicHttp(mux) },
    labels: { userIssuer: "operator-controlled-source-signed-course-learner", frontendUserJwtCaptured: false,
      playbackIssuer: "actual-course-mux-signer", authorizationQuotaConsumed: true,
      domainStateEffect: "video-asset-last-token-expires-at-only" } };
}

function publicHttp(value) {
  return { status: value.status, serverDate: value.serverDate, requestStartedAt: value.requestStartedAt,
    responseEndedAt: value.responseEndedAt, elapsedMs: value.elapsedMs, requestId: value.requestId };
}

export async function observeUserAuthority(input, options = {}) {
  validatePrivateTimingInput(input); demand(input.mode === "s13-user-observe", "user-observe-mode");
  const ca = options.ca ?? readFileSync("/tls/ca.pem");
  demand(sha(ca) === input.gatewayCaSha256, "running-ca-binding");
  const observation = await (options.readCourse ?? courseReader(ca, options.courseRequest))(`/v1/student/courses/${input.courseId}`, input.userToken);
  demand([200, 401].includes(observation.status), "user-expiry-status");
  return { version: 1, status: "P2_S13_PRIVATE_USER_OBSERVED", bindingSha256: input.bindingSha256,
    iat: input.iat, exp: input.exp, observation: publicHttp(observation) };
}

export async function observeMuxAuthority(input, options = {}) {
  validatePrivateTimingInput(input); demand(input.mode === "s13-mux-observe", "mux-observe-mode");
  const observation = await (options.readMux ?? muxRead)(input.requestUrl, options.muxRequest);
  demand([200, 206, 401, 403].includes(observation.status), "mux-expiry-status");
  return { version: 1, status: "P2_S13_PRIVATE_MUX_OBSERVED", bindingSha256: input.bindingSha256,
    exp: input.exp, observation: publicHttp(observation) };
}

function timingObservation(value, expectedStatuses) {
  demand(closed(value, ["status", "serverDate", "requestStartedAt", "responseEndedAt", "elapsedMs", "requestId"])
    && expectedStatuses.includes(value.status) && ISO.test(value.serverDate) && ISO.test(value.requestStartedAt) && ISO.test(value.responseEndedAt)
    && integer(value.elapsedMs) && value.elapsedMs <= 30_000 && (value.requestId === null || REQUEST_ID.test(value.requestId)), "timing-observation");
  demand(Date.parse(value.requestStartedAt) <= Date.parse(value.responseEndedAt), "timing-order");
  const server = Date.parse(value.serverDate), started = Date.parse(value.requestStartedAt), ended = Date.parse(value.responseEndedAt);
  // HTTP Date is rounded to one second. It must still overlap the observed
  // request interval when that rounding interval is considered.
  demand(server + 1000 >= started && server <= ended + 1000, "http-clock-disagreement");
  return value;
}

function browserReceipt(value) {
  demand(closed(value, ["version", "status", "evidenceClass", "sourceSha256", "artifactSha256", "suspension", "renewal", "player"])
    && value.version === 1 && value.status === "P2_S12_NORMAL_UI_SUSPENSION_OBSERVED"
    && value.evidenceClass === "external-source-browser-machine-artifact" && SHA.test(value.sourceSha256) && SHA.test(value.artifactSha256), "browser-receipt");
  demand(closed(value.suspension, ["commandId", "accountVersion", "issuedAt", "requestId", "httpStatus"])
    && UUID.test(value.suspension.commandId) && integer(value.suspension.accountVersion) && value.suspension.accountVersion >= 1
    && ISO.test(value.suspension.issuedAt) && REQUEST_ID.test(value.suspension.requestId) && value.suspension.httpStatus === 202, "browser-suspension");
  demand(closed(value.renewal, ["requestId", "httpStatus", "observedAt"])
    && REQUEST_ID.test(value.renewal.requestId) && value.renewal.httpStatus === 401 && ISO.test(value.renewal.observedAt), "browser-renewal");
  demand(closed(value.player, ["selector", "count", "observedAt", "traceEventCount"])
    && value.player.selector === "mux-player" && value.player.count === 0 && ISO.test(value.player.observedAt)
    && integer(value.player.traceEventCount) && value.player.traceEventCount >= 2, "browser-player");
  return value;
}

function pendingReceipt(value, command) {
  demand(closed(value, ["version", "status", "sourceSha256", "configurationSha256", "commandId", "accountVersion", "capturedAt", "deliveries", "laterCommandCount"])
    && value.version === 1 && value.status === "P2_S13_FRONTEND_PENDING_STATE_OBSERVED" && SHA.test(value.sourceSha256)
    && SHA.test(value.configurationSha256) && value.commandId === command.commandId && value.accountVersion === command.accountVersion
    && ISO.test(value.capturedAt) && value.laterCommandCount === 0 && Array.isArray(value.deliveries) && value.deliveries.length === 2, "pending-state");
  demand(value.deliveries.map(row => row.receiver).join() === "course,community" && value.deliveries.every(row => closed(row, ["receiver", "status", "attempts", "leaseId", "acknowledgedAt"])
    && row.status === "pending" && row.attempts === 0 && row.leaseId === null && row.acknowledgedAt === null), "pending-state");
  return value;
}

function lifecycleReceipt(value) {
  const required = ["version", "status", "profile", "candidateSha256", "configurationSha256", "sourceSha256", "targetSha256", "witnessSha256",
    "commandCount", "pendingOrDeliveringCount", "receiverAcknowledgedCount", "rowCounts", "readOnly", "providerTouched", "releaseAccepted",
    "privateRecordSha256", "operatorProgramSha256", "commandId", "accountVersion"];
  demand(closed(value, required) && value.version === 1 && value.status === "P2_LIFECYCLE_ACCOUNT_STATE_WITNESSED" && value.profile === "lifecycle-account-v1"
    && [value.candidateSha256, value.configurationSha256, value.sourceSha256, value.targetSha256, value.witnessSha256,
      value.privateRecordSha256, value.operatorProgramSha256].every(item => SHA.test(item))
    && UUID.test(value.commandId) && integer(value.accountVersion) && value.accountVersion >= 1
    && integer(value.commandCount) && value.pendingOrDeliveringCount === 0 && value.receiverAcknowledgedCount === 2
    && closed(value.rowCounts, ["frontend", "course", "community"]) && Object.values(value.rowCounts).every(integer)
    && value.readOnly === true && value.providerTouched === false && value.releaseAccepted === false, "lifecycle-witness");
  return value;
}

function s12Receipt(value) {
  demand(closed(value, ["receiptSha256", "sourceSha256", "configurationSha256", "commandId", "accountVersion", "action", "nativeScheduleEnabled", "workerInvokedAt", "receiverDeniedCount"])
    && SHA.test(value.receiptSha256) && SHA.test(value.sourceSha256) && SHA.test(value.configurationSha256)
    && UUID.test(value.commandId) && integer(value.accountVersion) && value.accountVersion >= 1 && value.action === "suspend"
    && value.nativeScheduleEnabled === false && ISO.test(value.workerInvokedAt) && value.receiverDeniedCount === 2,
  "s12-receipt");
  return value;
}

export function qualifyS13AuthorityTiming(input) {
  demand(closed(input, ["version", "environment", "bindingSha256", "capturePublic", "user", "mux", "pending", "browser", "lifecycle", "s12"])
    && input.version === 1 && input.environment === "staging" && SHA.test(input.bindingSha256), "qualification-input");
  const capture = input.capturePublic;
  demand(closed(capture, ["controlledUser", "playback", "labels"]) && closed(capture.controlledUser, ["iat", "exp", "baseline"])
    && integer(capture.controlledUser.iat) && capture.controlledUser.exp - capture.controlledUser.iat === USER_TTL_SECONDS
    && closed(capture.playback, ["exp", "courseAuthorization", "initialProviderAccess"])
    && integer(capture.playback.exp) && capture.labels?.userIssuer === "operator-controlled-source-signed-course-learner"
    && capture.labels.frontendUserJwtCaptured === false && capture.labels.playbackIssuer === "actual-course-mux-signer"
    && capture.labels.authorizationQuotaConsumed === true && capture.labels.domainStateEffect === "video-asset-last-token-expires-at-only", "capture-public");
  timingObservation(capture.controlledUser.baseline, [200]); timingObservation(capture.playback.courseAuthorization, [200]);
  timingObservation(capture.playback.initialProviderAccess, [200, 206]);
  const user = input.user;
  demand(closed(user, ["lastAccepted", "firstDenied", "pollResolutionMs"])
    && integer(user.pollResolutionMs) && user.pollResolutionMs > 0 && user.pollResolutionMs <= 2000, "user-window");
  timingObservation(user.lastAccepted, [200]); timingObservation(user.firstDenied, [401]);
  const browser = browserReceipt(input.browser);
  const userBoundaryMs = capture.controlledUser.exp * 1000 + USER_SKEW_SECONDS * 1000;
  demand(Date.parse(capture.playback.initialProviderAccess.responseEndedAt) <= Date.parse(input.browser.suspension.issuedAt)
    && Date.parse(input.browser.suspension.issuedAt) <= Date.parse(user.lastAccepted.requestStartedAt)
    && Date.parse(user.lastAccepted.requestStartedAt) < userBoundaryMs
    && Date.parse(user.firstDenied.requestStartedAt) >= userBoundaryMs
    && Date.parse(user.firstDenied.requestStartedAt) - userBoundaryMs <= user.pollResolutionMs, "user-expiry-boundary");
  const pending = pendingReceipt(input.pending, browser.suspension), lifecycle = lifecycleReceipt(input.lifecycle),
    s12 = s12Receipt(input.s12);
  demand(lifecycle.commandId === browser.suspension.commandId && lifecycle.accountVersion === browser.suspension.accountVersion
    && s12.commandId === browser.suspension.commandId && s12.accountVersion === browser.suspension.accountVersion,
  "lifecycle-command-binding");
  demand(Date.parse(pending.capturedAt) >= Date.parse(user.firstDenied.responseEndedAt), "pending-after-expiry");
  demand(Date.parse(s12.workerInvokedAt) > Date.parse(user.firstDenied.responseEndedAt), "worker-not-after-user-expiry");
  const mux = input.mux;
  demand(closed(mux, ["lastAccepted", "firstDenied", "pollResolutionMs"]) && integer(mux.pollResolutionMs)
    && mux.pollResolutionMs > 0 && mux.pollResolutionMs <= 2000, "mux-window");
  timingObservation(mux.lastAccepted, [200, 206]); timingObservation(mux.firstDenied, [401, 403]);
  const muxBoundaryMs = capture.playback.exp * 1000;
  demand(Date.parse(mux.lastAccepted.requestStartedAt) < muxBoundaryMs && Date.parse(mux.firstDenied.requestStartedAt) >= muxBoundaryMs
    && Date.parse(mux.firstDenied.requestStartedAt) - muxBoundaryMs <= mux.pollResolutionMs, "mux-expiry-boundary");
  demand(Date.parse(browser.renewal.observedAt) >= Date.parse(browser.suspension.issuedAt)
    && Date.parse(browser.player.observedAt) >= Date.parse(browser.suspension.issuedAt)
    && Date.parse(browser.renewal.observedAt) <= muxBoundaryMs && Date.parse(browser.player.observedAt) <= muxBoundaryMs,
    "renewal-removal-not-bounded");
  return Object.freeze({ version: 1, status: "P2_S13_AUTHORITY_TIMING_QUALIFIED", environment: "staging", bindingSha256: input.bindingSha256,
    controlledUserIssuer: "operator-controlled-source-signed-course-learner", frontendUserJwtCaptured: false,
    userClaimIssuedAt: iso(capture.controlledUser.iat * 1000), userClaimExpiresAt: iso(capture.controlledUser.exp * 1000),
    configuredUserTtlSeconds: USER_TTL_SECONDS, configuredUserSkewSeconds: USER_SKEW_SECONDS,
    userLastAcceptedAt: user.lastAccepted.responseEndedAt, userLastAcceptedServerDate: user.lastAccepted.serverDate,
    userFirstDeniedAt: user.firstDenied.responseEndedAt, userFirstDeniedServerDate: user.firstDenied.serverDate,
    userDenialEvaluationBracket: { lower: user.lastAccepted.requestStartedAt, upper: user.firstDenied.responseEndedAt },
    userFirstDeniedElapsedFromClaimMs: Date.parse(user.firstDenied.responseEndedAt) - capture.controlledUser.iat * 1000,
    userPollResolutionMs: user.pollResolutionMs, playbackExpiresAt: iso(capture.playback.exp * 1000), configuredPlaybackTtlSeconds: PLAYBACK_TTL_SECONDS,
    muxLastAcceptedAt: mux.lastAccepted.responseEndedAt, muxLastAcceptedServerDate: mux.lastAccepted.serverDate,
    muxFirstDeniedAt: mux.firstDenied.responseEndedAt, muxFirstDeniedServerDate: mux.firstDenied.serverDate,
    muxDenialEvaluationBracket: { lower: mux.lastAccepted.requestStartedAt, upper: mux.firstDenied.responseEndedAt },
    muxFirstDeniedElapsedFromExpiryMs: Date.parse(mux.firstDenied.responseEndedAt) - capture.playback.exp * 1000,
    muxPollResolutionMs: mux.pollResolutionMs,
    renewalDeniedAt: browser.renewal.observedAt, playerRemovedAt: browser.player.observedAt, browserEvidenceClass: browser.evidenceClass,
    browserSourceSha256: browser.sourceSha256, browserArtifactSha256: browser.artifactSha256, lifecycleWitnessSha256: lifecycle.witnessSha256,
    lifecyclePrivateRecordSha256: lifecycle.privateRecordSha256, s12ReceiptSha256: s12.receiptSha256, s12SourceSha256: s12.sourceSha256,
    pendingDeliveryCountAtUserDenial: pending.deliveries.length, acknowledgedReceiverCount: lifecycle.receiverAcknowledgedCount,
    actualCourseMuxSigning: true, tokenBytesOutput: false, credentialHashesOutput: false, nativeScheduleEnabled: false,
    providerTouched: true, businessDomainStateChanged: false, playbackCleanupFenceExtended: true, releaseAccepted: false });
}

export async function runPrivateAuthorityTimingFromStdin() {
  let size = 0; const chunks = [];
  try {
    for await (const chunk of process.stdin) { size += chunk.length; demand(size <= 65_536, "private-input-bound"); chunks.push(chunk); }
    const input = validatePrivateTimingInput(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result = input.mode === "s13-capture" ? await captureAuthorityTiming(input)
      : input.mode === "s13-user-observe" ? await observeUserAuthority(input)
        : await observeMuxAuthority(input);
    process.stdout.write(canonical(result) + "\n");
  } catch (error) {
    const check = error instanceof P2AuthorityTimingError && /^[a-z0-9.-]{1,120}$/u.test(error.check) ? error.check : "private-observation-failed";
    process.stdout.write(canonical({ version: 1, status: "P2_S13_PRIVATE_REFUSED", check, readOnlyObservation: true, releaseAccepted: false }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runPrivateAuthorityTimingFromStdin();

export const P2_S13_TIMING_CONSTANTS = Object.freeze({ USER_TTL_SECONDS, USER_SKEW_SECONDS, PLAYBACK_TTL_SECONDS });

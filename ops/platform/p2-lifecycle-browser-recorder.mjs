// Fixed browser child. No request interception, injected session, clock control,
// arbitrary URL, test endpoint, token export, or product implementation control.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_BROWSER_REFUSED"); };
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const privateNoStore = headers => /(?:^|,)\s*private\s*(?:,|$)/iu.test(headers["cache-control"] ?? "")
  && /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(headers["cache-control"] ?? "");
const interactiveOrigin = "https://staging.lashher.com";
const permitName = "__Host-lash-p2q-window";
const interactivePages = {
  identity: { owner: "/admin/sign-in", learner: "/sign-in" },
  authoring: { owner: "/admin/courses" },
  media: { owner: "/admin/courses" },
  learning: { learner: "/academy" },
  "paid-grant": { owner: "/admin/courses" },
  lifecycle: { owner: "/admin/customer-accounts", learner: "/account" },
};

export function p2InteractiveBrowserPath(stage, context) {
  const pages = typeof stage === "string" && Object.hasOwn(interactivePages, stage) && interactivePages[stage];
  demand(pages && typeof context === "string" && Object.hasOwn(pages, context));
  return pages[context];
}

export function p2LifecycleMutationTarget({ actorKind, userId, operation }) {
  if (actorKind === "admin") {
    demand(uuid(userId) && ["suspend", "restore", "export", "delete"].includes(operation));
    return { context: "owner", pathname: `/api/admin/customer-accounts/${userId}/commands`, operation };
  }
  demand(actorKind === "customer" && ["export", "delete", "preferences-on", "preferences-off"].includes(operation));
  return { context: "learner", pathname: operation.startsWith("preferences-") ? "/api/account/preferences" : "/api/account/commands", operation };
}

function validateLifecycleTarget(target) {
  demand(closed(target, ["context", "pathname", "operation"]) && typeof target.pathname === "string");
  const admin = target.context === "owner";
  const userId = admin ? /^\/api\/admin\/customer-accounts\/([^/]+)\/commands$/u.exec(target.pathname)?.[1] : undefined;
  const selected = p2LifecycleMutationTarget({ actorKind: admin ? "admin" : "customer", userId, operation: target.operation });
  demand(Object.entries(selected).every(([key, value]) => target[key] === value));
}

function identityContext(identity) {
  return identity.actorKind === "admin" ? "owner" : "learner";
}

function identitySelector(identity) {
  demand(closed(identity, ["actorKind", "actorId"]) && uuid(identity.actorId));
  if (identity.actorKind === "customer") return "7032712d637573746f6d65722d763100" + identity.actorId.replaceAll("-", "");
  demand(identity.actorKind === "admin");
  return createHash("sha256").update(JSON.stringify(["identity", "admin"])).digest("hex");
}

export function validateP2InteractiveBrowserInput(input) {
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "deploymentId",
    "deploymentUrl", "browserOrigin", "stage", "epoch", "windowSeconds",
    ...(input?.stage === "lifecycle" ? ["lifecycle"] : input?.stage === "identity" ? ["identity"] : [])])
    && input.version === 2 && input.environment === "staging" && matches(input.actionId, /^[a-z0-9][a-z0-9-]{0,63}$/u)
    && sha(input.challenge) && sha(input.bindingSha256) && matches(input.sourceCommit, /^[a-f0-9]{40}$/u)
    && matches(input.deploymentId, /^dpl_[A-Za-z0-9]+$/u) && matches(input.deploymentUrl, /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u)
    && input.browserOrigin === interactiveOrigin && typeof input.stage === "string" && Object.hasOwn(interactivePages, input.stage)
    && matches(input.epoch, /^[1-9][0-9]{0,17}$/u)
    && Number.isSafeInteger(input.windowSeconds) && input.windowSeconds >= 30 && input.windowSeconds <= 300);
  if (input.stage === "lifecycle") validateLifecycleTarget(input.lifecycle);
  if (input.stage === "identity") demand(closed(input.identity, ["actorKind", "actorId"])
    && ["admin", "customer"].includes(input.identity.actorKind) && uuid(input.identity.actorId));
  return input;
}

export function validateP2InteractiveBrowserPermit(permit, input, now = Math.floor(Date.now() / 1000)) {
  demand(closed(permit, ["stage", "epoch", "expires", "cookie"]) && permit.stage === input.stage && permit.epoch === input.epoch
    && Number.isSafeInteger(permit.expires) && permit.expires > now && typeof permit.cookie === "string" && permit.cookie.length <= 256);
  const parts = permit.cookie.split(".");
  const [version, epoch, stage, issued, expires, nonce] = parts;
  demand(epoch === permit.epoch && stage === permit.stage && /^\d{10}$/u.test(issued ?? "") && /^\d{10}$/u.test(expires ?? "")
    && Number(issued) <= now && Number(expires) === permit.expires && permit.expires - Number(issued) <= input.windowSeconds
    && /^[a-f0-9]{32}$/u.test(nonce ?? "")
    && (stage === "lifecycle" || stage === "identity" ? version === "v2" && parts.length === 8 && sha(parts[6]) && sha(parts[7])
      : version === "v1" && parts.length === 7 && sha(parts[6])));
  if (stage === "identity") demand(parts[6] === identitySelector(input.identity));
  return permit;
}

export function readP2InteractiveBrowserPermit(stream, input, selection) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.alloc(1024);
    let length = 0;
    const finish = permit => {
      clearTimeout(timer);
      stream.pause();
      stream.off("data", read);
      stream.off("end", refused);
      stream.off("error", refused);
      bytes.fill(0);
      if (permit) resolve(permit);
      else reject(new Error("P2_INTERACTIVE_BROWSER_STDIN_REFUSED"));
    };
    const refused = () => finish();
    const read = chunk => {
      try {
        demand(Buffer.isBuffer(chunk) && length + chunk.length <= bytes.length);
        chunk.copy(bytes, length);
        length += chunk.length;
        const end = bytes.subarray(0, length).indexOf(10);
        if (end === -1) return;
        demand(end === length - 1);
        const line = bytes.subarray(0, end).toString("utf8"), value = JSON.parse(line);
        demand(JSON.stringify(value) === line && closed(value, ["challenge", "bindingSha256", "context", "permit"])
          && value.challenge === input.challenge && value.bindingSha256 === input.bindingSha256 && value.context === selection.context);
        const permit = validateP2InteractiveBrowserPermit(value.permit, input);
        demand(permit.expires === selection.expires);
        finish(permit);
      } catch { refused(); }
    };
    const timer = setTimeout(refused, 15_000);
    stream.once("end", refused);
    stream.once("error", refused);
    stream.on("data", read);
    if (stream.readableEnded || stream.destroyed) refused();
    else stream.resume();
  });
}

function scopedCookie(value, expires) {
  return { name: permitName, value, url: `${interactiveOrigin}/`, secure: true, httpOnly: true, sameSite: "Lax", expires };
}

export async function installP2InteractiveBrowserCookie(context, permit, input) {
  validateP2InteractiveBrowserPermit(permit, input);
  await context.addCookies([scopedCookie(permit.cookie, permit.expires)]);
}

export async function expireP2InteractiveBrowserCookie(context) {
  await context.addCookies([scopedCookie("", 1)]);
}

const maxLifecycleBody = 4096;
const preferences = target => target.pathname === "/api/account/preferences";

function exactLifecycleJson(bytes) {
  demand(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxLifecycleBody);
  const text = bytes.toString("utf8"), value = JSON.parse(text);
  demand(JSON.stringify(value) === text);
  return value;
}

const identityRefused = () => new Error("P2_INTERACTIVE_IDENTITY_SESSION_REFUSED");

function readIdentitySession(body, input, ownerSubjectSha256, openedAt, now) {
  if (body === null) return null;
  const { actorKind, actorId } = input.identity;
  demand(closed(body, ["expires", "user"]) && typeof body.expires === "string");
  const expiry = Date.parse(body.expires);
  demand(Number.isFinite(expiry) && expiry > now && new Date(expiry).toISOString() === body.expires);
  const user = body.user;
  if (actorKind === "customer") {
    demand(closed(user, ["id", "name", "email", "image"]) && user.id === actorId && user.image === null
      && typeof user.email === "string" && (user.name === null || typeof user.name === "string"));
  } else {
    demand(user && typeof user === "object" && !Array.isArray(user)
      && Object.keys(user).every(key => ["name", "email", "image", "providerUserId", "isEmailVerified", "authenticatedAt"].includes(key))
      && typeof user.email === "string" && user.email.trim().length > 0
      && matches(user.providerUserId, /^[!-~]{1,256}$/u) && user.isEmailVerified === true && Number.isSafeInteger(user.authenticatedAt)
      && user.authenticatedAt > 0);
    const subject = createHash("sha256").update(JSON.stringify(["p2q-interactive-owner-v1", input.challenge, actorId, user.providerUserId])).digest("hex");
    const authenticatedAt = user.authenticatedAt * 1000;
    demand(subject === ownerSubjectSha256 && authenticatedAt <= now + 1000);
    if (authenticatedAt < openedAt - 1000 || now - authenticatedAt >= 240_000) return null;
  }
  return { actorKind, actorId, sessionVerified: true };
}

export async function observeP2InteractiveIdentitySession(page, input, { context, ownerSubjectSha256, openedAt, expires }) {
  let response, bytes;
  try {
    validateP2InteractiveBrowserInput(input);
    demand(input.stage === "identity" && context === identityContext(input.identity) && Number.isSafeInteger(openedAt)
      && Number.isSafeInteger(expires) && openedAt <= Date.now() && openedAt < expires * 1000);
    const owner = context === "owner";
    demand(owner ? sha(ownerSubjectSha256) : ownerSubjectSha256 === undefined);
    const remaining = expires * 1000 - Date.now();
    demand(remaining > 0 && remaining <= input.windowSeconds * 1000);
    if (URL.parse(page.url())?.origin !== input.browserOrigin) return null;
    const url = input.browserOrigin + (owner ? "/api/auth/session" : "/api/customer-auth/session");
    response = await page.request.get(url, { maxRedirects: 0, timeout: Math.min(8000, remaining),
      headers: { accept: "application/json", "cache-control": "no-cache" } });
    demand(response.url() === url && Date.now() < expires * 1000);
    if ([401, 403].includes(response.status())) return null;
    demand(response.status() === 200);
    const fields = name => response.headersArray().filter(header => header.name.toLowerCase() === name).map(header => header.value);
    const types = fields("content-type"), cache = fields("cache-control"), lengths = fields("content-length"), encodings = fields("content-encoding");
    demand(types.length === 1 && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(types[0])
      && cache.length === 1 && privateNoStore({ "cache-control": cache[0] })
      && (encodings.length === 0 || encodings.length === 1 && encodings[0].toLowerCase() === "identity")
      && lengths.length <= 1 && (lengths.length === 0 || /^[1-9][0-9]{0,3}$/u.test(lengths[0]) && Number(lengths[0]) <= maxLifecycleBody));
    bytes = await response.body();
    demand(lengths.length === 0 || bytes.length === Number(lengths[0]));
    const now = Date.now();
    demand(now < expires * 1000);
    return readIdentitySession(exactLifecycleJson(bytes), input, ownerSubjectSha256, openedAt, now);
  } catch {
    throw identityRefused();
  } finally {
    bytes?.fill(0);
    await response?.dispose();
  }
}

async function waitForInteractiveIdentity(page, input, selection) {
  while (Date.now() < selection.expires * 1000) {
    const receipt = await observeP2InteractiveIdentitySession(page, input, selection);
    if (receipt) return receipt;
    await pause(Math.min(2000, Math.max(1, selection.expires * 1000 - Date.now())));
  }
  throw identityRefused();
}

export function validateP2LifecycleMutationReceipt(receipt, target) {
  demand(closed(receipt, ["method", "pathname", "status", "requestId", "body"]) && receipt.method === "POST"
    && receipt.pathname === target.pathname && uuid(receipt.requestId));
  const body = receipt.body;
  if (preferences(target)) demand(receipt.status === 200 && closed(body, ["saved"]) && body.saved === true);
  else demand(receipt.status === 202 && closed(body, ["commandId", "action", "accountVersion", "status"])
    && uuid(body.commandId) && body.action === target.operation && body.status === "pending"
    && Number.isSafeInteger(body.accountVersion) && body.accountVersion >= 1);
  return receipt;
}

async function readLifecycleResponse(response, request, input) {
  const target = input.lifecycle;
  demand(response.url() === input.browserOrigin + target.pathname && response.status() === (preferences(target) ? 200 : 202)
    && !response.fromServiceWorker() && request.redirectedTo() === null);
  const [ids, contentTypes, cache, encodings, lengths, size] = await Promise.all([
    response.headerValues("x-request-id"), response.headerValues("content-type"), response.headerValues("cache-control"),
    response.headerValues("content-encoding"), response.headerValues("content-length"), request.sizes(),
  ]);
  demand(ids.length === 1 && uuid(ids[0]) && contentTypes.length === 1 && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentTypes[0])
    && cache.length === 1 && privateNoStore({ "cache-control": cache[0] })
    && (encodings.length === 0 || encodings.length === 1 && encodings[0].toLowerCase() === "identity")
    && lengths.length <= 1 && (lengths.length === 0 || /^[1-9][0-9]{0,3}$/u.test(lengths[0]))
    && Number.isSafeInteger(size.responseBodySize) && size.responseBodySize <= maxLifecycleBody);
  const declared = lengths.length === 1 ? Number(lengths[0]) : undefined;
  demand(declared === undefined ? size.responseBodySize > 0 : declared <= maxLifecycleBody);
  const bytes = await response.body();
  try {
    demand(declared === undefined || bytes.length === declared);
    const body = exactLifecycleJson(bytes);
    return validateP2LifecycleMutationReceipt({ method: "POST", pathname: target.pathname, status: response.status(), requestId: ids[0], body }, target);
  } finally { bytes.fill(0); }
}

// Attach before navigation. A second selected request, even one whose response
// is lost while closing the page, invalidates the first accepted response.
export function watchP2LifecycleMutation(context, page, input) {
  validateP2InteractiveBrowserInput(input);
  demand(input.stage === "lifecycle");
  const target = input.lifecycle, refusal = () => new Error("P2_INTERACTIVE_LIFECYCLE_RESPONSE_REFUSED");
  let selected, receipt, accept, reject, failed = false, responseStarted = false;
  const observed = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  observed.catch(() => {});
  const fail = () => { failed = true; reject(refusal()); };
  const onRequest = request => {
    const url = URL.parse(request.url());
    if (!url) return;
    if (url.origin !== input.browserOrigin || url.pathname !== target.pathname || request.method() !== "POST") return;
    try {
      demand(!selected && !url.search && !url.hash && request.redirectedFrom() === null && request.frame() === page.mainFrame());
      selected = request;
      const posted = exactLifecycleJson(request.postDataBuffer());
      if (preferences(target)) demand(closed(posted, ["learningUpdates"]) && posted.learningUpdates === (target.operation === "preferences-on"));
      else demand(closed(posted, ["action", "idempotencyKey"]) && posted.action === target.operation && uuid(posted.idempotencyKey));
    } catch { fail(); }
  };
  const onResponse = response => {
    if (response.request() !== selected) return;
    if (failed || responseStarted) return fail();
    responseStarted = true;
    void readLifecycleResponse(response, selected, input).then(value => {
      if (!failed) { receipt = value; accept(value); }
    }, fail);
  };
  const onFailure = request => { if (request === selected) fail(); };
  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onFailure);
  return {
    async wait(expires) {
      const remaining = expires * 1000 - Date.now();
      if (failed || remaining <= 0 || remaining > input.windowSeconds * 1000) throw refusal();
      let timer;
      try {
        await Promise.race([observed, new Promise((_, timeout) => { timer = setTimeout(() => timeout(refusal()), remaining); })]);
        if (failed) throw refusal();
      } finally { clearTimeout(timer); }
    },
    finish() {
      if (failed || !receipt || context.serviceWorkers().length) throw refusal();
      return receipt;
    },
    close() {
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfailed", onFailure);
      fail();
    },
  };
}

export function validateP2LifecycleBrowserInput(input) {
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "deploymentId", "deploymentUrl", "browserOrigin", "userId", "courseId", "lessonId", "windowSeconds"])
    && input.version === 1 && input.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId)
    && sha(input.challenge) && sha(input.bindingSha256) && /^[a-f0-9]{40}$/u.test(input.sourceCommit)
    && /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl)
    && input.browserOrigin === "https://staging.lashher.com" && [input.userId, input.courseId, input.lessonId].every(uuid) && input.windowSeconds === 840);
  return input;
}

export function parseP2PlaybackObservation(status, headers, body, initial = false) {
  demand(privateNoStore(headers));
  if (initial) {
    demand(status === 200 && closed(body, ["expiresAt", "playbackId", "playbackToken", "thumbnailExpiresAt", "thumbnailToken"])
      && typeof body.playbackToken === "string" && body.playbackToken.length > 20 && typeof body.thumbnailToken === "string"
      && Number.isFinite(Date.parse(body.expiresAt)) && Number.isFinite(Date.parse(body.thumbnailExpiresAt))
      && typeof body.playbackId === "string" && body.playbackId.length > 0 && Number.isFinite(Date.parse(headers.date)));
    // Tokens and playback identifiers are deliberately discarded in memory.
    const lifetimeMs = Math.min(Date.parse(body.expiresAt), Date.parse(body.thumbnailExpiresAt)) - Date.parse(headers.date);
    demand(lifetimeMs >= 590_000 && lifetimeMs <= 601_000);
    return { httpStatus: 200, serverDate: headers.date, expiresAt: body.expiresAt, thumbnailExpiresAt: body.thumbnailExpiresAt, lifetimeMs, privateNoStore: true };
  }
  demand(status === 401 && closed(body, ["error", "requestId"]) && closed(body.error, ["code", "message"])
    && body.error.code === "sign_in_required" && typeof body.error.message === "string" && uuid(body.requestId)
    && headers["x-request-id"] === body.requestId);
  return { httpStatus: 401, errorCode: "sign_in_required", requestId: body.requestId, privateNoStore: true };
}

export function parseP2OwnerSuspensionResponse(status, headers, body) {
  demand(status === 202 && privateNoStore(headers) && uuid(headers["x-request-id"])
    && closed(body, ["commandId", "accountVersion", "action", "status"]) && uuid(body.commandId)
    && Number.isSafeInteger(body.accountVersion) && body.accountVersion >= 1 && body.action === "suspend" && body.status === "pending");
  return { ...body, requestId: headers["x-request-id"] };
}

async function boundedJson(response) {
  const raw = await response.body(); demand(raw.length > 0 && raw.length <= 65536); return JSON.parse(raw.toString("utf8"));
}
function exactResponse(response, page, origin, path, method) {
  const request = response.request(), url = new URL(response.url());
  return request.frame() === page.mainFrame() && url.origin === origin && url.pathname === path && url.search === ""
    && request.method() === method && request.redirectedFrom() === null && request.redirectedTo() === null;
}
async function until(check, deadline) {
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await pause(250); }
  throw new Error("P2_LIFECYCLE_BROWSER_TIMEOUT");
}

// This exported source routine is exercised with owned pages in tests. The live
// entry below creates its own real Playwright pages and never accepts a page,
// callback, browser endpoint, storage state or launch argument over IPC.
export async function recordP2SuspensionBrowser(input, pages, control) {
  validateP2LifecycleBrowserInput(input);
  const { customer, owner } = pages, origin = input.browserOrigin, started = performance.now(), deadline = started + 840_000;
  const events = [], event = (type, detail) => { const value = { type, observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), ...detail }; events.push(value); return value; };
  const playbackPath = `/api/academy/lessons/${input.lessonId}/playback`;
  const initialResponse = customer.waitForResponse(response => exactResponse(response, customer, origin, playbackPath, "GET"), { timeout: 60_000 });
  await customer.goto(`${origin}/academy/courses/${input.courseId}/lessons/${input.lessonId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const initial = await initialResponse;
  const baseline = event("ordinary-playback-authorized", parseP2PlaybackObservation(initial.status(), await initial.allHeaders(), await boundedJson(initial), true));
  await until(async () => await customer.locator("mux-player").count() === 1, Math.min(deadline, performance.now() + 60_000));
  event("player-present", { muxPlayerCount: 1 });
  await control.baseline(baseline); // Parent records its pre-suspend token first.
  demand(performance.now() < deadline);
  const adminSession = await owner.request.get(`${origin}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
  demand(adminSession.status() === 200);
  const session = await adminSession.json(), authenticatedAt = session?.user?.authenticatedAt;
  demand(Number.isInteger(authenticatedAt) && Date.now() - authenticatedAt * 1000 >= 0 && Date.now() - authenticatedAt * 1000 < 240_000);
  await owner.goto(`${origin}/admin/customer-accounts`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await owner.getByRole("heading", { name: "Customer account lifecycle", exact: true }).waitFor({ timeout: 15_000 });
  await owner.getByLabel("Customer UUID", { exact: true }).fill(input.userId);
  await owner.getByLabel("Action", { exact: true }).selectOption("suspend");
  const renewal = customer.waitForResponse(response => exactResponse(response, customer, origin, playbackPath, "GET"), { timeout: Math.max(1, deadline - performance.now()) });
  const commandResponse = owner.waitForResponse(response => exactResponse(response, owner, origin, `/api/admin/customer-accounts/${input.userId}/commands`, "POST"), { timeout: 30_000 });
  await owner.getByRole("button", { name: "Record account command", exact: true }).click();
  const response = await commandResponse, request = response.request(), posted = request.postDataJSON();
  demand(closed(posted, ["action", "idempotencyKey"]) && posted.action === "suspend" && uuid(posted.idempotencyKey));
  const suspension = event("ordinary-owner-suspension-accepted", parseP2OwnerSuspensionResponse(response.status(), await response.allHeaders(), await boundedJson(response)));
  await control.suspended(suspension);
  const denied = await renewal;
  const denial = event("ordinary-renewal-denied", parseP2PlaybackObservation(denied.status(), await denied.allHeaders(), await boundedJson(denied)));
  await until(async () => await customer.locator("mux-player").count() === 0
    && await customer.getByRole("alert").filter({ hasText: "Your session has ended. Sign in again to continue." }).count() === 1, deadline);
  event("player-removed", { muxPlayerCount: 0, sessionEndedAlert: true });
  demand(denial.elapsedMs > suspension.elapsedMs && denial.elapsedMs - baseline.elapsedMs > 0 && performance.now() < deadline);
  return { version: 1, status: "P2_LIFECYCLE_BROWSER_SOURCE_RECORDED", environment: "staging", actionId: input.actionId,
    challenge: input.challenge, bindingSha256: input.bindingSha256, sourceCommit: input.sourceCommit, deploymentId: input.deploymentId,
    deploymentUrl: input.deploymentUrl, browserOrigin: origin, userId: input.userId, courseId: input.courseId, lessonId: input.lessonId, events,
    contextsIsolated: true, sessionsFabricated: false, clockChanged: false, requestsIntercepted: false,
    playbackRemovalAfterSuspensionMs: events.at(-1).elapsedMs - suspension.elapsedMs,
    tokensRetained: false, rawHarRetained: false, nativeInvocationQualified: false, releaseAccepted: false };
}

function receiveBrowserMessage(timeout) {
  return new Promise((done, fail) => {
    const clean = () => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", lost);
    };
    const lost = () => { clean(); fail(new Error("P2_BROWSER_PARENT_UNAVAILABLE")); };
    const receive = message => { clean(); done(message); };
    const timer = setTimeout(lost, timeout);
    process.once("message", receive);
    process.once("disconnect", lost);
  });
}

function sendBrowserMessage(message) {
  return new Promise((done, fail) => process.send(message, error => error ? fail(error) : done()));
}

const interactiveBinding = input => ({ challenge: input.challenge, bindingSha256: input.bindingSha256, stage: input.stage, epoch: input.epoch });

async function runInteractiveBrowser(first) {
  let input = validateP2InteractiveBrowserInput(first), binding = interactiveBinding(input);
  const send = (type, value = {}) => sendBrowserMessage({ type, ...binding, ...value });
  const next = () => {
    const pending = receiveBrowserMessage(300_000);
    pending.catch(() => {}); // An IPC send can fail before the caller awaits this receive.
    return pending;
  };
  let browser, context, page, selection, lifecycleWatch, identityOpenedAt, opened = false, cleared = false;
  const contexts = new Map(), actions = new Set([input.actionId]);
  const lost = () => { if (browser) void browser.close().catch(() => {}); };
  const terminate = () => { if (process.connected) process.disconnect(); else lost(); };
  process.once("disconnect", lost);
  process.once("SIGTERM", terminate);
  try {
    let pending = next();
    await send("interactive-initialized");
    while (true) {
      const command = await pending;
      demand(closed(command, ["type", "input"]) && command.input?.challenge === binding.challenge
        && command.input.bindingSha256 === binding.bindingSha256 && command.input.stage === binding.stage && command.input.epoch === binding.epoch);
      const received = command.input;
      if (command.type === "interactive-close") {
        demand(closed(received, Object.keys(binding)));
        break;
      }
      if (command.type === "interactive-select") {
        demand(cleared && closed(received, [...Object.keys(binding), "next"]));
        const selectedInput = validateP2InteractiveBrowserInput(received.next);
        demand(["challenge", "sourceCommit", "deploymentId", "deploymentUrl", "browserOrigin"].every(key => selectedInput[key] === input[key])
          && actions.size < 24 && !actions.has(selectedInput.actionId) && selectedInput.bindingSha256 !== input.bindingSha256
          && BigInt(selectedInput.epoch) > BigInt(input.epoch));
        actions.add(selectedInput.actionId);
        input = selectedInput;
        binding = interactiveBinding(input);
        selection = context = page = identityOpenedAt = undefined;
        opened = cleared = false;
        pending = next();
        await send("interactive-selected");
        continue;
      }
      const captureIdentity = command.type === "interactive-capture-identity";
      const ownerIdentity = captureIdentity && binding.stage === "identity" && input.identity.actorKind === "admin";
      demand(closed(received, [...Object.keys(binding), "context", "expires", ...(ownerIdentity ? ["ownerSubjectSha256"] : [])])
        && Number.isSafeInteger(received.expires));
      const path = p2InteractiveBrowserPath(binding.stage, received.context);
      if (command.type === "interactive-install") {
        demand(selection === undefined && (binding.stage !== "lifecycle" || received.context === input.lifecycle.context)
          && (binding.stage !== "identity" || received.context === identityContext(input.identity)));
        selection = { context: received.context, expires: received.expires };
        const permit = await readP2InteractiveBrowserPermit(process.stdin, input, selection);
        try {
          if (!browser) {
            const { chromium } = await import("playwright");
            browser = await chromium.launch({ headless: false });
          }
          context = contexts.get(received.context);
          if (!context) {
            context = await browser.newContext();
            contexts.set(received.context, context);
          }
          await installP2InteractiveBrowserCookie(context, permit, input);
        } finally { permit.cookie = ""; }
        pending = next();
        await send("interactive-permit-installed", selection);
        continue;
      }
      demand(selection && received.context === selection.context && received.expires === selection.expires && context && !cleared);
      if (command.type === "interactive-open") {
        demand(!opened && Date.now() < selection.expires * 1000);
        opened = true;
        if (binding.stage === "identity") identityOpenedAt = Date.now();
        page = await context.newPage();
        if (binding.stage === "lifecycle") lifecycleWatch = watchP2LifecycleMutation(context, page, input);
        const response = await page.goto(input.browserOrigin + path, { waitUntil: "domcontentloaded", timeout: 30_000 });
        demand(response && Number.isInteger(response.status()));
        pending = next();
        await send("interactive-page-opened", { ...selection, path, httpStatus: response.status() });
      } else {
        const captureLifecycle = command.type === "interactive-capture-lifecycle";
        demand(command.type === "interactive-clear" || captureLifecycle && opened && lifecycleWatch
          || captureIdentity && binding.stage === "identity" && opened && page?.context() === context);
        if (captureLifecycle) await lifecycleWatch.wait(selection.expires);
        const identity = captureIdentity ? await waitForInteractiveIdentity(page, input,
          { ...selection, openedAt: identityOpenedAt, ownerSubjectSha256: received.ownerSubjectSha256 }) : undefined;
        await expireP2InteractiveBrowserCookie(context);
        await Promise.all(context.pages().map(page => page.close()));
        cleared = true;
        if (captureLifecycle || captureIdentity) demand(Date.now() < selection.expires * 1000);
        const response = captureLifecycle ? lifecycleWatch.finish() : undefined;
        lifecycleWatch?.close();
        lifecycleWatch = undefined;
        pending = next();
        if (captureLifecycle) await send("interactive-lifecycle-captured", { ...selection, response });
        else if (captureIdentity) await send("interactive-identity-captured", { ...selection, identity });
        else await send("interactive-permit-cleared", selection);
      }
    }
  } finally {
    process.off("disconnect", lost);
    process.off("SIGTERM", terminate);
    process.stdin.destroy();
    lifecycleWatch?.close();
    try { if (context && !cleared) await expireP2InteractiveBrowserCookie(context); }
    finally { await browser?.close(); }
  }
  await send("interactive-closed");
  process.disconnect();
}

async function childMain() {
  demand(process.versions.node.split(".")[0] === "24" && typeof process.send === "function" && process.argv.length === 1);
  const first = await receiveBrowserMessage(30_000);
  demand(closed(first, ["type", "input"]));
  if (first.type === "initialize-interactive") return runInteractiveBrowser(first.input);
  demand(first.type === "initialize");
  let authCheck;
  const next = type => new Promise((done, fail) => {
    const timer = setTimeout(() => { process.off("message", receive); fail(new Error("P2_BROWSER_PARENT_TIMEOUT")); }, type === "initialize" ? 30_000 : 900_000);
    let checking = false;
    const receive = message => {
      if (type === "arm" && closed(message, ["type", "input"]) && message.type === "check-authentication" && message.input === input.challenge && authCheck && !checking) {
        checking = true;
        void authCheck().then(value => { checking = false; return new Promise((resolve, reject) => process.send({ type: "authentication-current", challenge: input.challenge, value }, error => error ? reject(error) : resolve())); })
          .catch(error => { clearTimeout(timer); process.off("message", receive); fail(error); }).finally(() => { checking = false; });
        return;
      }
      if (!closed(message, ["type", "input"]) || message.type !== type || checking) { clearTimeout(timer); process.off("message", receive); fail(new Error("P2_BROWSER_PROTOCOL")); return; }
      clearTimeout(timer); process.off("message", receive); done(message.input); };
    process.on("message", receive);
  });
  const input = validateP2LifecycleBrowserInput(first.input);
  process.send({ type: "initialized", challenge: input.challenge });
  // Only the fixed armed auth-preparation parent may release this barrier.
  // No browser or authentication request exists before that source capability.
  demand((await next("authenticate")) === input.challenge);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  process.once("disconnect", () => { void browser.close().finally(() => process.exit(1)); });
  let result;
  try {
    const customerContext = await browser.newContext(), ownerContext = await browser.newContext();
    const customer = await customerContext.newPage(), owner = await ownerContext.newPage();
    await customer.goto(`${input.browserOrigin}/sign-in`, { waitUntil: "domcontentloaded" });
    await owner.goto(`${input.browserOrigin}/admin/sign-in`, { waitUntil: "domcontentloaded" });
    authCheck = async () => {
      const learner = await customer.request.get(`${input.browserOrigin}/api/customer-auth/session`, { maxRedirects: 0, timeout: 15_000 });
      const admin = await owner.request.get(`${input.browserOrigin}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
      if (learner.status() !== 200 || admin.status() !== 200) return { customerAuthenticated: false, ownerFresh: false, observedAt: new Date().toISOString() };
      const learnerSession = await learner.json(), adminSession = await admin.json(), at = adminSession?.user?.authenticatedAt;
      return { customerAuthenticated: learnerSession?.user?.id === input.userId,
        ownerFresh: Number.isInteger(at) && Date.now()-at*1000 >= 0 && Date.now()-at*1000 < 240000, observedAt: new Date().toISOString() };
    };
    // The parent's auth-preparation action bounds the normal manual sign-in.
    // This longer child timeout is only process liveness, never admission proof.
    const loginDeadline = performance.now() + 900_000;
    const ready = await until(async () => {
      const current = await authCheck(); if (current.customerAuthenticated && current.ownerFresh) return current;
      await pause(750); return false;
    }, loginDeadline);
    process.send({ type: "authenticated", challenge: input.challenge, value: ready });
    demand((await next("arm")) === input.challenge);
    result = await recordP2SuspensionBrowser(input, { customer, owner }, {
      baseline: async value => { const waiting = next("suspend"); process.send({ type: "baseline", challenge: input.challenge, value }); demand(await waiting === input.challenge); },
      suspended: async value => { process.send({ type: "suspended", challenge: input.challenge, value }); },
    });
  } finally { await browser.close(); }
  await new Promise((done, fail) => process.send({ type: "complete", challenge: input.challenge, value: result }, error => error ? fail(error) : done()));
  process.disconnect();
}
export async function runP2LifecycleBrowserChild() {
  try { await childMain(); }
  catch { process.send?.({ type: "failed" }, () => process.disconnect?.()); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runP2LifecycleBrowserChild();

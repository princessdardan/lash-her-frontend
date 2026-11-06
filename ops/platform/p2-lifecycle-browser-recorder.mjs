// Fixed browser child. No request interception, injected session, clock control,
// arbitrary URL, test endpoint, token export, or product implementation control.
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_BROWSER_REFUSED"); };
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][0-9a-f]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const privateNoStore = headers => /(?:^|,)\s*private\s*(?:,|$)/iu.test(headers["cache-control"] ?? "")
  && /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(headers["cache-control"] ?? "");
export function validateP2LifecycleBrowserInput(input) {
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "deploymentId", "deploymentUrl", "userId", "courseId", "lessonId", "windowSeconds"])
    && input.version === 1 && input.environment === "staging" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId)
    && sha(input.challenge) && sha(input.bindingSha256) && /^[a-f0-9]{40}$/u.test(input.sourceCommit)
    && /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl)
    && [input.userId, input.courseId, input.lessonId].every(uuid) && input.windowSeconds === 840);
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
  const { customer, owner } = pages, origin = input.deploymentUrl, started = performance.now(), deadline = started + 840_000;
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
    deploymentUrl: origin, userId: input.userId, courseId: input.courseId, lessonId: input.lessonId, events,
    contextsIsolated: true, sessionsFabricated: false, clockChanged: false, requestsIntercepted: false,
    playbackRemovalAfterSuspensionMs: events.at(-1).elapsedMs - suspension.elapsedMs,
    tokensRetained: false, rawHarRetained: false, nativeInvocationQualified: false, releaseAccepted: false };
}

async function childMain() {
  demand(process.versions.node.split(".")[0] === "24" && typeof process.send === "function" && process.argv.length === 1);
  let authCheck;
  const next = type => new Promise((done, fail) => {
    const timer = setTimeout(() => { process.off("message", receive); fail(new Error("P2_BROWSER_PARENT_TIMEOUT")); }, type === "initialize" ? 30_000 : 900_000);
    let checking = false;
    const receive = message => {
      if (type === "arm" && closed(message, ["type", "input"]) && message.type === "check-authentication" && message.input === input.challenge && authCheck && !checking) {
        checking = true;
        void authCheck().then(value => new Promise((resolve, reject) => process.send({ type: "authentication-current", challenge: input.challenge, value }, error => error ? reject(error) : resolve())))
          .catch(error => { clearTimeout(timer); process.off("message", receive); fail(error); }).finally(() => { checking = false; });
        return;
      }
      if (!closed(message, ["type", "input"]) || message.type !== type || checking) { clearTimeout(timer); process.off("message", receive); fail(new Error("P2_BROWSER_PROTOCOL")); return; }
      clearTimeout(timer); process.off("message", receive); done(message.input); };
    process.on("message", receive);
  });
  const input = validateP2LifecycleBrowserInput(await next("initialize"));
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
    await customer.goto(`${input.deploymentUrl}/sign-in`, { waitUntil: "domcontentloaded" });
    await owner.goto(`${input.deploymentUrl}/admin/sign-in`, { waitUntil: "domcontentloaded" });
    authCheck = async () => {
      const learner = await customer.request.get(`${input.deploymentUrl}/api/customer-auth/session`, { maxRedirects: 0, timeout: 15_000 });
      const admin = await owner.request.get(`${input.deploymentUrl}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
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

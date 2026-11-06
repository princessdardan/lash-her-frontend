// Fixed per-rollout normal frontend signer/read recorder. The live child owns
// isolated browser contexts and accepts no page, storage, token or callback.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const plans = new WeakMap(), controllers = new WeakMap(), artifacts = new WeakMap();
const demand = value => { if (!value) throw new Error("P2_IDENTITY_ROTATION_BROWSER_REFUSED"); };
const SHA = /^[a-f0-9]{64}$/u, COMMIT = /^[a-f0-9]{40}$/u, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const closed = (value, fields) => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...fields].sort().join());
const noStore = headers => /(?:^|,)\s*private\s*(?:,|$)/iu.test(headers["cache-control"] ?? "")
  && /(?:^|,)\s*no-store\s*(?:,|$)/iu.test(headers["cache-control"] ?? "");
const sourceFile = fileURLToPath(import.meta.url), launcher = "\nawait runP2IdentityRotationBrowserChild();\n";

export function prepareP2IdentityRotationBrowserReadPlan(rotationPlan, phase, deployment) {
  demand(rotationPlan?.version === 1 && rotationPlan.environment === "staging" && ["overlap", "current-only"].includes(phase)
    && COMMIT.test(rotationPlan.sourceCommit ?? "") && SHA.test(rotationPlan.bindingSha256 ?? "")
    && deployment?.phase === phase && /^dpl_[A-Za-z0-9]+$/u.test(deployment.deploymentId ?? "")
    && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(deployment.deploymentUrl ?? "")
    && deployment.sourceCommit === rotationPlan.sourceCommit
    && deployment.configurationSha256 === rotationPlan.configuration?.[phase]?.sha256
    && SHA.test(deployment.configurationSha256 ?? "") && SHA.test(deployment.workloadReceiptSha256 ?? ""));
  const plan = Object.freeze({ version: 1, status: "P2_IDENTITY_ROTATION_BROWSER_SOURCE_PLAN", environment: "staging",
    actionId: rotationPlan.actionId, bindingSha256: rotationPlan.bindingSha256, sourceCommit: rotationPlan.sourceCommit,
    candidateSha256: rotationPlan.candidateSha256, phase, configurationSha256: deployment.configurationSha256,
    deploymentId: deployment.deploymentId, deploymentUrl: deployment.deploymentUrl,
    workloadReceiptSha256: deployment.workloadReceiptSha256, courseId: rotationPlan.courseId,
    browserProgramSha256: hash(Buffer.concat([readFileSync(sourceFile), Buffer.from(launcher)])),
    admissionClass: "bounded-frontend-new-work-read-only", maximumWindowSeconds: 60,
    gatewayAdmissionRequired: false, tokenBytesOutput: false, releaseAccepted: false });
  plans.set(plan, { customerId: rotationPlan.subjects["course-learner"], adminId: rotationPlan.subjects["course-admin"] });
  return plan;
}

async function boundedBody(response) { const raw = await response.body(); demand(raw.length > 0 && raw.length <= 131_072); return JSON.parse(raw); }
async function ordinaryRead(page, url, courseId, profile) {
  const response = await page.request.get(url, { maxRedirects: 0, timeout: 30_000 }), headers = await response.allHeaders(), value = await boundedBody(response);
  demand(response.status() === 200 && noStore(headers) && UUID.test(headers["x-request-id"] ?? "") && value?.course?.id === courseId);
  return { profile, httpStatus: 200, requestId: headers["x-request-id"], observedAt: new Date().toISOString(), privateNoStore: true, courseBindingVerified: true };
}

export async function recordP2IdentityRotationBrowserReads(input, pages) {
  demand(closed(input, ["version", "environment", "actionId", "challenge", "bindingSha256", "sourceCommit", "candidateSha256", "phase",
    "configurationSha256", "deploymentId", "deploymentUrl", "workloadReceiptSha256", "courseId", "customerId", "adminId"])
    && input.version === 1 && input.environment === "staging" && ["overlap", "current-only"].includes(input.phase)
    && [input.challenge, input.bindingSha256, input.candidateSha256, input.configurationSha256, input.workloadReceiptSha256].every(value => SHA.test(value))
    && COMMIT.test(input.sourceCommit) && [input.courseId, input.customerId, input.adminId].every(value => UUID.test(value))
    && /^dpl_[A-Za-z0-9]+$/u.test(input.deploymentId) && /^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/u.test(input.deploymentUrl)
    && pages?.customer && pages.admin);
  const windowStartedAt = new Date().toISOString();
  const customerSession = await pages.customer.request.get(`${input.deploymentUrl}/api/customer-auth/session`, { maxRedirects: 0, timeout: 15_000 });
  const adminSession = await pages.admin.request.get(`${input.deploymentUrl}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
  demand(customerSession.status() === 200 && adminSession.status() === 200);
  const customer = await customerSession.json(), admin = await adminSession.json(), authenticatedAt = admin?.user?.authenticatedAt;
  demand(customer?.user?.id === input.customerId && admin?.user?.id === input.adminId && Number.isInteger(authenticatedAt)
    && Date.now() - authenticatedAt * 1000 >= 0 && Date.now() - authenticatedAt * 1000 < 240_000);
  const profiles = [
    await ordinaryRead(pages.customer, `${input.deploymentUrl}/api/academy/courses/${input.courseId}`, input.courseId, "course-learner"),
    await ordinaryRead(pages.admin, `${input.deploymentUrl}/api/admin/courses/${input.courseId}`, input.courseId, "course-admin")];
  const windowCompletedAt = new Date().toISOString();
  demand(Date.parse(windowCompletedAt) >= Date.parse(windowStartedAt)
    && Date.parse(windowCompletedAt) - Date.parse(windowStartedAt) <= 60_000
    && profiles.every(row => Date.parse(row.observedAt) >= Date.parse(windowStartedAt)
      && Date.parse(row.observedAt) <= Date.parse(windowCompletedAt)));
  return { version: 1, status: "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED", environment: "staging", actionId: input.actionId,
    bindingSha256: input.bindingSha256, sourceCommit: input.sourceCommit, candidateSha256: input.candidateSha256, phase: input.phase,
    configurationSha256: input.configurationSha256, deploymentId: input.deploymentId, deploymentUrl: input.deploymentUrl,
    workloadReceiptSha256: input.workloadReceiptSha256, windowStartedAt, windowCompletedAt,
    evidenceClass: "actual-frontend-normal-course-signer-protected-http", profiles,
    contextsIsolated: true, sessionsFabricated: false, requestsIntercepted: false, storageInjected: false,
    tokenBytesOutput: false, credentialHashesOutput: false, releaseAccepted: false };
}

async function childMain() {
  demand(process.versions.node.split(".")[0] === "24" && typeof process.send === "function" && process.argv.length === 1);
  const receive = type => new Promise((done, fail) => { const timer = setTimeout(() => { process.off("message", listener); fail(new Error("timeout")); }, 600_000);
    const listener = message => { clearTimeout(timer); process.off("message", listener); if (!closed(message, ["type", "input"]) || message.type !== type) fail(new Error("protocol")); else done(message.input); };
    process.on("message", listener); });
  const input = await receive("initialize"); process.send({ type: "initialized", challenge: input.challenge });
  const { chromium } = await import("playwright"), browser = await chromium.launch({ headless: false }); process.once("disconnect", () => { void browser.close().finally(() => process.exit(1)); });
  let record;
  try { const customerContext = await browser.newContext(), adminContext = await browser.newContext(), customer = await customerContext.newPage(), admin = await adminContext.newPage();
    await customer.goto(`${input.deploymentUrl}/sign-in`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await admin.goto(`${input.deploymentUrl}/admin/sign-in`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const authDeadline = Date.now() + 300_000;
    while (true) { try {
      const customerSession = await customer.request.get(`${input.deploymentUrl}/api/customer-auth/session`, { maxRedirects: 0, timeout: 15_000 });
      const adminSession = await admin.request.get(`${input.deploymentUrl}/api/auth/session`, { maxRedirects: 0, timeout: 15_000 });
      const customerValue = customerSession.status() === 200 ? await customerSession.json() : null;
      const adminValue = adminSession.status() === 200 ? await adminSession.json() : null, at = adminValue?.user?.authenticatedAt;
      if (customerValue?.user?.id === input.customerId && adminValue?.user?.id === input.adminId && Number.isInteger(at)
        && Date.now() - at * 1000 >= 0 && Date.now() - at * 1000 < 240_000) break;
    } catch {} demand(Date.now() < authDeadline); await new Promise(wait => setTimeout(wait, 750)); }
    process.send({ type: "authenticated", challenge: input.challenge, value: { customerAuthenticated: true, adminFresh: true, observedAt: new Date().toISOString() } });
    demand(await receive("arm") === input.challenge);
    const readDeadline = Date.now() + 60_000;
    while (true) { try { record = await recordP2IdentityRotationBrowserReads(input, { customer, admin }); break; }
      catch { demand(Date.now() < readDeadline); await new Promise(wait => setTimeout(wait, 250)); } }
  } finally { await browser.close(); }
  await new Promise((done, fail) => process.send({ type: "complete", challenge: input.challenge, value: record }, error => error ? fail(error) : done())); process.disconnect();
}

export function launchP2IdentityRotationBrowserReadRecorder(plan) {
  const subjects = plans.get(plan); demand(subjects && process.versions.node.split(".")[0] === "24");
  const program = Buffer.concat([readFileSync(sourceFile), Buffer.from(launcher)]); demand(hash(program) === plan.browserProgramSha256);
  const challenge = randomBytes(32).toString("hex"), input = { version: 1, environment: "staging", actionId: plan.actionId, challenge,
    bindingSha256: plan.bindingSha256, sourceCommit: plan.sourceCommit, candidateSha256: plan.candidateSha256, phase: plan.phase,
    configurationSha256: plan.configurationSha256, deploymentId: plan.deploymentId, deploymentUrl: plan.deploymentUrl,
    workloadReceiptSha256: plan.workloadReceiptSha256, courseId: plan.courseId, customerId: subjects.customerId, adminId: subjects.adminId };
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program.toString("utf8")], { stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR"].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) });
  let failed = false, ended = false, initialized, authenticated, complete;
  const initializedPromise = new Promise((done, fail) => { initialized = { done, fail }; }), authenticatedPromise = new Promise((done, fail) => { authenticated = { done, fail }; }),
    completePromise = new Promise((done, fail) => { complete = { done, fail }; });
  // Every phase promise remains observable by its explicit controller method,
  // but source-child loss must not create an unrelated unhandled rejection.
  void initializedPromise.catch(() => {}); void authenticatedPromise.catch(() => {}); void completePromise.catch(() => {});
  const reject = () => { if (failed) return; failed = true; initialized.fail(new Error("P2_ROTATION_BROWSER_CHILD_FAILED")); authenticated.fail(new Error("P2_ROTATION_BROWSER_CHILD_FAILED")); complete.fail(new Error("P2_ROTATION_BROWSER_CHILD_FAILED")); };
  child.on("error", reject); child.on("message", message => { try { demand(message?.challenge === challenge && ["initialized", "authenticated", "complete"].includes(message.type));
    (message.type === "initialized" ? initialized : message.type === "authenticated" ? authenticated : complete).done(message.value ?? true); } catch { reject(); } });
  const exit = new Promise(done => child.once("exit", (code, signal) => { ended = true; if (code !== 0 || signal) reject(); done({ code, signal }); })); child.send({ type: "initialize", input }, error => { if (error) reject(); });
  const controller = Object.freeze({ initialized: () => initializedPromise, authenticated: () => authenticatedPromise,
    async arm() { const auth = await authenticatedPromise; demand(!failed && auth?.customerAuthenticated === true && auth.adminFresh === true); child.send({ type: "arm", input: challenge }, error => { if (error) reject(); }); },
    async complete() { const record = await completePromise, result = await exit; demand(!failed && result.code === 0 && !result.signal && record?.status === "P2_IDENTITY_ROTATION_BROWSER_READS_RECORDED"
        && record.bindingSha256 === plan.bindingSha256 && record.phase === plan.phase && record.configurationSha256 === plan.configurationSha256 && record.deploymentId === plan.deploymentId);
      const handle = Object.freeze({}); artifacts.set(handle, { plan, record: structuredClone(record) }); return handle; },
    async close() {
      if (!ended) {
        child.kill("SIGTERM");
        await Promise.race([exit, new Promise(done => setTimeout(done, 15_000))]);
        if (!ended) child.kill("SIGKILL");
      }
      await exit;
    } });
  controllers.set(controller, { plan, challenge }); return controller;
}

export function readP2IdentityRotationBrowserControllerBinding(plan, controller) { const selected = controllers.get(controller); demand(plans.has(plan) && selected?.plan === plan); return { challenge: selected.challenge, bindingSha256: plan.bindingSha256 }; }
export function readP2IdentityRotationBrowserReadArtifact(plan, handle) { const selected = artifacts.get(handle); demand(plans.has(plan) && selected?.plan === plan); return structuredClone(selected.record); }
export async function runP2IdentityRotationBrowserChild() { try { await childMain(); } catch { process.exitCode = 1; process.disconnect?.(); } }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runP2IdentityRotationBrowserChild();

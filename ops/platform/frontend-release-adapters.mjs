// Concrete source-pinned staging components. No initialization effects, ambient
// credentials, standalone release CLI or claim of whole-provider fencing.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve, dirname, sep } from "node:path";
import { frontendPrivateReceiptDirectory, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { frontendCoordinationHash as hash, validateFrontendFenceObservation } from "./frontend-release-inventory.mjs";
import { observeFrontendSquareEffects } from "./frontend-square-effects.mjs";
import { observeFrontendGoogleDatabase } from "./frontend-google-effects.mjs";
import { observeFrontendCrmShippingDatabase, frontendCrmShippingSnapshotSha256 } from "./frontend-crm-shipping-effects.mjs";
import { observeHistoricalFrontendCapabilityBindings, observeHistoricalFrontendDatabaseFence } from "./frontend-historical-capabilities.mjs";
import { deriveFrontendProviderFence } from "./frontend-provider-fence-join.mjs";
import { prepareFrontendProviderBindings } from "./frontend-provider-bindings.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_PROVIDER_ADAPTER_REFUSED"); };
const script = fileURLToPath(new URL("./host/frontend_release_adapters.py", import.meta.url));
const fields = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const privateActionCredentials = new WeakMap();

async function runtime(context) {
  try {
  demand(typeof context?.verifyLockedSession === "function" && typeof context.getProviderContext === "function");
  await context.verifyLockedSession();
  const value = await context.getProviderContext(Object.freeze({ actionId: context.plan.actionId,
    sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256 }));
  const bindings = prepareFrontendProviderBindings(value?.bindings, context.plan);
  let actions = privateActionCredentials.get(context.getProviderContext);
  if (!actions) { actions = new Map(); privateActionCredentials.set(context.getProviderContext, actions); }
  const scope = `${context.plan.actionId}:${context.plan.sourceCommit}:${context.plan.targetSha256}:${context.plan.providerBindingsSha256}`;
  let fixed = actions.get(scope);
  if (!fixed) { fixed = new Map(); actions.set(scope, fixed); }
  for (const key of ["squareRetiredToken", "squareReplacementToken", "resendRetiredToken", "resendReplacementToken",
    "highlevelRetiredToken", "highlevelReplacementToken", "chitchatsRetiredToken", "chitchatsReplacementToken",
    "googleIdentityRetiredSecret", "googleIdentityReplacementSecret", "googleCalendarRetiredSecret", "googleCalendarReplacementSecret",
    "sanityRetiredToken", "sanityReplacementToken"]) {
    if (fixed.has(key)) demand(value[key] === fixed.get(key));
    else if (typeof value[key] === "string") fixed.set(key, value[key]);
  }
  frontendPrivateReceiptDirectory(context.directory);
  if (context.plan.restoration !== undefined) {
    demand(typeof value.gatewayRuntimeDirectory === "string");
    frontendPrivateReceiptDirectory(value.gatewayRuntimeDirectory);
  }
  demand(typeof value.vercelToken === "string" && value.vercelToken.length > 0 && value.vercelToken.length <= 8192 &&
    [...value.vercelToken].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) < 127));
  const candidate = context.candidate;
  demand(candidate?.version === 2 && candidate.environment === "staging" && candidate.releaseId === context.plan.actionId &&
    candidate.sources?.frontend?.commit === context.plan.sourceCommit && candidate.sources.frontend.requiredChecks === "passed" &&
    candidate.sources.frontend.repository === "https://github.com/princessdardan/lash-her-frontend.git" &&
    candidate.workload?.projectId === bindings.projectId && candidate.workload.environment === "production");
  const phase2 = candidate.contractPhase !== undefined || candidate.phase2ContractManifestSha256 !== undefined;
  if (phase2) demand(candidate.contractPhase === "p2" && typeof candidate.phase2ContractManifestSha256 === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.phase2ContractManifestSha256) && candidate.phase2ContractManifestSha256 !== `sha256:${"0".repeat(64)}`);
  return { value, bindings, candidate: { version: 2, environment: "staging", releaseId: candidate.releaseId,
    ...(phase2 ? { contractPhase: "p2", phase2ContractManifestSha256: candidate.phase2ContractManifestSha256 } : {}),
    sources: { frontend: fields(candidate.sources.frontend, ["repository", "commit", "requiredChecks"]) },
    workload: fields(candidate.workload, ["projectId", "environment"]) } };
  } catch { throw new Error("FRONTEND_PROVIDER_RUNTIME_CONTEXT_REFUSED"); }
}

export async function runFrontendVercelWorker(operation, context) {
  let child, output, failed = false, deadline, killDeadline, received = false, bytes = 0, processing = Promise.resolve();
  try {
    demand(["observe-vercel", "observe-retired-capabilities", "suspend-schedules", "deploy-compatible", "observe-compatible", "deploy-admission", "observe-admission", "retire-deployments", "retire-resend", "observe-resend", "observe-resend-effects", "verify-square", "retire-square", "observe-square", "suspend-square", "suspend-sanity", "observe-sanity", "retire-google", "observe-google", "suspend-highlevel", "verify-highlevel", "retire-highlevel", "observe-highlevel", "suspend-chitchats", "verify-chitchats", "retire-chitchats", "observe-chitchats", "observe-restoration"].includes(operation));
    const { value, bindings, candidate } = await runtime(context);
    const payload = { operation, plan: fields(context.plan, ["environment", "actionId", "sourceCommit", "targetSha256", "bootstrapCompatibility", "restoration"]),
      candidate, bindings, directory: context.directory, vercelToken: value.vercelToken,
      ...(context.originalDirectory ? { originalDirectory: frontendPrivateReceiptDirectory(context.originalDirectory) } : {}),
      ...(context.database ? { database: context.database } : {}),
      ...(context.preapplicationSchema ? { preapplicationSchema: context.preapplicationSchema } : {}),
      ...(context.admissionObservation ? { admissionObservation: context.admissionObservation } : {}) };
    if (operation.startsWith("retire-")) {
      const remaining = context.deadline === undefined ? context.plan.observationBudgetSeconds : Math.ceil((context.deadline - performance.now()) / 1000);
      demand(Number.isInteger(remaining) && remaining > 0);
      payload.retirementObservationSeconds = Math.min(300, remaining);
    }
    if (operation === "observe-retired-capabilities") {
      for (const [provider, keys] of [["google", ["googleIdentityReplacementSecret", "googleCalendarReplacementSecret", "googleIdentityRetiredSecret", "googleCalendarRetiredSecret"]],
        ["chitchats", ["chitchatsReplacementToken", "chitchatsRetiredToken"]], ["sanity", ["sanityReplacementToken", "sanityRetiredToken"]]]) {
        if (!bindings[`${provider}Retirement`]) continue;
        for (const key of keys) {
          demand(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192 && /^[!-~]+$/u.test(value[key]));
          payload[key] = value[key];
        }
      }
    }
    if (operation === "observe-restoration") {
      demand(bindings.gatewayObservation && hash(bindings.gatewayObservation) === context.plan.restoration?.gatewayBindingSha256 &&
        typeof value.gatewayRuntimeDirectory === "string");
      payload.gatewayRuntimeDirectory = frontendPrivateReceiptDirectory(value.gatewayRuntimeDirectory);
    }
    if (bindings.squareRetirement && ["deploy-admission", "verify-square", "retire-square", "observe-square", "suspend-square"].includes(operation)) {
      demand(typeof value.squareReplacementToken === "string" && value.squareReplacementToken.length > 0 && value.squareReplacementToken.length <= 8192 &&
        /^[!-~]+$/u.test(value.squareReplacementToken));
      payload.squareReplacementToken = value.squareReplacementToken;
      if (operation !== "deploy-admission") {
        demand(typeof value.squareRetiredToken === "string" && value.squareRetiredToken.length > 0 && value.squareRetiredToken.length <= 8192 &&
          /^[!-~]+$/u.test(value.squareRetiredToken) && context.databaseClient);
        payload.squareRetiredToken = value.squareRetiredToken;
        payload.squareEffects = await observeFrontendSquareEffects(context.databaseClient, bindings.squareRetirement, context.verifyLockedSession);
      }
    }
    if (bindings.sanityRetirement && ["suspend-sanity", "observe-sanity"].includes(operation)) {
      for (const key of ["sanityReplacementToken", "sanityRetiredToken"]) {
        demand(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192 && /^[!-~]+$/u.test(value[key]));
        payload[key] = value[key];
      }
    }
    if (bindings.googleRetirement && ["retire-google", "observe-google", "deploy-admission"].includes(operation)) {
      if (bindings.googleRetirement.legacyCalendarSha256 !== null) {
        demand(typeof value.googleLegacyCalendarId === "string" && value.googleLegacyCalendarId.length > 0 && value.googleLegacyCalendarId.length <= 1024 &&
          hash(value.googleLegacyCalendarId) === bindings.googleRetirement.legacyCalendarSha256);
        payload.googleLegacyCalendarId = value.googleLegacyCalendarId;
      }
      for (const kind of ["Identity", "Calendar"]) {
        const key = `google${kind}ReplacementSecret`;
        demand(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192 && /^[!-~]+$/u.test(value[key]));
        payload[key] = value[key];
      }
      if (operation !== "deploy-admission") {
        for (const key of ["googleIdentityRetiredSecret", "googleCalendarRetiredSecret", "googleLegacyRedisToken"]) {
          demand(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 8192 && /^[!-~]+$/u.test(value[key]));
          payload[key] = value[key];
        }
        demand(value.googleIdentityRetiredSecret !== value.googleIdentityReplacementSecret && value.googleCalendarRetiredSecret !== value.googleCalendarReplacementSecret);
        const verification = value.googleVerificationGrants ?? {};
        demand(context.databaseClient && ["identity", "calendar"].every(kind => verification[kind] === undefined || verification[kind] === null ||
          typeof verification[kind] === "string" && verification[kind].length > 0 && verification[kind].length <= 8192));
        payload.googlePrivate = { verificationGrants: { identity: verification.identity ?? null, calendar: verification.calendar ?? null },
          calendarObserverGrants: value.googleCalendarObserverGrants ?? {} };
        payload.googleActual = await observeFrontendGoogleDatabase(context.databaseClient, bindings.googleRetirement, value, context.verifyLockedSession, false);
      }
    }
    const crmShipping = /^(suspend|verify|retire|observe)-(highlevel|chitchats)$/u.exec(operation);
    let crmShippingActual, crmShippingReviewed;
    if (crmShipping) {
      const provider = crmShipping[2], prefix = provider === "highlevel" ? "highlevel" : "chitchats";
      crmShippingReviewed = bindings[`${prefix}Retirement`]; demand(crmShippingReviewed && context.databaseClient);
      for (const suffix of ["ReplacementToken", "RetiredToken"]) {
        const token = value[prefix + suffix];
        demand(typeof token === "string" && token.length > 0 && token.length <= 8192 && /^[!-~]+$/u.test(token));
        payload[prefix + suffix] = token;
      }
      demand(value[prefix + "ReplacementToken"] !== value[prefix + "RetiredToken"]);
      if (provider === "highlevel" && crmShippingReviewed.credentialKind === "oauth-installation" && ["verify", "retire"].includes(crmShipping[1])) {
        const refresh = value.highlevelRetiredRefreshCredentials;
        demand(refresh?.client_id === crmShippingReviewed.oauthClientId && ["client_id", "client_secret", "refresh_token"].every(key =>
          typeof refresh[key] === "string" && refresh[key].length > 0 && refresh[key].length <= 8192 && /^[!-~]+$/u.test(refresh[key])));
        payload.highlevelRetiredRefreshCredentials = fields(refresh, ["client_id", "client_secret", "refresh_token"]);
      }
      crmShippingActual = await observeFrontendCrmShippingDatabase(context.databaseClient, provider, crmShippingReviewed,
        context.verifyLockedSession, crmShipping[1] === "suspend");
      payload.crmShippingActual = crmShippingActual;
    }
    if (bindings.resendRetirement && ["deploy-admission", "retire-resend", "observe-resend", "observe-resend-effects"].includes(operation)) {
      demand(typeof value.resendReplacementToken === "string" && value.resendReplacementToken.length > 0 && value.resendReplacementToken.length <= 8192 &&
        /^[!-~]+$/u.test(value.resendReplacementToken));
      payload.resendReplacementToken = value.resendReplacementToken;
      if (operation !== "deploy-admission") {
        demand(typeof value.resendRetiredToken === "string" && value.resendRetiredToken.length > 0 && value.resendRetiredToken.length <= 8192 &&
          /^[!-~]+$/u.test(value.resendRetiredToken));
        payload.resendRetiredToken = value.resendRetiredToken;
      }
    }
    if (["retire-resend", "verify-square", "retire-square", "suspend-square", "retire-google"].includes(operation)) {
      const privateDirectory = frontendPrivateReceiptDirectory(value.privateConfigurationDirectory);
      demand(privateDirectory !== context.directory && !privateDirectory.startsWith(context.directory + sep));
      payload.privateConfigurationDirectory = privateDirectory;
    }
    if (operation === "deploy-compatible" || operation === "deploy-admission") {
      const privateDirectory = frontendPrivateReceiptDirectory(value.privateConfigurationDirectory);
      demand(privateDirectory !== context.directory && !privateDirectory.startsWith(context.directory + sep) &&
        !context.directory.startsWith(privateDirectory + sep) && typeof value.gatewayHost === "string" && value.gatewayHost === bindings.gatewayHost &&
        /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(value.gatewayHost));
      payload.privateConfigurationDirectory = privateDirectory; payload.gatewayHost = value.gatewayHost;
      const control = context.admissionObservation;
      demand(control?.ledgerDrained === true && control.newWork === false && control.recovery === false && control.active === 0 && control.uncertain === 0);
      if (operation === "deploy-admission") {
        const target = context.bootstrapRuntimeTarget;
        demand(target?.environment === "staging" && target.targetSha256 === context.plan.targetSha256 &&
          context.plan.bootstrapCompatibility?.runtimeProducerSha256 && typeof value.frontendRuntimeDatabaseUrl === "string");
        const url = new URL(value.frontendRuntimeDatabaseUrl);
        demand(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === target.host &&
          Number(url.port || 5432) === target.port && decodeURIComponent(url.pathname) === `/${target.database}` &&
          decodeURIComponent(url.username) === target.user && url.password && !url.hash &&
          [...url.searchParams].length === 1 && url.searchParams.get("sslmode") === "verify-full");
        payload.frontendRuntimeDatabaseUrl = value.frontendRuntimeDatabaseUrl;
        payload.writerTarget = target;
      }
    }
    const raw = JSON.stringify(payload) + "\n"; demand(Buffer.byteLength(raw) <= 2_000_000);
    await context.verifyLockedSession(); demand(!context.environmentSignal?.aborted);
    // Python's isolated mode excludes the current directory. Add only this
    // fixed, candidate-source-owned host component directory.
    child = spawn("python3", ["-I", "-B", "-u", "-c", "import runpy,sys; sys.path.insert(0,sys.argv[1]); runpy.run_module('frontend_release_adapters',run_name='__main__')", dirname(script)],
      { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, cwd: resolve(dirname(script), "../../..") });
    const stop = () => {
      failed = true; child.kill("SIGTERM");
      killDeadline ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const abort = () => stop(); context.environmentSignal?.addEventListener("abort", abort, { once: true });
    const lines = createInterface({ input: child.stdout });
    let lastCheckpoint = 0;
    lines.on("line", line => {
      bytes += Buffer.byteLength(line); if (bytes > 8_000_000 || Buffer.byteLength(line) > 2_000_000) { stop(); return; }
      processing = processing.then(async () => {
        demand(!failed);
        const frame = JSON.parse(line);
        if (frame?.type === "checkpoint") {
          demand(!received && Number.isSafeInteger(frame.id) && frame.id === lastCheckpoint + 1);
          await context.verifyLockedSession(); demand(!failed && !context.environmentSignal?.aborted);
          lastCheckpoint = frame.id;
          child.stdin.write(JSON.stringify({ type: "continue", id: frame.id }) + "\n");
        } else {
          demand(frame?.type === "result" && !received && frame.value && typeof frame.value === "object");
          received = true; output = frame.value; child.stdin.end();
        }
      }).catch(stop);
    });
    child.stdin.on("error", stop); child.stdout.on("error", stop);
    const workerBudget = context.deadline === undefined ? 20 * 60_000 : Math.min(20 * 60_000, context.deadline - performance.now());
    demand(workerBudget > 0); deadline = setTimeout(stop, workerBudget);
    const exit = new Promise(resolve => { child.once("error", () => { failed = true; resolve(null); }); child.once("close", code => resolve(code)); });
    child.stdin.write(raw);
    const code = await exit; await processing;
    lines.close(); context.environmentSignal?.removeEventListener("abort", abort);
    demand(code === 0 && !failed && received); await context.verifyLockedSession();
    if (crmShipping) {
      const actual = await observeFrontendCrmShippingDatabase(context.databaseClient, crmShipping[2], crmShippingReviewed, context.verifyLockedSession, false);
      if (frontendCrmShippingSnapshotSha256(actual) !== frontendCrmShippingSnapshotSha256(crmShippingActual)) {
        const depth = context.crmShippingObservationDepth ?? 0;
        demand(crmShipping[1] !== "suspend" && Number.isSafeInteger(depth) && depth >= 0 && depth < 2);
        // The fixed provider observer reclassifies the current rows against
        // original immutable receipts. It never replays an OAuth refresh.
        return runFrontendVercelWorker(`observe-${crmShipping[2]}`, { ...context, crmShippingObservationDepth: depth + 1 });
      }
    }
    return output;
  } catch { throw new Error("FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED"); }
  finally { clearTimeout(deadline); clearTimeout(killDeadline); }
}

export async function fenceFrontendExternalProducers(context) {
  try {
    demand(context.admissionObservation?.newWork === false && typeof context.record === "function");
    const { bindings, value } = await runtime(context);
    const before = await observeHistoricalFrontendCapabilityBindings(context, bindings, value);
    await context.record("historical-capability-bindings-before.json", before);
    await context.record("provider-vercel-fence-preflight.json", await runFrontendVercelWorker("observe-vercel", context));
    await context.record("provider-schedules-suspended.json", await suspendFrontendVercelSchedules(context));
    if (bindings.deploymentRetirement) await context.record("provider-deployments-retired.json", await retireFrontendVercelDeployments(context));
    if (bindings.sanityRetirement) await context.record("provider-sanity-suspended.json", await suspendFrontendSanityHooks(context));
    for (const provider of ["highlevel", "chitchats"]) if (bindings[`${provider}Retirement`])
      await context.record(`provider-${provider}-before.json`, await suspendFrontendCrmShippingCredential(provider, context));
    return { status: "FRONTEND_SELECTED_INGRESS_CONTROLS_OBSERVED", historicalWritersFenced: false,
      activeExecutions: null, uncertainEffects: null };
  } catch {
    try { await context.record("provider-fencing-capabilities.json", { version: 1, environment: "staging", actionId: context.plan.actionId,
      sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256,
      status: "FRONTEND_SELECTED_INGRESS_CONTROL_FAILED_REQUIRES_REVIEW",
      historicalWritersFenced: false, activeExecutions: null, uncertainEffects: null, migrationAuthorized: false, trafficAuthorized: false }); }
    catch { throw new Error("FRONTEND_PROVIDER_CAPABILITY_RECEIPT_FAILED_REVIEW_REQUIRED"); }
    throw new Error("FRONTEND_PROVIDER_INGRESS_CONTROL_FAILED_REVIEW_REQUIRED");
  }
}

export async function reconcileFrontendExternalProducers(context) {
  demand(context.admissionObservation?.newWork === false && context.admissionObservation.recovery === false &&
    context.admissionObservation.ledgerDrained === true && typeof context.record === "function");
  const { bindings } = await runtime(context);
  for (const [provider, operation] of [["square", "retire-square"], ["resend", "retire-resend"], ["google", "retire-google"],
    ["highlevel", "retire-highlevel"], ["chitchats", "retire-chitchats"]]) {
    if (bindings[`${provider}Retirement`]) await context.record(`provider-${provider}-retired.json`, await runFrontendVercelWorker(operation, context));
  }
}

// Qualified controls do not independently establish running/effect drain.
export async function suspendFrontendVercelSchedules(context) {
  return runFrontendVercelWorker("suspend-schedules", context);
}

// Exact reviewed IDs only, after an actual admission-compatible bootstrap.
// This retires future ingress; it never asserts running/provider effect drain.
export async function retireFrontendVercelDeployments(context) {
  demand(context?.admissionObservation?.newWork === false);
  return runFrontendVercelWorker("retire-deployments", context);
}

export async function verifyFrontendSquareCredentialRetirement(context) {
  demand(context?.admissionObservation?.ledgerDrained === true && context.admissionObservation.newWork === false && context.admissionObservation.recovery === false);
  return runFrontendVercelWorker("verify-square", context);
}
export async function suspendFrontendSquareCallback(context) {
  demand(context?.admissionObservation?.ledgerDrained === true && context.admissionObservation.newWork === false && context.admissionObservation.recovery === false);
  return runFrontendVercelWorker("suspend-square", context);
}
export async function observeFrontendSquareScope(context) { return runFrontendVercelWorker("observe-square", context); }

export async function retireFrontendResendCredential(context) {
  demand(context?.admissionObservation?.ledgerDrained === true && context.admissionObservation.newWork === false && context.admissionObservation.recovery === false);
  return runFrontendVercelWorker("retire-resend", context);
}

export async function observeFrontendResendCredential(context) {
  return runFrontendVercelWorker("observe-resend", context);
}

export async function observeFrontendResendEffects(context) {
  return runFrontendVercelWorker("observe-resend-effects", context);
}

export async function suspendFrontendSanityHooks(context) {
  demand(context?.admissionObservation?.newWork === false);
  return runFrontendVercelWorker("suspend-sanity", context);
}

export async function observeFrontendSanityScope(context) {
  return runFrontendVercelWorker("observe-sanity", context);
}

export async function retireFrontendGoogleGrants(context) {
  demand(context?.admissionObservation?.ledgerDrained === true && context.admissionObservation.newWork === false && context.admissionObservation.recovery === false);
  return runFrontendVercelWorker("retire-google", context);
}

export async function observeFrontendGoogleScope(context) {
  return runFrontendVercelWorker("observe-google", context);
}

export async function suspendFrontendCrmShippingCredential(provider, context) {
  demand(["highlevel", "chitchats"].includes(provider) && context?.admissionObservation?.newWork === false);
  return runFrontendVercelWorker(`suspend-${provider}`, context);
}

export async function verifyFrontendCrmShippingRetirement(provider, context) {
  demand(["highlevel", "chitchats"].includes(provider) && context?.admissionObservation?.ledgerDrained === true &&
    context.admissionObservation.newWork === false && context.admissionObservation.recovery === false);
  return runFrontendVercelWorker(`verify-${provider}`, context);
}

export async function observeFrontendCrmShippingScope(provider, context) {
  demand(["highlevel", "chitchats"].includes(provider));
  return runFrontendVercelWorker(`observe-${provider}`, context);
}

export async function readFrontendEstablishedFence(context) {
  const sourceDirectory = context.originalDirectory ?? context.directory;
  const bytes = readFrontendReleaseEvidence(sourceDirectory, "external-fences-after-promotion.json");
  const proof = JSON.parse(bytes.toString("utf8"));
  demand(proof.inventorySha256 === context.inventorySha256 && /^[a-f0-9]{64}$/u.test(proof.nonce) &&
    Array.isArray(proof.surfaces) && proof.surfaces.length === context.plan.externalSurfaces.length);
  const surfaces = context.plan.externalSurfaces.map(surface => {
    const evidence = readFrontendReleaseEvidence(sourceDirectory, `${proof.nonce}-${surface.surfaceSha256}.json`);
    demand(hash(evidence) === proof.surfaces.find(row => row.surfaceSha256 === surface.surfaceSha256)?.evidenceSha256);
    return { surfaceSha256: surface.surfaceSha256, evidence, evidenceSha256: hash(evidence),
      observation: readFrontendReleaseEvidence(sourceDirectory, `${proof.nonce}-${hash({ surfaceSha256: surface.surfaceSha256, artifact: "observation" })}.json`),
      reconciliation: readFrontendReleaseEvidence(sourceDirectory, `${proof.nonce}-${hash({ surfaceSha256: surface.surfaceSha256, artifact: "reconciliation" })}.json`) };
  });
  await validateFrontendFenceObservation(context.plan, proof.nonce, { version: 1, nonce: proof.nonce, actionId: context.plan.actionId,
    sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256, inventorySha256: context.inventorySha256, surfaces }, async () => {});
  return { proofSha256: hash(bytes), strictEvidenceSha256: surfaces.map(row => row.evidenceSha256) };
}

export async function observeFrontendExternalFences(context) {
  const { bindings } = await runtime(context);
  const observations = { vercel: await runFrontendVercelWorker("observe-vercel", context), retirements: {} };
  const sourceDirectory = context.originalDirectory ?? context.directory;
  const readOriginal = name => {
    try {
      const result = JSON.parse(readFrontendReleaseEvidence(sourceDirectory, name).toString("utf8"));
      demand(["actionId", "sourceCommit", "targetSha256"].every(key => result[key] === context.plan[key]));
      return result;
    } catch { return null; }
  };
  const before = readOriginal("historical-capability-bindings-before.json");
  const database = await observeHistoricalFrontendDatabaseFence(context);
  const restoreOpen = context.checkpoint?.startsWith("restoration-") && (database.admission.newWork || database.admission.recovery);
  if (restoreOpen) {
    // Initial settled history stays immutable. Current admitted work may create
    // new provider objects after reopening, so reread the exact earlier strict
    // proof and only the historical capabilities that must remain denied.
    const established = await readFrontendEstablishedFence(context);
    const capabilities = await runFrontendVercelWorker("observe-retired-capabilities", context);
    observations.establishedHistoricalFence = { ...established, retiredCapabilities: capabilities.providers };
  }
  const selected = new Set(bindings.surfaces.filter(row => row.kind === "provider").map(row => row.identity.provider));
  for (const name of selected) {
    const provider = ["google-identity", "google-calendar"].includes(name) ? "google" : name;
    if (observations[provider] === undefined) {
      const key = `${provider}Retirement`;
      if (!bindings[key]) observations[provider] = { status: "SELECTED_PROVIDER_BINDING_MISSING", provider };
      else if (restoreOpen) observations[provider] = observations.establishedHistoricalFence.retiredCapabilities[provider] ??
        { status: "HISTORICAL_CAPABILITY_READBACK_MISSING", provider };
      else try {
        observations[provider] = await runFrontendVercelWorker(`observe-${provider}`, context);
        if (provider === "resend") observations.resendEmails = await observeFrontendResendEffects(context);
      } catch { observations[provider] = { status: "OBSERVATION_FAILED_REQUIRES_REVIEW", provider }; }
      observations.retirements[provider] = readOriginal(`provider-${provider}-${provider === "sanity" ? "suspended" : "retired"}.json`);
    }
    observations[name] = observations[provider];
  }
  const joined = deriveFrontendProviderFence(context.plan, bindings, observations, database, before);
  return { version: 1, nonce: context.nonce, actionId: context.plan.actionId, sourceCommit: context.plan.sourceCommit,
    targetSha256: context.plan.targetSha256, inventorySha256: context.inventorySha256,
    surfaces: bindings.surfaces.map(surface => {
      const derived = joined.find(row => row.surfaceSha256 === surface.surfaceSha256);
      const observation = Buffer.from(JSON.stringify({ provider: observations[surface.identity.provider] ?? observations,
        database, historicalCapabilityBefore: before, retirementReceipts: observations.retirements }));
      const reconciliation = Buffer.from(JSON.stringify({ ...derived.reconciliation,
        evidenceIds: { historicalCapabilityBeforeSha256: before ? hash(before) : null, physicalDatabaseReadbackSha256: hash(database),
          providerReadbackSha256: hash(observations[surface.identity.provider] ?? observations), retirementReceiptsSha256: hash(observations.retirements),
          vercelIngressReadbackSha256: hash(observations.vercel) } }));
      const evidence = Buffer.from(JSON.stringify({ version: 1, nonce: context.nonce, actionId: context.plan.actionId,
        sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256, surfaceSha256: surface.surfaceSha256,
        identitySha256: hash(surface.identity), kind: surface.kind, state: derived.state,
        activeExecutions: derived.activeExecutions, uncertainEffects: derived.uncertainEffects,
        observationSha256: hash(observation), reconciliationSha256: hash(reconciliation) }));
      return { surfaceSha256: surface.surfaceSha256, evidence, evidenceSha256: hash(evidence), observation, reconciliation };
    }) };
}

export async function observeFrontendRestorationBoundary(context) {
  const result = await runFrontendVercelWorker("observe-restoration", context);
  const evidence = Buffer.from(JSON.stringify(result)); return { ...result, evidence, evidenceSha256: hash(evidence) };
}

export async function deployCompatibleFrontend(context) {
  return runFrontendVercelWorker("deploy-compatible", context);
}

export async function observeCompatibleFrontend(context) {
  const result = await runFrontendVercelWorker("observe-compatible", context);
  if (context.checkpoint !== "recovery") demand(result.readyState === "READY" && result.aliasJobState === "succeeded" &&
    result.aliasDeploymentId === result.deploymentId && result.aliasJobDeploymentId === result.deploymentId &&
    result.aliasJobMatchesIntent === true && result.aliasJobType === "promote" &&
    result.nativeSchedulesEnabled === false && result.workloadVerified === true && result.admissionNewWork === false && result.admissionRecovery === false);
  const evidence = Buffer.from(JSON.stringify(result)); return { ...result, evidence, evidenceSha256: hash(evidence) };
}

export async function deployAdmissionCompatibleFrontend(context) {
  return runFrontendVercelWorker("deploy-admission", context);
}

export async function observeAdmissionCompatibleFrontend(context) {
  const result = await runFrontendVercelWorker("observe-admission", context);
  if (context.checkpoint !== "recovery") demand(result.readyState === "READY" && result.aliasJobState === "succeeded" && result.aliasDeploymentId === result.deploymentId &&
    result.aliasJobMatchesIntent === true && result.aliasJobDeploymentId === result.deploymentId && result.aliasJobType === "promote" &&
    result.nativeSchedulesEnabled === false && result.workloadVerified === true && result.bootstrapAdmissionVerified === true &&
    result.admissionNewWork === false && result.admissionRecovery === false &&
    result.schemaCatalogSha256 === context.preapplicationSchema.schemaCatalogSha256 &&
    result.appliedLineageSha256 === context.preapplicationSchema.appliedLineageSha256);
  const evidence = Buffer.from(JSON.stringify(result)); return { ...result, evidence, evidenceSha256: hash(evidence) };
}

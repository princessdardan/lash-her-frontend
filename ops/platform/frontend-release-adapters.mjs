// Concrete source-pinned staging components. No initialization effects, ambient
// credentials, standalone release CLI or claim of whole-provider fencing.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve, dirname, sep } from "node:path";
import { frontendPrivateReceiptDirectory } from "./frontend-release-receipts.mjs";
import { frontendCoordinationHash as hash } from "./frontend-release-inventory.mjs";
import { observeFrontendSquareEffects } from "./frontend-square-effects.mjs";
import { prepareFrontendProviderBindings, frontendProviderMissingCapabilities } from "./frontend-provider-bindings.mjs";

const demand = ok => { if (!ok) throw new Error("FRONTEND_PROVIDER_ADAPTER_REFUSED"); };
const script = fileURLToPath(new URL("./host/frontend_release_adapters.py", import.meta.url));
const fields = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));

async function runtime(context) {
  try {
  demand(typeof context?.verifyLockedSession === "function" && typeof context.getProviderContext === "function");
  await context.verifyLockedSession();
  const value = await context.getProviderContext(Object.freeze({ actionId: context.plan.actionId,
    sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256 }));
  const bindings = prepareFrontendProviderBindings(value?.bindings, context.plan);
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
    demand(["observe-vercel", "suspend-schedules", "deploy-compatible", "observe-compatible", "deploy-admission", "observe-admission", "retire-deployments", "retire-resend", "observe-resend", "observe-resend-effects", "verify-square", "observe-square", "suspend-square", "suspend-sanity", "observe-sanity", "observe-restoration"].includes(operation));
    const { value, bindings, candidate } = await runtime(context);
    const payload = { operation, plan: fields(context.plan, ["environment", "actionId", "sourceCommit", "targetSha256", "bootstrapCompatibility", "restoration"]),
      candidate, bindings, directory: context.directory, vercelToken: value.vercelToken,
      ...(context.originalDirectory ? { originalDirectory: frontendPrivateReceiptDirectory(context.originalDirectory) } : {}),
      ...(context.database ? { database: context.database } : {}),
      ...(context.preapplicationSchema ? { preapplicationSchema: context.preapplicationSchema } : {}),
      ...(context.admissionObservation ? { admissionObservation: context.admissionObservation } : {}) };
    if (operation === "observe-restoration") {
      demand(bindings.gatewayObservation && hash(bindings.gatewayObservation) === context.plan.restoration?.gatewayBindingSha256 &&
        typeof value.gatewayRuntimeDirectory === "string");
      payload.gatewayRuntimeDirectory = frontendPrivateReceiptDirectory(value.gatewayRuntimeDirectory);
    }
    if (bindings.squareRetirement && ["deploy-admission", "verify-square", "observe-square", "suspend-square"].includes(operation)) {
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
    if (["retire-resend", "verify-square", "suspend-square"].includes(operation)) {
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
    deadline = setTimeout(stop, 20 * 60_000);
    const exit = new Promise(resolve => { child.once("error", () => { failed = true; resolve(null); }); child.once("close", code => resolve(code)); });
    child.stdin.write(raw);
    const code = await exit; await processing;
    lines.close(); context.environmentSignal?.removeEventListener("abort", abort);
    demand(code === 0 && !failed && received); await context.verifyLockedSession();
    return output;
  } catch { throw new Error("FRONTEND_VERCEL_ADAPTER_FAILED_REVIEW_REQUIRED"); }
  finally { clearTimeout(deadline); clearTimeout(killDeadline); }
}

export async function fenceFrontendExternalProducers(context) {
  let missing = [{ capability: "runtime-provider-context-and-reviewed-binding-inventory" }], projectMetadataObserved = false;
  try {
    const { bindings } = await runtime(context); missing = frontendProviderMissingCapabilities(bindings);
    // Read real metadata so a capability refusal carries an actual project
    // observation. Disabling a scheduler cannot establish callback/key drain.
    const observed = await runFrontendVercelWorker("observe-vercel", context);
    await context.record("provider-vercel-fence-preflight.json", observed);
    projectMetadataObserved = true;
  } catch { /* retain explicit missing capabilities without private errors */
  } finally {
    demand(typeof context.record === "function");
    try { await context.record("provider-fencing-capabilities.json", { version: 1, environment: "staging", actionId: context.plan.actionId,
      sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256,
      status: "FRONTEND_PROVIDER_FENCE_CAPABILITY_MISSING", missing,
      projectMetadataObserved,
      historicalWritersFenced: false, activeExecutions: null, uncertainEffects: null, migrationAuthorized: false, trafficAuthorized: false }); }
    catch { throw new Error("FRONTEND_PROVIDER_CAPABILITY_RECEIPT_FAILED_REVIEW_REQUIRED"); }
  }
  throw new Error("FRONTEND_PROVIDER_FENCE_CAPABILITY_MISSING");
}

// Qualified subcomponent only. The whole fence above intentionally refuses
// until every vendor/callback/credential surface has actual supported controls.
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

export async function observeFrontendExternalFences(context) {
  const { bindings } = await runtime(context);
  const observed = await runFrontendVercelWorker("observe-vercel", context);
  const resend = bindings.resendRetirement ? await runFrontendVercelWorker("observe-resend", context) : undefined;
  return { version: 1, nonce: context.nonce, actionId: context.plan.actionId, sourceCommit: context.plan.sourceCommit,
    targetSha256: context.plan.targetSha256, inventorySha256: context.inventorySha256,
    surfaces: bindings.surfaces.map(surface => {
      const observation = Buffer.from(JSON.stringify(surface.identity.provider === "vercel" ? observed : surface.identity.provider === "resend" && resend ? resend : {
        status: "PROVIDER_OBSERVATION_UNSUPPORTED", surfaceSha256: surface.surfaceSha256, provider: surface.identity.provider }));
      const reconciliation = Buffer.from(JSON.stringify({ status: "EFFECT_RECONCILIATION_UNAVAILABLE", surfaceSha256: surface.surfaceSha256,
        missing: frontendProviderMissingCapabilities(bindings).filter(row => row.surfaceSha256 === surface.surfaceSha256) }));
      const evidence = Buffer.from(JSON.stringify({ version: 1, nonce: context.nonce, actionId: context.plan.actionId,
        sourceCommit: context.plan.sourceCommit, targetSha256: context.plan.targetSha256, surfaceSha256: surface.surfaceSha256,
        identitySha256: hash(surface.identity), kind: surface.kind, state: "unfenced", activeExecutions: null, uncertainEffects: null,
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

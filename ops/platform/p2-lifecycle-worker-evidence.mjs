// Fixed source parent only. Direct cron invocation is never native evidence.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { isDeepStrictEqual } from "node:util";
import { observeP2LifecycleNativeLedger } from "./p2-lifecycle-native.mjs";
import { frontendReleaseReceiptStore, readFrontendReleaseEvidence } from "./frontend-release-receipts.mjs";
import { decodeQualificationTargetJson, parseQualificationTargetProfileRef, QualificationTargetProfileError, requireQualificationTargetProfile,
  resolveQualificationTargetProfile } from "./qualification-target-profile.mjs";

const plans = new WeakMap(), resolvers = new WeakMap(), credentials = new WeakMap(), invocations = new WeakMap(), artifacts = new WeakMap();
const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_WORKER_EVIDENCE_REFUSED"); };
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const closed = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sourceRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const receiverNegativeProfile = "suspended-head-negatives-v2";
const receiverServices = ["course", "community"];
const receiverNegativeCases = [
  ["exact-replay", 200, "duplicate"],
  ["changed-replay", 409, "idempotency_conflict"],
  ["stale-restore", 409, "account_version_conflict"],
];
export const P2_DIRECT_WORKER_ELIGIBILITY_SQL = Object.freeze({
  deliveries: `SELECT command_id::text,receiver,status,attempts,lease_id::text,lease_until,acknowledged_at,
    next_run_at<=pg_catalog.clock_timestamp() AS ready FROM public.customer_account_deliveries WHERE status<>'acknowledged' ORDER BY command_id,receiver LIMIT 3`,
  exports: `SELECT count(*)::int AS count FROM public.customer_account_exports
    WHERE status IN ('pending','ready') OR (status IN ('failed','expired') AND (data IS NOT NULL OR frontend_data IS NOT NULL))`,
});
function committedSha256(sourceCommit, file) {
  const bytes = execFileSync("git", ["--no-pager", "--no-replace-objects", "--no-optional-locks", "-c", `safe.directory=${sourceRoot}`,
    "show", "--no-ext-diff", "--no-textconv", `${sourceCommit}:${file}`], { cwd: sourceRoot, timeout: 10000, maxBuffer: 2_000_000,
    stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  demand(bytes.equals(readFileSync(new URL(`../../${file}`, import.meta.url)))); return hash(bytes);
}
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
function carrierProfile(plan, value) {
  const profile = profileContext(hasProfile(plan) ? plan.qualificationTargetProfile : undefined, plan, value);
  demand(value?.version === (profile ? 2 : 1)); return profile;
}
function sourceCarrier(plan, status, fields) {
  const profile = hasProfile(plan) ? plan.qualificationTargetProfile : undefined;
  return freeze({ version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}), status, ...fields });
}

export function prepareP2LifecycleWorkerEvidencePlan(nativePlan, suspensionPlan, input, expectedProfile = undefined) {
  if (expectedProfile !== undefined) parseQualificationTargetProfileRef(expectedProfile);
  const profile = profileContext(expectedProfile, nativePlan, nativePlan?.target, suspensionPlan, input);
  const receiverNegatives = input && Object.hasOwn(input, "receiverNegatives");
  if (receiverNegatives) demand(profile && closed(input.receiverNegatives, ["profile"])
    && input.receiverNegatives.profile === receiverNegativeProfile);
  demand(nativePlan?.version === (profile ? 2 : 1) && nativePlan.environment === "staging" && sha(nativePlan.planSha256)
    && suspensionPlan?.profile === "normal-ui-suspension-pending-v1" && suspensionPlan.environment === "staging"
    && (!profile || suspensionPlan.version === 2)
    && nativePlan.sourceCommit === suspensionPlan.sourceCommit && nativePlan.candidateSha256 === suspensionPlan.candidateObjectSha256
    && nativePlan.targetSha256 === suspensionPlan.targetSha256 && nativePlan.configurationRecordSha256 === suspensionPlan.configurationRecordSha256
    && (!profile || nativePlan.actionId === suspensionPlan.releaseId)
    && closed(input, ["version", ...(profile ? ["qualificationTargetProfile"] : []), ...(receiverNegatives ? ["receiverNegatives"] : []),
      "actionId", "commandIndex", "pendingRecordSha256", "canonicalCommandSha256", "gatewayProcessSha256", "gatewayConfigurationSha256", "denialProgramSha256"])
    && input.version === (profile ? 2 : 1) && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.actionId) && Number.isInteger(input.commandIndex)
    && input.commandIndex >= 0 && input.commandIndex < nativePlan.commandWitnesses.length
    && [input.pendingRecordSha256, input.canonicalCommandSha256, input.gatewayProcessSha256, input.gatewayConfigurationSha256, input.denialProgramSha256].every(sha));
  const selected = nativePlan.commandWitnesses[input.commandIndex]; demand(selected.action === "suspend" && uuid(selected.commandId));
  const plan = freeze({ version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}), environment: "staging", profile: "direct-known-suspension-v1", actionId: input.actionId,
    candidateSha256: suspensionPlan.candidateSha256, candidateObjectSha256: suspensionPlan.candidateObjectSha256,
    sourceCommit: suspensionPlan.sourceCommit, configurationSha256: suspensionPlan.configurationSha256,
    nativePlanSha256: nativePlan.planSha256, suspensionPlanSha256: hash(suspensionPlan), targetSha256: nativePlan.targetSha256,
    commandIndex: input.commandIndex, pendingRecordSha256: input.pendingRecordSha256, canonicalCommandSha256: input.canonicalCommandSha256,
    gatewayProcessSha256: input.gatewayProcessSha256, gatewayConfigurationSha256: input.gatewayConfigurationSha256, denialProgramSha256: input.denialProgramSha256,
    sourceProgramSha256: committedSha256(nativePlan.sourceCommit, "ops/platform/p2-lifecycle-worker-evidence.mjs"),
    hostProgramSha256: committedSha256(nativePlan.sourceCommit, "ops/platform/host/p2_lifecycle_worker_evidence.py"),
    denialSourceSha256: committedSha256(nativePlan.sourceCommit, "ops/platform/p2-lifecycle-receiver-denial.mjs"),
    ...(receiverNegatives ? { receiverNegatives: { profile: receiverNegativeProfile,
      sourceSha256: committedSha256(nativePlan.sourceCommit, "ops/platform/p2-lifecycle-receiver-post.mjs"),
      hostSourceSha256: committedSha256(nativePlan.sourceCommit, "ops/platform/host/p2_lifecycle_receiver_negative.py") } } : {}),
    workerInvocations: 1, requiredPrivateInputs: ["FRONTEND_STAGING_CRON_SECRET", "providerContext.frontendRuntimeDatabaseUrl"],
    invocationClass: "direct-source-authenticated-cron", nativeInvocationQualified: false, automaticRetryAllowed: false,
    finalDisposition: "native-off-and-admission-closed", releaseAccepted: false });
  plans.set(plan, { nativePlan, suspensionPlan, selected: structuredClone(selected) }); return plan;
}

// Constructed only by the fixed apply parent. Plan code never calls either
// resolver. There is no configurable variable name, file path or JSON selector.
export function createP2LifecycleWorkerPrivateResolvers(getProviderContext) {
  demand(typeof getProviderContext === "function");
  const handle = Object.freeze({ version: 1, status: "P2_WORKER_SOURCE_PRIVATE_RESOLVERS" });
  resolvers.set(handle, { getProviderContext }); return handle;
}
export function readP2LifecycleWorkerCronSecret(handle) {
  demand(resolvers.has(handle)); const secret = process.env.FRONTEND_STAGING_CRON_SECRET;
  demand(typeof secret === "string" && secret.length > 0 && secret.length <= 8192 && secret.trim() === secret && /^[!-~]+$/u.test(secret)); return secret;
}
export async function readP2LifecycleWorkerRuntimeUrl(handle) {
  const source = resolvers.get(handle); demand(source);
  const value = (await source.getProviderContext()).frontendRuntimeDatabaseUrl;
  demand(typeof value === "string" && value.length > 0 && value.length <= 8192); return value;
}
async function actualStage(plan, handle) {
  demand(plans.has(plan));
  const { readP2CertificationWorkerStage } = await import("./p2-certification-transport.mjs");
  return readP2CertificationWorkerStage(handle, plan);
}
async function ledger(plan, client, dependencies, epoch = null) {
  const source = plans.get(plan); demand(source && client instanceof Client && client.connection?.stream?.encrypted === true
    && client.connection.stream.authorized === true && client.connectionParameters.host === source.nativePlan.target.host
    && Number(client.connectionParameters.port) === source.nativePlan.target.port);
  await dependencies.verifyEnvironment(); await dependencies.verifySession();
  const physical = (await client.query(`SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS role,session_user AS session_role,
    pg_catalog.current_database() AS database,(pg_catalog.current_setting('server_version_num')::int/10000)::int AS major,
    EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid() AND granted
      AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND objsubid=1
      AND classid=((pg_catalog.hashtext($1)::bigint>>32)&4294967295)::oid AND objid=(pg_catalog.hashtext($1)::bigint&4294967295)::oid) AS held`, ["lash-her:private-db:migrations"])).rows[0];
  demand(physical?.held === true && physical.role === source.nativePlan.target.user && physical.session_role === physical.role
    && physical.database === source.nativePlan.target.database && physical.major === source.nativePlan.target.serverMajor
    && (source.backendPid === undefined || source.backendPid === physical.pid)); source.backendPid ??= physical.pid;
  const value = await observeP2LifecycleNativeLedger(source.nativePlan, client, dependencies, epoch);
  await dependencies.verifyEnvironment(); await dependencies.verifySession(); return value;
}
async function exactQueue(client, selected) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const rows = (await client.query(P2_DIRECT_WORKER_ELIGIBILITY_SQL.deliveries)).rows;
    demand(rows.length === 2 && rows.map(row => row.receiver).sort().join() === "community,course" && rows.every(row => row.command_id === selected.commandId
      && row.status === "pending" && row.attempts === 0 && row.lease_id === null && row.lease_until === null && row.acknowledged_at === null && row.ready === true));
    const exports = (await client.query(P2_DIRECT_WORKER_ELIGIBILITY_SQL.exports)).rows[0];
    demand(exports?.count === 0);
  } finally { await client.query("ROLLBACK"); }
}

export async function preflightP2DirectLifecycleWorker(plan, stageHandle, privateResolvers, client, dependencies) {
  const source = plans.get(plan); demand(source && resolvers.has(privateResolvers));
  const before = await ledger(plan, client, dependencies);
  demand(before.newWork === false && before.recovery === false && before.active === 0 && before.uncertain === 0);
  await exactQueue(client, source.selected);
  const stage = await actualStage(plan, stageHandle), result = await stage.preflightCredential(privateResolvers);
  carrierProfile(plan, result);
  demand(result?.status === "P2_DIRECT_WORKER_CREDENTIAL_VERIFIED_CLOSED" && result.bindingSha256 === hash(plan)
    && result.invalidStatus === 401 && result.validClosedStatus === 503 && result.operationIdIssued === false
    && result.credentialBytesRetained === false && result.credentialHashesOutput === false);
  const after = await ledger(plan, client, dependencies);
  demand(after.epoch === before.epoch && after.newWork === false && after.recovery === false && after.active === 0 && after.uncertain === 0);
  const handle = sourceCarrier(plan, "P2_DIRECT_WORKER_CREDENTIAL_SOURCE_ISSUED", { receiptSha256: hash(result) });
  credentials.set(handle, { plan, stageHandle, privateResolvers, epoch: after.epoch, used: false }); return handle;
}

export async function invokeP2DirectLifecycleWorker(plan, credentialHandle, client, dependencies) {
  const source = credentials.get(credentialHandle), binding = plans.get(plan); demand(source?.plan === plan && !source.used); source.used = true;
  const before = await ledger(plan, client, dependencies);
  demand(before.newWork === false && before.recovery === true && before.active === 0 && before.uncertain === 0 && BigInt(before.epoch) > BigInt(source.epoch));
  await exactQueue(client, binding.selected);
  const stage = await actualStage(plan, source.stageHandle), result = await stage.invokeDirect(source.privateResolvers);
  carrierProfile(plan, result);
  demand(result?.status === "P2_DIRECT_WORKER_HTTP_OBSERVED" && result.bindingSha256 === hash(plan) && result.httpStatus === 200
    && uuid(result.operationId) && result.invocationClass === "direct-source-authenticated-cron" && result.nativeInvocationQualified === false
    && Number.isFinite(Date.parse(result.workerInvokedAt)) && result.credentialBytesRetained === false);
  const after = await ledger(plan, client, dependencies, before.epoch);
  demand(after.epoch === before.epoch && after.newWork === false && after.recovery === true && after.active === 0 && after.uncertain === 0
    && after.operations.length === 1 && after.orderViolations.length === 0);
  const operation = after.operations[0], nativePlan = binding.nativePlan;
  demand(operation.id === result.operationId && operation.producer_sha256 === nativePlan.producer.producerSha256 && operation.source_sha === nativePlan.sourceCommit
    && operation.role_oid === nativePlan.producer.role.oid && operation.epoch === before.epoch && operation.kind === "recovery" && operation.state === "completed"
    && operation.started_at !== null && operation.completed_at !== null && Number.isFinite(new Date(operation.started_at).getTime()) && Number.isFinite(new Date(operation.completed_at).getTime())
    && new Date(operation.completed_at).getTime() >= new Date(operation.started_at).getTime() && operation.reconciliation_sha256 === null
    && after.deliveries.filter(row => row.command_id === binding.selected.commandId).length === 2
    && after.deliveries.filter(row => row.command_id === binding.selected.commandId).every(row => row.status === "acknowledged" && row.attempts === 1 && row.acknowledged_at && row.lease_until === null));
  const handle = sourceCarrier(plan, "P2_DIRECT_WORKER_INVOCATION_SOURCE_ISSUED", { operationReceiptSha256: hash(result), ledgerReceiptSha256: hash(after) });
  invocations.set(handle, { plan, stageHandle: source.stageHandle, privateResolvers: source.privateResolvers, result, operation, epoch: before.epoch }); return handle;
}

export async function joinP2DirectLifecycleWorker(plan, invocationHandle, client, dependencies) {
  const source = invocations.get(invocationHandle), binding = plans.get(plan); demand(source?.plan === plan && !source.joined); source.joined = true;
  const state = await ledger(plan, client, dependencies, source.epoch);
  demand(state.newWork === false && state.recovery === false && state.active === 0 && state.uncertain === 0
    && state.operations.length === 1 && state.operations[0].id === source.result.operationId && state.operations[0].state === "completed");
  const stage = await actualStage(plan, source.stageHandle), witness = await stage.observeLifecycleWitness(source.privateResolvers);
  carrierProfile(plan, witness);
  demand(witness?.status === "P2_DIRECT_WORKER_BOTH_ACK_WITNESSED" && witness.bindingSha256 === hash(plan) && sha(witness.privateRecordSha256)
    && witness.receiverAcknowledgedCount === 2 && witness.pendingOrDeliveringCount === 0 && witness.readOnly === true);
  const denials = await stage.observeReceiverDenials();
  carrierProfile(plan, denials);
  demand(denials?.status === "P2_DIRECT_WORKER_RECEIVERS_DENIED" && denials.bindingSha256 === hash(plan)
    && denials.course.evidenceClass === "actual-protected-course-http" && denials.course.httpStatus === 403
    && denials.community.evidenceClass === "deployed-private-community-account-access-guard" && denials.community.httpStatus === null
    && [denials.course, denials.community].every(row => row.version === 1 && !hasProfile(row)
      && row.status === "P2_LIFECYCLE_RECEIVER_DENIAL_OBSERVED" && row.denialStatusCode === 403 && row.accountRestrictionVerified === true));
  const receiverNegatives = plan.receiverNegatives
    ? await joinReceiverNegatives(plan, stage, source.privateResolvers, witness.privateRecordSha256) : undefined;
  const final = await ledger(plan, client, dependencies, source.epoch);
  demand(final.newWork === false && final.recovery === false && final.active === 0 && final.uncertain === 0
    && final.operations.length === 1 && final.operations[0].id === source.result.operationId && final.operations[0].state === "completed");
  const boundary = await stage.finalClosedReadback();
  carrierProfile(plan, boundary);
  demand(boundary?.status === "P2_DIRECT_WORKER_FINAL_CLOSED" && boundary.bindingSha256 === hash(plan)
    && boundary.frontendAdmissionClosed === true && boundary.gatewayAdmissionClosed === true && boundary.nativeEnabled === false
    && boundary.active === 0 && boundary.uncertain === 0);
  const profile = hasProfile(plan) ? plan.qualificationTargetProfile : undefined;
  const record = JSON.parse(JSON.stringify({ version: profile ? 2 : 1, ...(profile ? { qualificationTargetProfile: profile } : {}),
    status: "P2_DIRECT_LIFECYCLE_WORKER_JOINED", bindingSha256: hash(plan), candidateSha256: plan.candidateSha256,
    configurationSha256: plan.configurationSha256, sourceCommit: plan.sourceCommit, targetSha256: plan.targetSha256,
    pendingRecordSha256: plan.pendingRecordSha256, commandId: binding.selected.commandId, accountVersion: Number(binding.selected.accountVersion), action: "suspend",
    workerInvokedAt: source.result.workerInvokedAt, invocationClass: "direct-source-authenticated-cron", nativeScheduleEnabled: false,
    nativeInvocationQualified: false, operation: source.operation, invocation: source.result, lifecyclePrivateRecordSha256: witness.privateRecordSha256,
    receiverDenials: { course: denials.course, community: denials.community }, receiverDeniedCount: 2, receiverDeniedHttpCount: 1,
    ...(receiverNegatives ? { receiverNegatives } : {}),
    frontendActive: 0, frontendUncertain: 0, sourceProgramSha256: hash(readFileSync(new URL("./p2-lifecycle-worker-evidence.mjs", import.meta.url))), releaseAccepted: false }));
  frontendReleaseReceiptStore(dependencies.directory).record("p2-lifecycle-worker-source.json", record);
  const bytes = readFrontendReleaseEvidence(dependencies.directory, "p2-lifecycle-worker-source.json");
  const handle = sourceCarrier(plan, "P2_DIRECT_WORKER_JOINED_SOURCE_ISSUED", { recordSha256: hash(bytes), receiverDeniedCount: 2, receiverDeniedHttpCount: 1 });
  artifacts.set(handle, { plan, record, directory: dependencies.directory }); return handle;
}

async function joinReceiverNegatives(plan, stage, privateResolvers, positiveWitnessSha256) {
  const bindingSha256 = hash(plan), cases = [];
  for (const service of receiverServices) {
    for (const [name, httpStatus, result] of receiverNegativeCases) {
      const row = await stage.observeNextReceiverNegative(privateResolvers);
      carrierProfile(plan, row);
      demand(closed(row, ["version", "qualificationTargetProfile", "status", "bindingSha256", "service", "case", "httpStatus", "result",
        "beforeWitnessSha256", "afterWitnessSha256", "privateRecordSha256", "accountAndDomainStateUnchanged", "quotaWritesExcluded",
        "globallyReadOnly", "releaseAccepted"]) && row.status === "P2_DIRECT_WORKER_RECEIVER_NEGATIVE_CASE_OBSERVED"
        && row.bindingSha256 === bindingSha256 && row.service === service && row.case === name && row.httpStatus === httpStatus && row.result === result
        && sha(row.beforeWitnessSha256) && row.afterWitnessSha256 === row.beforeWitnessSha256 && sha(row.privateRecordSha256)
        && row.accountAndDomainStateUnchanged === true && row.quotaWritesExcluded === true
        && row.globallyReadOnly === false && row.releaseAccepted === false);
      cases.push(row);
    }
  }
  const joined = await stage.joinedReceiverNegatives();
  carrierProfile(plan, joined);
  const openCases = receiverServices.map(service => ({ service, case: "future-gap", status: "OPEN", reason: "current-quiescence-not-positively-proved" }));
  demand(closed(joined, ["version", "qualificationTargetProfile", "status", "bindingSha256", "positiveWitnessSha256", "cases", "openCases",
    "domainStatePreserving", "quotaWritesExcluded", "globallyReadOnly", "oidcVerified", "releaseAccepted", "privateRecordSha256"])
    && joined.status === "P2_DIRECT_WORKER_RECEIVER_NEGATIVES_JOINED" && joined.bindingSha256 === bindingSha256
    && joined.positiveWitnessSha256 === positiveWitnessSha256 && isDeepStrictEqual(joined.cases, cases) && isDeepStrictEqual(joined.openCases, openCases)
    && joined.domainStatePreserving === true && joined.quotaWritesExcluded === true && joined.globallyReadOnly === false
    && joined.oidcVerified === false && joined.releaseAccepted === false && sha(joined.privateRecordSha256));
  return joined;
}
export function readP2DirectWorkerSourceArtifact(plan, handle) {
  const source = artifacts.get(handle); demand(plans.has(plan) && source?.plan === plan);
  const bytes = readFrontendReleaseEvidence(source.directory, "p2-lifecycle-worker-source.json");
  const value = hasProfile(plan) ? decodeQualificationTargetJson(bytes, "carrier") : JSON.parse(bytes.toString("utf8"));
  carrierProfile(plan, value);
  demand(hash(bytes) === handle.recordSha256 && isDeepStrictEqual(value, source.record));
  return { bytes, record: structuredClone(source.record), recordSha256: handle.recordSha256 };
}

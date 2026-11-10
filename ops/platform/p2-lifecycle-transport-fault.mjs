// Source-parent composition only. There is no standalone activation command.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { frontendReleaseReceiptStore } from "./frontend-release-receipts.mjs";
import { observeP2LifecycleNativeLedger } from "./p2-lifecycle-native.mjs";
import { requireQualificationTargetProfile, STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile } from "./qualification-target-profile.mjs";

const plans = new WeakMap();
const canonical = value => JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const closed = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const demand = condition => { if (!condition) throw new Error("P2_LIFECYCLE_TRANSPORT_FAULT_REFUSED"); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

function profileContext(expected, ...carriers) {
  if (expected === undefined) {
    demand(!carriers.some(value => value && Object.hasOwn(value, "qualificationTargetProfile")));
    return undefined;
  }
  return requireQualificationTargetProfile(currentProfile, { qualificationTargetProfile: expected }, ...carriers);
}

export function prepareP2LifecycleTransportFaultPlan(nativePlan, input, expectedProfile) {
  const profile = profileContext(expectedProfile, nativePlan, nativePlan?.target, input), version = profile ? 2 : 1;
  demand(nativePlan?.version === version && nativePlan.environment === "staging" && nativePlan.projectId === "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM"
    && nativePlan.finalDisposition === "disabled-and-admission-closed" && sha(nativePlan.planSha256)
    && sha(nativePlan.candidateSha256) && sha(nativePlan.targetSha256) && /^[a-f0-9]{40}$/u.test(nativePlan.sourceCommit)
    && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(nativePlan.actionId) && Array.isArray(nativePlan.commandWitnesses)
    && closed(input, ["version", ...(profile ? ["qualificationTargetProfile"] : []), "stageId", "mode", "receiver", "commandIndex", "candidateSha256", "commandSha256", "configurationSha256", "gatewayConfigurationSha256", "gatewayImageSha256", "gatewayProcessSha256", "operatorSourceCommit", "operatorSourceClosureSha256"])
    && input.version === version && /^[a-f0-9]{40}$/u.test(input.operatorSourceCommit)
    && (!profile || input.operatorSourceCommit === nativePlan.sourceCommit)
    && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.stageId) && ["503-before-upstream", "drop-after-ack"].includes(input.mode)
    && ["course", "community"].includes(input.receiver) && Number.isInteger(input.commandIndex) && input.commandIndex >= 0
    && input.commandIndex < nativePlan.commandWitnesses.length && [input.candidateSha256, input.commandSha256, input.configurationSha256, input.gatewayConfigurationSha256,
      input.gatewayImageSha256, input.gatewayProcessSha256, input.operatorSourceClosureSha256].every(sha));
  const selected = nativePlan.commandWitnesses[input.commandIndex]; demand(uuid(selected.commandId));
  const plan = freeze({ version, ...(profile ? { qualificationTargetProfile: profile } : {}), environment: "staging", profile: "lifecycle-known-command-v1", actionId: nativePlan.actionId, stageId: input.stageId,
    sourceCommit: nativePlan.sourceCommit,
    candidateSha256: input.candidateSha256, candidateObjectSha256: nativePlan.candidateSha256, nativePlanSha256: nativePlan.planSha256, targetSha256: nativePlan.targetSha256,
    mode: input.mode, receiver: input.receiver, commandSha256: input.commandSha256, configurationSha256: input.configurationSha256,
    gatewayConfigurationSha256: input.gatewayConfigurationSha256, gatewayImageSha256: input.gatewayImageSha256,
    gatewayProcessSha256: input.gatewayProcessSha256, commandSelectionSha256: hash({ nativePlanSha256: nativePlan.planSha256, commandIndex: input.commandIndex }),
    operatorSourceCommit: input.operatorSourceCommit, operatorSourceClosureSha256: input.operatorSourceClosureSha256,
    leaseMilliseconds: 120000, maxMatches: 1, finalDisposition: "fault-disabled-native-off-and-admission-closed",
    standaloneActivationEligible: false, automaticReplayAllowed: false, automaticReconciliationAllowed: false, releaseAccepted: false });
  plans.set(plan, { nativePlan, selected: structuredClone(selected), profile }); return plan;
}

function physicalVerifier(nativePlan, client, verifyEnvironment, verifySession, probe) {
  let originalPid;
  return async () => {
    await verifyEnvironment(); await verifySession();
    demand(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true
      && client.connectionParameters?.host === nativePlan.target.host && Number(client.connectionParameters.port) === nativePlan.target.port);
    const identity = (await client.query(`SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,
      pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major`)).rows[0];
    demand(identity && Number.isInteger(identity.pid) && (originalPid === undefined || identity.pid === originalPid)
      && identity.username === nativePlan.target.user && identity.session_username === nativePlan.target.user
      && identity.database === nativePlan.target.database && identity.major === nativePlan.target.serverMajor);
    originalPid ??= identity.pid;
    if (probe) {
      const backend = (await client.query('SELECT backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0];
      demand(identity.pid === probe.backendPid && backend?.backend_start === probe.backendStart);
    }
    for (const key of ["lash-her:private-db:migrations", ...(probe ? [probe.marker] : [])]) {
      const locked = (await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid()
      AND granted AND mode='ExclusiveLock' AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
      AND objsubid=1 AND classid=((pg_catalog.hashtext($1)::bigint>>32)&4294967295)::oid
      AND objid=(pg_catalog.hashtext($1)::bigint&4294967295)::oid) AS held`, [key])).rows[0];
      demand(locked?.held === true);
    }
  };
}

async function selectedCommand(client, expected) {
  demand(uuid(expected.commandId));
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const rows = (await client.query(`SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command
      FROM public.customer_account_commands WHERE command_id=$1::uuid`, [expected.commandId])).rows;
    demand(rows.length === 1 && rows[0].account_version === expected.accountVersion && rows[0].action === expected.action);
    const command = rows[0].command;
    demand(closed(command, ["version", "commandId", "userId", "accountVersion", "action", "issuedAt"]) && command.version === 1
      && command.commandId === rows[0].command_id && command.userId === rows[0].user_id && uuid(command.userId)
      && String(command.accountVersion) === expected.accountVersion && command.action === expected.action
      && Number.isSafeInteger(command.accountVersion) && command.accountVersion >= 1 && new Date(command.issuedAt).toISOString() === command.issuedAt
      && new Date(rows[0].issued_at).toISOString() === command.issuedAt);
    const pending = (await client.query(`SELECT command_id::text,receiver,status,attempts,lease_id::text,lease_until,
      next_run_at<=pg_catalog.clock_timestamp() AS ready FROM public.customer_account_deliveries
      WHERE status<>'acknowledged' ORDER BY command_id,receiver LIMIT 2`)).rows;
    return { command, pending };
  } finally { await client.query("ROLLBACK"); }
}

function assertHostObservation(value, plan, recovery = true, zero = true) {
  profileContext(plan.qualificationTargetProfile, value);
  demand(value?.version === plan.version && value.status === "P2_FAULT_HOST_CURRENT" && value.candidateSha256 === plan.candidateSha256
    && value.candidateObjectSha256 === plan.candidateObjectSha256
    && value.configurationSha256 === plan.configurationSha256 && value.gatewayConfigurationSha256 === plan.gatewayConfigurationSha256
    && value.gatewayImageSha256 === plan.gatewayImageSha256 && value.gatewayProcessSha256 === plan.gatewayProcessSha256
    && value.operatorSourceCommit === plan.operatorSourceCommit && value.operatorSourceClosureSha256 === plan.operatorSourceClosureSha256
    && value.targetSha256 === plan.targetSha256
    && sha(value.runtimeInventorySha256) && value.gatewayAdmission?.valid === true && value.gatewayAdmission.newWork === false
    && (plan.version === 1 || value.gatewayAdmission.releaseId === plan.actionId && value.gatewayAdmission.candidateSha256 === plan.candidateSha256)
    && value.gatewayAdmission.recovery === recovery && ["newWork", "recovery"].every(key => Number.isInteger(value.gatewayAdmission.active?.[key])
      && value.gatewayAdmission.active[key] >= 0 && Number.isInteger(value.gatewayAdmission.uncertain?.[key]) && value.gatewayAdmission.uncertain[key] >= 0
      && (!zero || value.gatewayAdmission.active[key] === 0 && value.gatewayAdmission.uncertain[key] === 0))
    && value.faultLeasePresent === false);
}

async function nativeMetadata(nativePlan, control) {
  const value = await control.observeMetadata(nativePlan);
  requireNativeProfile(nativePlan, value);
  demand(value?.projectId === nativePlan.projectId && value.deploymentId === nativePlan.deploymentId && value.sourceCommit === nativePlan.sourceCommit
    && value.deploymentUrl === nativePlan.deploymentUrl && isDeepStrictEqual(value.schedule, nativePlan.schedule) && typeof value.nativeEnabled === "boolean");
  return value;
}

function requireNativeProfile(plan, value) {
  if (plan.qualificationTargetProfile === undefined) return;
  profileContext(plan.qualificationTargetProfile, value);
  demand(value.version === 2 && value.environment === 'staging' && value.releaseId === plan.actionId &&
    value.candidateSha256 === plan.candidateSha256 && value.phase2ContractManifestSha256 === plan.phase2ContractManifestSha256);
}

async function nativeBoundary(nativePlan, control) {
  const current = await control.observe(nativePlan);
  requireNativeProfile(nativePlan, current);
  demand(current?.configurationRecordSha256 === nativePlan.configurationRecordSha256
    && isDeepStrictEqual(current.featureControls, nativePlan.featureControls)
    && isDeepStrictEqual(current.writerAdmissionBinding, nativePlan.writerAdmissionBinding));
  const metadata = await nativeMetadata(nativePlan, control);
  demand(current.projectId === metadata.projectId && current.deploymentId === metadata.deploymentId && current.sourceCommit === metadata.sourceCommit
    && current.deploymentUrl === metadata.deploymentUrl && isDeepStrictEqual(current.schedule, metadata.schedule)
    && current.nativeEnabled === metadata.nativeEnabled);
  return current;
}

export async function runP2LifecycleTransportFault(input, expectedProfile) {
  const { plan, client, verifyEnvironment, verifySession, withOwner, hostStage, nativeControl, exercise, containFrontend, directory, frontendProbe } = input;
  const binding = plans.get(plan);
  demand(binding && input.confirmation === `staging/${plan.actionId}` && typeof verifyEnvironment === "function" && typeof verifySession === "function"
    && typeof withOwner === "function" && typeof exercise === "function" && typeof containFrontend === "function"
    && ["verify", "observe", "arm", "disarm", "closeGateway", "effects"].every(name => typeof hostStage?.[name] === "function")
    && typeof nativeControl?.observe === "function" && typeof nativeControl.observeMetadata === "function");
  const profile = profileContext(expectedProfile, plan);
  demand(isDeepStrictEqual(profile, binding.profile));
  if (profile) {
    profileContext(profile, frontendProbe, frontendProbe?.job, frontendProbe?.job?.target, frontendProbe?.receipt,
      frontendProbe?.receipt?.target, frontendProbe?.plan, frontendProbe?.plan?.nativePlan, frontendProbe?.plan?.nativePlan?.target);
    demand(frontendProbe.version === 2 && frontendProbe.job.version === 2 && frontendProbe.receipt.version === 2 && frontendProbe.plan.version === 2 &&
      frontendProbe.receipt.status === 'P2_CERTIFICATION_DATABASE_CURRENT' && frontendProbe.receipt.candidateSha256 === plan.candidateSha256 &&
      [frontendProbe.job, frontendProbe.receipt].every(row => row.releaseId === plan.actionId && row.sourceCommit === plan.sourceCommit) &&
      frontendProbe.receipt.planSha256 === frontendProbe.plan.planSha256 && frontendProbe.receipt.targetSha256 === plan.targetSha256 &&
      isDeepStrictEqual(frontendProbe.plan.nativePlan, binding.nativePlan) && sha(frontendProbe.marker) &&
      Number.isSafeInteger(frontendProbe.backendPid) && frontendProbe.backendPid > 0 &&
      typeof frontendProbe.backendStart === 'string' && frontendProbe.backendStart.length > 0 && frontendProbe.backendStart.length <= 80);
  } else demand(frontendProbe === undefined);
  plans.delete(plan); // One source invocation; an unknown attempt is never replayed.
  const { nativePlan, selected } = binding, store = frontendReleaseReceiptStore(directory), dependencies = { verifySession, withOwner };
  const probeIdentity = profile ? { marker: frontendProbe.marker, backendPid: frontendProbe.backendPid, backendStart: frontendProbe.backendStart } : undefined;
  const verify = physicalVerifier(nativePlan, client, verifyEnvironment, verifySession, probeIdentity);
  let primaryFailure = false, effect, before, after, gatewayClosure, frontendClosure,
    faultDisabled = false, finalLedger, nativeOff = false, nativeEnabled = null, frontendRuntimeBindingVerified = false,
    phase = "physical-preflight", failurePhase = null;
  const outcome = () => ({ version: plan.version, ...(profile ? { qualificationTargetProfile: profile } : {}), status: !primaryFailure && effect && faultDisabled && gatewayClosure?.gatewayAdmissionClosed === true
      && frontendClosure?.frontendAdmissionClosed === true && nativeOff && frontendRuntimeBindingVerified
      && finalLedger?.newWork === false && finalLedger.recovery === false
      && finalLedger.active === 0 && finalLedger.uncertain === 0
      && ["newWork", "recovery"].every(key => gatewayClosure.active?.[key] === 0 && gatewayClosure.uncertain?.[key] === 0)
      ? "P2_LIFECYCLE_TRANSPORT_FAULT_OBSERVED_CONTAINED" : "P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW",
    environment: "staging", stageId: plan.stageId, candidateSha256: plan.candidateSha256, mode: plan.mode, receiver: plan.receiver,
    ...(profile ? { targetSha256: plan.targetSha256, sourceCommit: plan.sourceCommit, nativePlanSha256: plan.nativePlanSha256 } : {}),
    phase, failurePhase, injectedEffectSha256: effect ? hash(effect) : null, beforeLedgerSha256: before ? hash(before) : null, afterLedgerSha256: after ? hash(after) : null,
    faultDisabled, gatewayAdmissionClosed: gatewayClosure?.gatewayAdmissionClosed ?? null,
    frontendAdmissionClosed: frontendClosure?.frontendAdmissionClosed === false ? false
      : frontendClosure?.frontendAdmissionClosed === true && finalLedger ? finalLedger.newWork === false && finalLedger.recovery === false : null,
    nativeEnabled,
    frontendRuntimeBindingVerified,
    outstandingActive: finalLedger?.active ?? null, outstandingUncertain: finalLedger?.uncertain ?? null,
    gatewayOutstandingActive: gatewayClosure?.active ?? null, gatewayOutstandingUncertain: gatewayClosure?.uncertain ?? null,
    uncertaintySettled: finalLedger ? finalLedger.active === 0 && finalLedger.uncertain === 0 : false,
    automaticReconciliationPerformed: false, nativeInvocationQualified: false, deployedCertificationComplete: false, releaseAccepted: false });
  const retain = (name, value) => store.record(name, value);
  try {
    await verify(); await hostStage.verify(plan);
    // This call independently enforces the native component's process-local
    // plan brand and actual owner role/OID before any fault activation.
    before = await observeP2LifecycleNativeLedger(nativePlan, client, dependencies);
    demand(before.newWork === false && before.recovery === true && before.active === 0 && before.uncertain === 0);
    const metadata = await nativeBoundary(nativePlan, nativeControl); demand(metadata.nativeEnabled === false);
    assertHostObservation(await hostStage.observe(plan), plan);
    const actual = await selectedCommand(client, selected);
    demand(hash(actual.command) === plan.commandSha256 && actual.pending.length === 1
      && actual.pending[0].command_id === selected.commandId && actual.pending[0].receiver === plan.receiver
      && actual.pending[0].status === "pending" && actual.pending[0].lease_id === null && actual.pending[0].lease_until === null && actual.pending[0].ready === true);
    demand(before.deliveries.some(row => row.command_id === selected.commandId && row.receiver !== plan.receiver && row.status === "acknowledged" && row.acknowledged_at !== null));
    await verify(); await hostStage.verify(plan);
    if (profile) {
      demand((await nativeBoundary(nativePlan, nativeControl)).nativeEnabled === false);
      await verify();
    }
    retain("p2-fault-started.json", { ...plan, initialEpoch: before.epoch, sourceCommandWitnessSha256: hash(actual.command), status: "P2_LIFECYCLE_FAULT_STARTED" });
    phase = "arm";
    const record = { commandId: actual.command.commandId, accountVersion: actual.command.accountVersion, canonicalSha256: hash(actual.command) };
    const armedReceipt = await hostStage.arm(plan, record);
    if (profile) {
      profileContext(profile, armedReceipt);
      demand(armedReceipt.version === 2 && armedReceipt.stageId === plan.stageId && armedReceipt.maxMatches === 1 &&
        armedReceipt.gatewayProcessSha256 === plan.gatewayProcessSha256);
    }
    demand(armedReceipt?.status === "P2_FAULT_LEASE_ARMED" && sha(armedReceipt.leaseSha256));
    retain("p2-fault-armed.json", armedReceipt);
    phase = "actual-worker-invocation";
    await exercise(plan);
    await verify(); await hostStage.verify(plan);
    const effects = await hostStage.effects(plan);
    const effectFields = ["version", "status", "environment", "profile", "stageId", "candidateSha256", "configurationSha256", "gatewayProcessSha256", "gatewayImageSha256",
      "sourceWitnessSha256", "leaseSha256", "mode", "receiver", "upstreamStarted", "downstreamDisposition", "upstreamReceiptVerified",
      ...(plan.mode === "drop-after-ack" ? ["upstreamStatus", "downstreamBytesStarted"] : [])];
    demand(Array.isArray(effects) && effects.length === 1 && closed(effects[0], effectFields) && effects[0].version === 1
      && effects[0].environment === "staging" && effects[0].profile === plan.profile && effects[0].configurationSha256 === plan.configurationSha256
      && effects[0].status === "P2_TRANSPORT_FAULT_INJECTED"
      && effects[0].stageId === plan.stageId && effects[0].candidateSha256 === plan.candidateSha256 && effects[0].leaseSha256 === armedReceipt.leaseSha256
      && effects[0].gatewayProcessSha256 === plan.gatewayProcessSha256 && effects[0].gatewayImageSha256 === plan.gatewayImageSha256
      && effects[0].sourceWitnessSha256 === plan.commandSha256 && effects[0].mode === plan.mode && effects[0].receiver === plan.receiver
      && (plan.mode === "503-before-upstream" ? effects[0].upstreamStarted === false && effects[0].upstreamReceiptVerified === false && effects[0].downstreamDisposition === "503"
        : effects[0].upstreamStarted === true && effects[0].upstreamReceiptVerified === true && effects[0].upstreamStatus === 200 && effects[0].downstreamBytesStarted === false
          && effects[0].downstreamDisposition === "dropped-before-any-response-bytes"));
    effect = effects[0];
    after = await observeP2LifecycleNativeLedger(nativePlan, client, dependencies, before.epoch);
    demand(after.deliveries.some(row => row.command_id === selected.commandId && row.receiver === plan.receiver
      && row.attempts > actual.pending[0].attempts && ["pending", "acknowledged"].includes(row.status)));
    retain("p2-fault-effect.json", { effect, ledgerSha256: hash(after) });
  } catch { primaryFailure = true; failurePhase = phase; }
  finally {
    // Never skip cleanup because a verifier, provider, record write or socket
    // failed. The source parent must await this before releasing its locks.
    {
      phase = "containment";
      try {
        const disabled = await hostStage.disarm(plan);
        if (profile) { profileContext(profile, disabled); demand(disabled.version === 2 && disabled.leaseAbsent === true); }
        faultDisabled = disabled.faultDisabled === true;
      } catch { primaryFailure = true; failurePhase ??= phase; }
      try {
        gatewayClosure = await hostStage.closeGateway(plan);
        if (profile) { profileContext(profile, gatewayClosure); demand(gatewayClosure.version === 2 && gatewayClosure.fileFencePersisted === true); }
      } catch { primaryFailure = true; failurePhase ??= phase; }
      try { frontendClosure = await containFrontend(nativePlan, { faultDisabled, gatewayClosure }); } catch { primaryFailure = true; failurePhase ??= phase; }
      try { await verify(); finalLedger = await observeP2LifecycleNativeLedger(nativePlan, client, dependencies); } catch { primaryFailure = true; failurePhase ??= phase; }
      // Discard earlier cleanup observations before independent terminal reads.
      // Neither a successful close call nor an earlier metadata GET is final.
      faultDisabled = null;
      gatewayClosure = { gatewayAdmissionClosed: null, active: null, uncertain: null };
      try {
        const current = await hostStage.observe(plan);
        assertHostObservation(current, plan, false, false);
        faultDisabled = current.faultLeasePresent === false;
        gatewayClosure = { gatewayAdmissionClosed: true, active: current.gatewayAdmission.active, uncertain: current.gatewayAdmission.uncertain };
      } catch { primaryFailure = true; failurePhase ??= phase; }
      nativeOff = false; nativeEnabled = null; frontendRuntimeBindingVerified = false;
      try {
        nativeEnabled = (await nativeBoundary(nativePlan, nativeControl)).nativeEnabled;
        nativeOff = nativeEnabled === false; frontendRuntimeBindingVerified = true;
      } catch {
        primaryFailure = true; failurePhase ??= phase;
        // A full protected-probe failure must not hide actual metadata-only
        // disable evidence, and that fallback never authorizes qualification.
        try { nativeEnabled = (await nativeMetadata(nativePlan, nativeControl)).nativeEnabled; nativeOff = nativeEnabled === false; }
        catch { nativeEnabled = null; nativeOff = false; }
      }
      try { retain("p2-fault-outcome.json", outcome()); } catch { primaryFailure = true; failurePhase ??= phase; }
    }
  }
  const result = outcome();
  if (result.status !== "P2_LIFECYCLE_TRANSPORT_FAULT_OBSERVED_CONTAINED") {
    const failure = new Error("P2_LIFECYCLE_TRANSPORT_FAULT_REQUIRES_REVIEW"); failure.publicReceipt = result; throw failure;
  }
  return result;
}

// Deliberate post-SQL restoration API. Original candidate/jobs are immutable.
import { lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { prepareFrontendReleaseCoordination, loadFrontendReleaseAdapters } from './frontend-release-coordinator.mjs';
import { frontendCoordinationHash, validateFrontendFenceObservation } from './frontend-release-inventory.mjs';
import { frontendPrivateReceiptDirectory, frontendReleaseReceiptStore, readFrontendReleaseEvidence } from './frontend-release-receipts.mjs';
import { prepareP2CertificationProfile } from './p2-certification-profile.mjs';
import { restoreFrontendAdmission } from './frontend-release-restoration.mjs';
import { withRecoveryFrontendSession,issueP2RecoveryForwardScope,verifyP2RecoveryForwardMutation } from './p2-recovery-current-probe.mjs';
import { observeP2RecoveryFrontend,reconcileP2RecoveryForward,buildP2RecoveryForward } from './p2-recovery-frontend-observation.mjs';
import {readCompatibleFrontendWorkloadReceipt} from './frontend-release-adapters.mjs';

const require = ok => { if (!ok) throw new Error('P2_POST_SQL_RECOVERY_REFUSED'); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) && !/^0+$/u.test(value);
export function p2RecoveryProviderContext(prepared,dependencies,{client,verify,environmentSignal,action}){
  const {plan,migration}=prepared,target=migration.job.target;
  return {candidate:migration.candidate,directory:dependencies.directory,originalDirectory:dependencies.originalDirectory,
    inventorySha256:prepared.inventorySha256,...(action?{action,recoveryActionId:action.recoveryActionId}:{}),
    bootstrapRuntimeTarget:{environment:plan.environment,targetSha256:plan.targetSha256,host:target.host,port:target.port,database:target.database,user:target.runtimeRole,serverMajor:target.serverMajor},
    getProviderContext:dependencies.getProviderContext,databaseClient:client,verifyLockedSession:verify,environmentSignal};
}
export function prepareP2PostSqlRecovery(prepared, input, candidateBytes) {
  require(Buffer.isBuffer(candidateBytes) && candidateBytes.length <= 2_000_000 && isDeepStrictEqual(JSON.parse(candidateBytes), prepared.migration.candidate));
  const checked = prepareFrontendReleaseCoordination(prepared.migration.candidate, prepared.migration.job, prepared.migration.baseline, prepared.plan, prepared.sourceInventory);
  const { plan, migration } = checked;
  require(migration.candidate.contractPhase === 'p2' && plan.restoration?.recovery === true && plan.restoration.newWork === true);
  prepareP2CertificationProfile(plan.certification);
  require(input?.version === 1 && input.environment === 'staging' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.recoveryActionId ?? '') &&
    input.recoveryActionId !== plan.actionId && input.originalReleaseId === plan.actionId && input.candidateSha256 === frontendCoordinationHash(candidateBytes) &&
    input.sourceCommit === plan.sourceCommit && input.inventorySha256 === checked.inventorySha256 && digest(input.configurationSha256) &&
    ['reuse-retained-ready','reviewed-new-build'].includes(input.frontendMode) && input.originalReceiptSha256 && typeof input.originalReceiptSha256 === 'object');
  const forward=input.frontendMode==='reviewed-new-build';
  if(forward)require(['prior-build-failed','prior-build-canceled','retained-ready-probe-expired'].includes(input.forwardReason)&&
    typeof input.forwardPrivateConfigurationDirectory==='string'&&resolve(input.forwardPrivateConfigurationDirectory)===input.forwardPrivateConfigurationDirectory);
  const pins = input.originalReceiptSha256;
  require(Object.hasOwn(pins, 'frontend-release-started.json') && digest(pins['frontend-release-started.json']) &&
    Object.hasOwn(pins, 'database-receipt.json') &&
    Object.hasOwn(pins, 'job-outcome.json') && (pins['job-outcome.json'] === null || digest(pins['job-outcome.json'])) &&
    Object.keys(pins).length <= 128 && Object.entries(pins).every(([key, value]) => /^(?:vercel\/)?[a-z0-9][a-z0-9.-]{0,180}\.json$/u.test(key) && (value === null || digest(value))));
  const retained=['frontend-build-started.json','frontend-build-created.json','frontend-build-outcome.json',...(!forward||input.forwardReason==='retained-ready-probe-expired'?['frontend-promotion-started.json','frontend-workload-outcome.json']:[])];
  require(retained.every(name=>digest(pins['vercel/'+name])));
  if(forward&&input.forwardReason==='retained-ready-probe-expired')require(digest(pins['vercel/frontend-probe-preparation.json']));
  if(forward&&input.forwardReason!=='retained-ready-probe-expired')require(pins['vercel/frontend-promotion-started.json']===null&&pins['vercel/frontend-workload-outcome.json']===null);
  return { prepared: { ...checked, ...(prepared.sourceInventory ? { sourceInventory:prepared.sourceInventory } : {}) }, action: { version: 1, environment: 'staging', recoveryActionId: input.recoveryActionId, originalReleaseId: plan.actionId,
    sourceCommit: plan.sourceCommit, candidateSha256: input.candidateSha256, inventorySha256: checked.inventorySha256,
    configurationSha256: input.configurationSha256, originalReceiptSha256: structuredClone(pins), frontendMode: input.frontendMode,
    ...(forward?{forwardReason:input.forwardReason,forwardPrivateConfigurationDirectory:input.forwardPrivateConfigurationDirectory}:{}),
    sqlReplayAuthorized: false, rolePreparationAuthorized: false, historicalLoginsRestored: false, failedBuildForwardAction: forward?'REVIEWED_NEW_BUILD':'OPEN' } };
}

export function bindOriginalRecoveryReceipts(directory, action, prepared) {
  frontendPrivateReceiptDirectory(directory);
  for (const [name, expected] of Object.entries(action.originalReceiptSha256)) {
    const parts=name.split('/'),parent=parts.length===2?join(directory,parts[0]):directory,file=parts.at(-1);
    frontendPrivateReceiptDirectory(parent);
    if (expected === null) require(lstatSync(join(parent,file),{throwIfNoEntry:false}) === undefined);
    else require(frontendCoordinationHash(readFrontendReleaseEvidence(parent,file)) === expected);
  }
  const original = JSON.parse(readFrontendReleaseEvidence(directory, 'frontend-release-started.json'));
  require(original.actionId === action.originalReleaseId && original.sourceCommit === action.sourceCommit && original.environment === 'staging' &&
    original.targetSha256 === prepared.plan.targetSha256 && original.inventorySha256 === action.inventorySha256 && original.adaptersSha256 === prepared.plan.adaptersSha256);
}

export async function runP2PostSqlRecovery(input, dependencies) {
  const selected = prepareP2PostSqlRecovery(input.prepared, input.action, input.candidateBytes);
  const { action, prepared } = selected, { plan, migration, inventorySha256 } = prepared;
  require(dependencies.confirmation === `staging/${action.recoveryActionId}` && dependencies.directory !== dependencies.originalDirectory &&
    typeof dependencies.withRecoveryEnvironmentLock === 'function');
  const store = frontendReleaseReceiptStore(dependencies.directory);
  bindOriginalRecoveryReceipts(dependencies.originalDirectory, action, prepared);
  const sourceRoot = dependencies.sourceRoot ?? resolve(new URL('../..', import.meta.url).pathname);
  const adapters = await loadFrontendReleaseAdapters(sourceRoot, plan.adaptersSha256);
  const base = { ...action, ...(dependencies.operatorSourceCommit ? { operatorSourceCommit:dependencies.operatorSourceCommit } : {}), targetSha256: plan.targetSha256, contractPhase: 'p2', phase2ContractManifestSha256: migration.job.phase2ContractManifestSha256,
    trafficAuthorized: false, originalFrontendTerminalRecreated: false };
  await store.record('p2-recovery-started.json', { ...base, status: 'P2_POST_SQL_RECOVERY_STARTED' });
  let host, phase = 'remote-environment-lock';
  try {
    return await dependencies.withRecoveryEnvironmentLock(async (verifyEnvironment, environmentSignal, actualHost) => {
      host = actualHost;
      require(host?.mode === 'p2-post-sql-recovery' && host.recoveryActionId === action.recoveryActionId);
      const guard = async () => { await dependencies.assertSource?.(); await verifyEnvironment(); bindOriginalRecoveryReceipts(dependencies.originalDirectory, action, prepared); };
      await guard();
      const completed = await withRecoveryFrontendSession(prepared, action, { ...dependencies, verifyEnvironment: guard }, async ({ client, verify, receipt, probe,session }) => {
        // Restoration primitives own their transaction; SET ROLE is session-local
        // only during the bounded call and always reset before verification.
        const restorationOwner = async task => { await verify(); await client.query(`SET ROLE "${plan.owner.name}"`); try { return await task(); } finally { await client.query('RESET ROLE'); await verify(); } };
        const providerContext=p2RecoveryProviderContext(prepared,dependencies,{client,verify,environmentSignal,action});
        const fences = async checkpoint => {
          await verify(); bindOriginalRecoveryReceipts(dependencies.originalDirectory, action, prepared);
          const nonce = randomBytes(32).toString('hex');
          const actual = await adapters.observeFrontendExternalFences({ plan, inventorySha256, nonce, checkpoint, recoveryActionId: action.recoveryActionId, ...providerContext });
          await validateFrontendFenceObservation(plan, nonce, actual, store.retain); await verify();
        };
        phase = 'fresh-current-database-and-provider-fences';
        await store.record('p2-recovery-current-database.json', receipt);
        await host.armRecovery({ receipt, probe }); await verify();
        if(action.frontendMode==='reviewed-new-build'){
          phase='get-first-original-build-reconciliation';
          const prior=await reconcileP2RecoveryForward({...providerContext,plan,job:migration.job});
          await store.record('p2-recovery-forward-original.json',prior);
        }
        await fences('recovery-before-runtime');
        // Remote implementation must bind probe to fresh physical session, then
        // verify BOTH API databases current/read-only before restoring10services.
        phase = 'get-only-retained-ready-frontend-observation';
        let observed;
        if(action.frontendMode==='reuse-retained-ready')observed=await adapters.observeCompatibleFrontend({ plan, inventorySha256, checkpoint: 'recovery', recoveryActionId: action.recoveryActionId, ...providerContext, admissionObservation: { newWork: false, recovery: false, active: 0, uncertain: 0 } });
        if(observed)require(observed?.readyState === 'READY' && observed.actionId === plan.actionId && observed.sourceCommit === plan.sourceCommit &&
          observed.aliasJobState === 'succeeded' && observed.aliasDeploymentId === observed.deploymentId && observed.aliasJobDeploymentId === observed.deploymentId &&
          observed.aliasJobMatchesIntent === true && observed.aliasJobType === 'promote' && observed.workloadVerified === true &&
          observed.admissionNewWork === false && observed.admissionRecovery === false && observed.nativeSchedulesEnabled === false &&
          isDeepStrictEqual(observed.featureControls, plan.certification.featureControls));
        phase = 'readonly-api-verification-and-runtime-restoration';
        const runtime = await host.restoreCurrent({ receipt, probe }); await verify();
        require(runtime?.status === 'P2_RECOVERY_API_RUNTIME_READY' && runtime.candidateSha256 === action.candidateSha256 && runtime.recoveryActionId === action.recoveryActionId &&
          runtime.apiDatabases?.course?.status === 'P2_RECOVERY_API_DATABASE_CURRENT' && runtime.apiDatabases.community?.status === 'P2_RECOVERY_API_DATABASE_CURRENT' &&
          runtime.containers?.length === 10 && runtime.sqlReplayed === false);
        await store.record('p2-recovery-api-runtime.json', runtime);
        if(action.frontendMode==='reviewed-new-build'){
          phase='reviewed-new-build';
          const selected=plan.producers.find(row=>row.producerSha256===(plan.runtimeProducerSha256??plan.bootstrapCompatibility?.runtimeProducerSha256)&&row.role.name===migration.job.target.runtimeRole);require(selected);
          const expectedWriterAdmissionBinding={mode:'enforce',targetSha256:plan.targetSha256,producerSha256:selected.producerSha256,sourceCommit:plan.sourceCommit,roleName:migration.job.target.runtimeRole};
          await store.record('p2-recovery-forward-started.json',{...base,status:'P2_RECOVERY_NEW_BUILD_INTENT',reason:action.forwardReason,
            currentDatabaseReceiptSha256:frontendCoordinationHash(readFrontendReleaseEvidence(dependencies.directory,'p2-recovery-current-database.json')),
            apiRuntimeReceiptSha256:frontendCoordinationHash(readFrontendReleaseEvidence(dependencies.directory,'p2-recovery-api-runtime.json')),
            priorReconciliationReceiptSha256:frontendCoordinationHash(readFrontendReleaseEvidence(dependencies.directory,'p2-recovery-forward-original.json')),
            expectedWriterAdmissionBinding,featureControls:plan.certification.featureControls});
          const result=await buildP2RecoveryForward({...providerContext,plan,job:migration.job,verifyMutationScope:()=>verifyP2RecoveryForwardMutation(session)});
          require(result.status==='P2_RECOVERY_NEW_BUILD_VERIFIED');
          providerContext.forwardRecoveryScope=await issueP2RecoveryForwardScope(session,{...providerContext,plan});
          observed=await adapters.observeCompatibleFrontend({plan,inventorySha256,checkpoint:'recovery',...providerContext,admissionObservation:{newWork:false,recovery:false,active:0,uncertain:0}});
        }
        require(observed?.readyState==='READY'&&observed.actionId===plan.actionId&&observed.sourceCommit===plan.sourceCommit&&
          observed.aliasJobState==='succeeded'&&observed.aliasJobMatchesIntent===true&&observed.aliasJobType==='promote'&&
          observed.aliasDeploymentId===observed.deploymentId&&observed.aliasJobDeploymentId===observed.deploymentId&&
          observed.workloadVerified===true&&observed.admissionNewWork===false&&observed.admissionRecovery===false&&
          observed.nativeSchedulesEnabled===false&&isDeepStrictEqual(observed.featureControls,plan.certification.featureControls));
        const actualRuntime=await observeP2RecoveryFrontend({ ...providerContext, plan, job:migration.job });
        require(actualRuntime.deploymentId===observed.deploymentId);await store.record('p2-recovery-frontend-runtime.json',actualRuntime);
        const workload=await readCompatibleFrontendWorkloadReceipt({...providerContext,plan},observed);
        await host.frontendVerified({ ...observed, writerAdmissionBinding:actualRuntime.writerAdmissionBinding, frontendServerWorkloadReverified:true },workload); await verify(); await fences('recovery-after-ready');
        phase = 'deliberate-ordered-admission-restoration';
        const restoration = await restoreFrontendAdmission(plan, client, receipt.admissionEpoch, { verifySession: verify, withOwner: restorationOwner, record: store.record,
          async verifyBoundary(stage, admission) {
            await fences(stage);
            const context = { plan, inventorySha256, stage, checkpoint: 'recovery', admissionObservation: admission, recoveryActionId: action.recoveryActionId, ...providerContext };
            const frontend = await adapters.observeCompatibleFrontend(context);
            require(frontend?.deploymentId === observed.deploymentId && frontend.aliasJobMatchesIntent === true && frontend.aliasJobType === 'promote' &&
              frontend.readyState === 'READY' && frontend.aliasJobState === 'succeeded' && frontend.workloadVerified === true &&
              frontend.workloadReceiptSha256 === observed.workloadReceiptSha256 && frontend.nativeSchedulesEnabled === false &&
              frontend.admissionNewWork === admission.newWork && frontend.admissionRecovery === admission.recovery);
            const actualRuntime=await observeP2RecoveryFrontend({ ...providerContext, plan, job:migration.job });
            require(actualRuntime.deploymentId===observed.deploymentId);
            await host.restoreGatewayStage(stage, admission, frontend); await verify();
            const gateway = await host.observeGateway();
            require(gateway?.status === 'FRONTEND_RESTORATION_GATEWAY_OBSERVED' && gateway.gatewayMutated === false &&
              frontendCoordinationHash(gateway.binding) === plan.restoration.gatewayBindingSha256 &&
              gateway.admission?.newWork === admission.newWork && gateway.admission.recovery === admission.recovery &&
              gateway.admission.uncertain?.newWork === 0 && gateway.admission.uncertain?.recovery === 0);
            await store.record(stage + '-boundary.json', { frontend: Object.fromEntries(Object.entries(frontend).filter(([key]) => !['evidence','evidenceSha256'].includes(key))), gateway });
          } });
        require(restoration.admissionRestored === true); await verify();
        const outcome = { ...base, status: 'P2_STAGING_RECOVERY_RESTORATION_VERIFIED', phase: 'completed', admissionRestored: true, trafficAuthorized: true,
          wholeReleaseAccepted: false, failedBuildForwardAction: action.frontendMode==='reviewed-new-build'?'COMPLETED':'OPEN', sqlReplayed: false };
        await host.prepareClose(verify); return outcome;
      });
      // Session cleanup completed above. Record new verification only; the
      // original terminal remains absent if it was absent at reviewed start.
      await store.record('p2-recovery-outcome.json', completed); await host.finish(completed, verifyEnvironment); return completed;
    });
  } catch {
    let cleanup = { frontendAdmissionClosed: null, gatewayAdmissionClosed: null, runtimeStopped: null };
    try { if (host) cleanup = await host.failClosed(); } catch { /* independent guard retains truthful unknowns */ }
    try { await store.record('p2-recovery-outcome.json', { ...base, status: 'FAILED_REQUIRES_REVIEW', phase, trafficAuthorized: null, ...cleanup }); } catch { /* preserve exclusive prior receipts */ }
    throw new Error('P2_POST_SQL_RECOVERY_FAILED_REQUIRES_REVIEW');
  }
}

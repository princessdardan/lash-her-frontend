// Fixed bounded certification policy. Generic recovery remains closed/drained.
import {Client} from 'pg';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {frontendConnectionOptions,frontendMigrationArtifact,FRONTEND_MIGRATION_LOCK} from './frontend-migration.mjs';
import {readMigrationCatalog} from './frontend-schema.mjs';
import {assertAppliedMigrationLineage} from '../../src/lib/private-db/migration-lineage.ts';
import {verifyRecoveryRuntimeGrants,RECOVERY_HELD_LOCK} from './p2-recovery-current-probe.mjs';
import {decodeQualificationTargetJson,requireQualificationTargetProfile,STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE as currentProfile} from './qualification-target-profile.mjs';

const demand=(ok,checkpoint)=>{if(!ok){const error=new Error('P2_CERTIFICATION_CURRENT_REFUSED');if(checkpoint)error.checkpoint=checkpoint;throw error;}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetHash=target=>hash({environment:'staging',...Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,target[key]]))});
const canonical=value=>JSON.stringify(value,(_key,child)=>child&&typeof child==='object'&&!Array.isArray(child)?Object.fromEntries(Object.entries(child).sort(([a],[b])=>a.localeCompare(b))):child);
const name=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,62}$/u.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)&&!/^0+$/u.test(value);
const action=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
const epoch=value=>typeof value==='string'&&/^[1-9][0-9]{0,17}$/u.test(value);
const oid=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/u.test(value);
const replacementOid=value=>oid(value)&&Number(value)<=4294967295;
const exact=(value,fields)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).length===fields.length&&
  fields.every(key=>{const field=Object.getOwnPropertyDescriptor(value,key);return field?.enumerable&&Object.hasOwn(field,'value');});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const interruptedMode='p2-profiled-known-ack-interrupted-restoration';
const knownAckMode='known-ack-recovery';
const replacementBackendStart=`pg_catalog.to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const replacementStart=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(value);
const replacementProof=replacementRelease=>({replacementRelease,effectiveLoginBoundaryVerified:true,predecessorRuntimeRoleAbsent:true});
const interactiveMode='interactive-browser';
const rotationWriterOperation='writer-scope';
const rotationWriterFlag='--profiled-replacement-rotation-writer-scope';
const rotationGuardFlag='--profiled-replacement-rotation-guard-fence';
const rotationEpochs=6n;
const rotationWriterLimit=32;
const interactiveProducerDigest=plan=>createHash('sha256').update(`lash-her:p2q:interactive-producer:v1\n${plan.sourceCommit}\n${plan.targetSha256}`).digest('hex');
const interactiveWindowEpoch=plan=>(BigInt(plan.initialEpoch)+1n).toString();
const interactiveClosedEpoch=plan=>(BigInt(plan.initialEpoch)+2n).toString();
const bodies={admit:'e8efe70da1fabe4381d640e73bc42b5e204ec5f1aa28589d09b1e73a0be21504',begin_operation:'c634f0f3f018062fb2b115f923ab8637f02a34c515e8532b41ccd912762917d3',current_policy:'1322b30139dcb101aafcbd461536c1788233da1f0ab6e9084745513a4da1694e',finish_operation:'84257c2f6b8be184397e3d326d9908f11a6e9d75facde5c7abb5bad2e9db4e1d',settle:'a6fb927fbc0df4d7262aba5c6185ebffa737d1adafcf5766080078e0d0f45fbd'};
const options=(value,target,interrupted=false)=>({...frontendConnectionOptions(value,target),
  options:'-c search_path=pg_catalog,public'+(interrupted?' -c default_transaction_read_only=on':''),
  application_name:'lash-her-p2-bounded-certification'});

function profileFields(expectedProfile,plan,job,historicalLogins,interrupted=false,replacementRelease){
  demand((plan?.mode===interruptedMode)===interrupted&&(!interrupted||expectedProfile!==undefined),'current-source-context');
  const replacing=replacementRelease!==undefined;
  demand(Object.hasOwn(plan??{},'replacementRelease')===replacing&&(!replacing||expectedProfile!==undefined&&historicalLogins===undefined),
    'current-replacement-context');
  const carriers=[plan,plan?.nativePlan,plan?.nativePlan?.target,job,job?.target,
    ...(replacing?[replacementRelease]:[historicalLogins,historicalLogins?.target])];
  if(expectedProfile===undefined){
    demand(plan?.version===1&&plan.mode!==interactiveMode&&job?.version===1&&!carriers.some(row=>row&&Object.hasOwn(row,'qualificationTargetProfile')));
    return {};
  }
  const qualificationTargetProfile=requireQualificationTargetProfile(currentProfile,{qualificationTargetProfile:expectedProfile},...carriers);
  demand(plan.version===2&&plan.nativePlan.version===2&&job.version===2&&plan.startState==='already-closed'&&Array.isArray(job.target.approvedPendingTags));
  if(replacing)requireReplacementPlan(plan,job,replacementRelease);
  else demand(historicalLogins.version===2&&job.target.approvedPendingTags.length===0);
  if(interrupted)requireInterruptedPlan(plan,job,replacing);
  if(plan.mode===interactiveMode)requireInteractivePlan(plan,job);
  return {qualificationTargetProfile};
}

function requireReplacementPlan(plan,job,replacement){
  const native=plan.nativePlan, owner=native.owner, runtime=native.producer?.role, target=job.target;
  const provenance=['reviewedPlanSha256','runtimeReviewSha256','postflightSha256','frontendSessionClosedSha256','frontendDatabaseReceiptSha256'];
  demand(exact(replacement,['version','kind','qualificationTargetProfile',...provenance,'databaseOid','migrationRoleOid',
    'predecessorRuntimeRole','administrativeLogins'])&&replacement.version===1&&replacement.kind==='frontend-replacement'&&
    isDeepStrictEqual(replacement,plan.replacementRelease)&&provenance.every(key=>digest(replacement[key]))&&
    replacement.reviewedPlanSha256===plan.originalReleasePlanSha256&&digest(plan.originalReleaseReceiptSha256)&&
    plan.environment==='staging'&&job.environment==='staging'&&plan.contractPhase==='p2'&&job.contractPhase==='p2'&&
    plan.originalReleaseId===job.releaseId&&native.actionId===job.releaseId&&action(plan.certificationActionId)&&
    plan.certificationActionId!==job.releaseId&&/^(?!0+$)[a-f0-9]{40}$/u.test(job.sourceCommit??'')&&
    plan.sourceCommit===job.sourceCommit&&plan.sourceCommit===native.sourceCommit&&
    plan.targetSha256===targetHash(target)&&plan.targetSha256===native.targetSha256&&plan.targetSha256===targetHash(native.target)&&
    plan.phase2ContractManifestSha256===job.phase2ContractManifestSha256&&plan.phase2ContractManifestSha256===native.phase2ContractManifestSha256&&
    target.allowEmptyBootstrap===true&&target.approvedPendingTags.length>0&&name(target.user)&&name(target.runtimeRole)&&
    replacementOid(replacement.databaseOid)&&replacementOid(replacement.migrationRoleOid)&&
    exact(owner,['name','oid'])&&name(owner.name)&&replacementOid(owner.oid)&&exact(runtime,['name','oid'])&&
    runtime.name===target.runtimeRole&&replacementOid(runtime.oid)&&digest(native.producer.producerSha256)&&
    name(replacement.predecessorRuntimeRole),'current-replacement-plan');
  if(plan.mode===knownAckMode)demand(exactSuspendWitness(native)&&epoch(plan.initialEpoch)&&
    native.initialEpoch===(BigInt(plan.initialEpoch)+1n).toString()&&
    epoch((BigInt(native.initialEpoch)+2n).toString()),'current-replacement-known-ack-plan');
  const names=[target.user,owner.name,runtime.name,replacement.predecessorRuntimeRole];
  const oids=[replacement.migrationRoleOid,owner.oid,runtime.oid];
  const admins=replacement.administrativeLogins;
  demand(Array.isArray(admins)&&admins.length<=32&&admins.every((login,index)=>exact(login,['name','oid'])&&
    name(login.name)&&replacementOid(login.oid)&&(index===0||admins[index-1].name<login.name))&&
    new Set([...names,...admins.map(login=>login.name)]).size===names.length+admins.length&&
    new Set([...oids,...admins.map(login=>login.oid)]).size===oids.length+admins.length,'current-replacement-logins');
}

function requireReplacementArtifact(job,artifact,baseline){
  demand(isDeepStrictEqual(job.target.approvedPendingTags,artifact.migrations.map(({tag})=>tag))&&
    artifact.sqlArtifactSha256===job.sqlArtifactSha256&&artifact.contractManifestSha256===job.contractManifestSha256&&
    artifact.contractPhase==='p2'&&artifact.phase2ContractManifestSha256===job.phase2ContractManifestSha256&&
    baseline.version===1&&baseline.serverMajor===job.target.serverMajor&&baseline.sqlArtifactSha256===job.sqlArtifactSha256&&
    hash(baseline)===job.schemaBaselineSha256,'current-replacement-artifact');
}

async function verifyReplacementIdentity(client,target,replacement){
  const {rows:[identity]}=await client.query(`SELECT datid::text AS database_oid,usesysid::text AS migration_role_oid,
    current_user AS role,session_user AS login,pg_catalog.current_database() AS database,
    pg_catalog.current_setting('server_version_num')::int/10000 AS major
    FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`);
  demand(identity?.database_oid===replacement.databaseOid&&identity.migration_role_oid===replacement.migrationRoleOid&&
    identity.role===target.user&&identity.login===target.user&&identity.database===target.database&&identity.major===target.serverMajor,
    'current-replacement-database-identity');
}

async function verifyReplacementLogins(client,target,replacement,runtime,owner){
  const {verifyReplacementLoginBoundary}=await import('./p2-frontend-replacement-written.mjs');
  await verifyReplacementLoginBoundary(client,{...replacement,migrationRole:target.user,runtime,target,owner});
  await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const allowed=[replacement.migrationRoleOid,runtime.oid,...replacement.administrativeLogins.map(login=>login.oid)];
  const {rows}=await client.query(`SELECT 1 FROM pg_catalog.pg_stat_activity
    WHERE datid=$1::oid AND backend_type='client backend' AND (usesysid IS NULL OR usesysid<>ALL($2::oid[])) LIMIT 1`,
  [replacement.databaseOid,allowed]);
  demand(rows.length===0,'current-replacement-unapproved-session');
}

function requireInteractivePlan(plan,job){
  const native=plan.nativePlan;
  demand(plan.environment==='staging'&&job.environment==='staging'&&plan.contractPhase==='p2'&&job.contractPhase==='p2'&&
    plan.originalReleaseId===job.releaseId&&native.actionId===job.releaseId&&action(plan.certificationActionId)&&
    plan.certificationActionId!==job.releaseId&&/^[a-f0-9]{40}$/u.test(plan.sourceCommit??'')&&!/^0+$/u.test(plan.sourceCommit)&&
    plan.sourceCommit===job.sourceCommit&&plan.sourceCommit===plan.operatorSourceCommit&&plan.sourceCommit===native.sourceCommit&&
    plan.targetSha256===native.targetSha256&&plan.targetSha256===targetHash(job.target)&&plan.targetSha256===targetHash(native.target)&&
    plan.phase2ContractManifestSha256===job.phase2ContractManifestSha256&&plan.phase2ContractManifestSha256===native.phase2ContractManifestSha256&&
    epoch(plan.initialEpoch)&&epoch(interactiveClosedEpoch(plan))&&native.initialEpoch===plan.initialEpoch&&
    native.purpose==='scoped-certification-control-only'&&Array.isArray(native.commandWitnesses)&&native.commandWitnesses.length===0&&
    name(job.target.runtimeRole)&&native.producer?.role?.name===job.target.runtimeRole&&oid(native.producer.role.oid)&&
    digest(native.producer.producerSha256), 'current-interactive-plan');
}

function exactSuspendWitness(native){
  const command=native.commandWitnesses?.[0];
  return Array.isArray(native.commandWitnesses)&&native.commandWitnesses.length===1&&
    command?.action==='suspend'&&uuid(command.commandId)&&epoch(command.accountVersion);
}

function requireInterruptedPlan(plan,job,replacing){
  const original=plan.nativePlan;
  demand(plan.environment==='staging'&&job.environment==='staging'&&plan.originalReleaseId===job.releaseId&&original.actionId===job.releaseId&&
    [plan.certificationActionId,plan.originalCertificationActionId,job.releaseId].every(action)&&
    new Set([plan.certificationActionId,plan.originalCertificationActionId,job.releaseId]).size===3&&
    typeof plan.sourceCommit==='string'&&/^[a-f0-9]{40}$/u.test(plan.sourceCommit)&&!/^0+$/u.test(plan.sourceCommit)&&
    plan.sourceCommit===job.sourceCommit&&plan.sourceCommit===original.sourceCommit&&plan.targetSha256===original.targetSha256&&
    plan.targetSha256===targetHash(job.target)&&plan.targetSha256===targetHash(original.target)&&job.target.allowEmptyBootstrap===replacing&&
    plan.contractPhase===job.contractPhase&&plan.contractPhase==='p2'&&
    plan.phase2ContractManifestSha256===job.phase2ContractManifestSha256&&plan.phase2ContractManifestSha256===original.phase2ContractManifestSha256&&
    typeof plan.phase2ContractManifestSha256==='string'&&plan.phase2ContractManifestSha256.startsWith('sha256:')&&digest(plan.phase2ContractManifestSha256.slice(7))&&
    [plan.candidateSha256,plan.configurationCanonicalSha256,plan.planSha256,plan.reconciliationSha256,original.planSha256].every(digest)&&
    epoch(plan.initialEpoch)&&epoch(original.initialEpoch)&&BigInt(plan.initialEpoch)===BigInt(original.initialEpoch)+2n&&
    name(original.owner?.name)&&oid(original.owner.oid)&&name(original.producer?.role?.name)&&oid(original.producer.role.oid)&&
    digest(original.producer.producerSha256)&&
    uuid(plan.operationId)&&exactSuspendWitness(original),
    'current-interrupted-plan');
}

function admissionPolicy(plan,value,initial,interrupted){
  if(interrupted){
    demand(value.epoch===plan.initialEpoch&&value.newWork===false&&value.recovery===false&&value.active===0&&value.uncertain===0,
      'current-interrupted-closed');
    return;
  }
  demand(['auth-preparation','browser-pending','direct-worker','native-window','fault-before-upstream','fault-drop-after-ack','known-ack-recovery','contain-native','export-cleanup','mux-callback-recovery','mux-readiness','mux-replacement-evidence','lifecycle-persistence',interactiveMode].includes(plan.mode)&&
    ['qualified-ready','already-closed'].includes(plan.startState)&&/^[1-9][0-9]{0,17}$/u.test(plan.initialEpoch)&&/^[1-9][0-9]{0,17}$/u.test(value.epoch)&&
    typeof value.newWork==='boolean'&&typeof value.recovery==='boolean'&&
    Number.isInteger(value.active)&&value.active>=0&&Number.isInteger(value.uncertain)&&value.uncertain>=0);
  if(plan.mode==='contain-native')return;
  const closedOffset=plan.startState==='qualified-ready'?1n:0n,delta=BigInt(value.epoch)-BigInt(plan.initialEpoch);
  if(plan.mode===interactiveMode){
    demand(delta>=0n&&delta<=2n&&value.newWork===(delta===1n)&&value.recovery===(delta===1n)&&
      (!initial||delta===0n)&&(delta!==0n||value.active===0&&value.uncertain===0));
    return;
  }
  if(['export-cleanup','mux-callback-recovery','mux-readiness','mux-replacement-evidence','lifecycle-persistence'].includes(plan.mode)){
    const cleanup=plan.mode==='export-cleanup';
    demand(plan.version===2&&plan.startState==='already-closed'&&plan.nativePlan.purpose==='scoped-certification-control-only'&&
      plan.nativePlan.initialEpoch===plan.initialEpoch&&delta>=0n&&delta<=(cleanup?2n:0n)&&value.newWork===false&&
      value.recovery===(cleanup&&delta===1n)&&value.uncertain===0);
    if(initial||!cleanup)demand(delta===0n&&value.active===0);
    return;
  }
  if(['auth-preparation','browser-pending'].includes(plan.mode)){
    demand(delta>=0n&&delta<=2n&&value.uncertain===0&&value.newWork===(delta===1n||delta===0n&&closedOffset===1n)&&value.recovery===(delta===0n&&closedOffset===1n));
    if(initial)demand(delta===0n&&(closedOffset===1n||value.active===0));return;
  }
  if(plan.mode==='direct-worker'){
    demand(plan.startState==='already-closed'&&plan.nativePlan.initialEpoch===(BigInt(plan.initialEpoch)+1n).toString()&&
      delta>=0n&&delta<=2n&&value.newWork===false&&value.recovery===(delta===1n)&&value.uncertain===0);
    if(initial)demand(delta===0n&&value.active===0);return;
  }
  demand(plan.nativePlan.initialEpoch===(BigInt(plan.initialEpoch)+closedOffset+1n).toString());
  if(initial)demand(delta===0n&&value.newWork===(closedOffset===1n)&&value.recovery===(closedOffset===1n)&&value.uncertain===0&&(closedOffset===1n||value.active===0));
  else{
    demand(delta>=0n&&delta<=closedOffset+3n&&value.newWork===(closedOffset===1n&&delta===0n)&&
      value.recovery===(closedOffset===1n&&delta===0n||delta===closedOffset+1n||delta===closedOffset+2n));
    demand(['fault-drop-after-ack','known-ack-recovery'].includes(plan.mode)?value.uncertain<=1:value.uncertain===0);
  }
}

async function observeInteractiveProducers(client,plan,ordinary,runtime,admission){
  const producerSha256=interactiveProducerDigest(plan);
  const enabled=admission.epoch===interactiveWindowEpoch(plan);
  const ordinaryBindings=new Map(ordinary.map(row=>[row.producerSha256,row.role.oid]));
  demand(isDeepStrictEqual(runtime,plan.nativePlan.producer.role)&&ordinaryBindings.size===ordinary.length&&
    ordinaryBindings.get(plan.nativePlan.producer.producerSha256)===runtime.oid&&!ordinaryBindings.has(producerSha256));
  const rows=(await client.query(`SELECT producer_sha256,source_sha,database_role::text AS role_oid,enabled
    FROM frontend_admission.producers WHERE enabled OR producer_sha256=ANY($1::text[]) LIMIT 258`,
  [[...ordinaryBindings.keys(),producerSha256]])).rows;
  const selected=rows.find(row=>row.producer_sha256===producerSha256);
  demand((selected||admission.epoch===plan.initialEpoch)&&rows.length===ordinary.length+(selected?1:0)&&rows.every(row=>
    row.source_sha===plan.sourceCommit&&(row===selected
      ? row.enabled===enabled&&row.role_oid===runtime.oid
      : row.enabled===!enabled&&row.role_oid===ordinaryBindings.get(row.producer_sha256))));
  return {producerSha256,roleOid:runtime.oid};
}

function requireInteractiveOperations(plan,admission,operations,interactive){
  demand((admission.epoch!==plan.initialEpoch||operations.length===0)&&operations.every(row=>
    uuid(row.id)&&row.epoch===interactiveWindowEpoch(plan)&&row.source_sha===plan.sourceCommit&&
    row.producer_sha256===interactive.producerSha256&&row.role_oid===interactive.roleOid&&
    ['new-work','recovery'].includes(row.kind)&&['active','uncertain','completed'].includes(row.state)&&
    (row.state==='completed'?row.completed_at instanceof Date&&Number.isFinite(+row.completed_at):row.completed_at===null)&&
    (row.reconciliation_sha256===null||row.state==='completed'&&digest(row.reconciliation_sha256)))&&
    operations.filter(row=>row.state==='active').length===admission.active&&
    operations.filter(row=>row.state==='uncertain').length===admission.uncertain);
}

function requireRotationFrontendPlan(input){
  const {plan,job:{target}}=input;
  const native=plan.nativePlan;
  demand(typeof target.host==='string'&&/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(target.host)&&!/pooler|pgbouncer/u.test(target.host)&&
    name(target.database)&&Number.isSafeInteger(target.port)&&target.port>0&&target.port<65536&&[16,18].includes(target.serverMajor),
    'current-rotation-writer-target');
  demand(plan.mode==='contain-native'&&epoch(plan.initialEpoch)&&
    digest(plan.candidateSha256)&&digest(plan.planSha256)&&native.initialEpoch===plan.initialEpoch&&
    Array.isArray(native.commandWitnesses)&&native.commandWitnesses.length===0&&native.providerQueuedInventory===null&&
    ['automaticReplayAllowed','migrationAuthorized','wholeReleaseAccepted'].every(key=>native[key]===false)&&
    exact(native.producer,['producerSha256','role']),'current-rotation-frontend-plan');
}

function requireRotationWriterRequest(input){
  requireRotationFrontendPlan(input);
  const {plan,writerScope}=input;
  demand(input.operation===rotationWriterOperation&&exact(writerScope,['operationEpoch','operationRegistry'])&&
    epoch(writerScope.operationEpoch)&&BigInt(writerScope.operationEpoch)>=BigInt(plan.initialEpoch)&&
    ['ordinary','interactive'].includes(writerScope.operationRegistry),
    'current-rotation-writer-request');
}

async function readRotationRegistry(client,plan,runtime,currentEpoch){
  const ordinary=plan.nativePlan.producer.producerSha256,interactive=interactiveProducerDigest(plan);
  const {rows}=await client.query(`SELECT p.producer_sha256,p.source_sha,p.database_role::text AS role_oid,
    p.enabled,r.rolname,r.rolcanlogin
    FROM frontend_admission.producers p LEFT JOIN pg_catalog.pg_roles r ON r.oid=p.database_role
    WHERE p.enabled OR p.producer_sha256=ANY($1::text[]) ORDER BY p.producer_sha256 LIMIT 3`,[[ordinary,interactive]]);
  const seen=new Set(rows.map(row=>row.producer_sha256));
  const enabled=rows.filter(row=>row.enabled===true);
  demand(ordinary!==interactive&&seen.size===rows.length&&seen.has(ordinary)&&enabled.length===1&&
    (currentEpoch===plan.initialEpoch||seen.has(interactive))&&rows.every(row=>
      [ordinary,interactive].includes(row.producer_sha256)&&row.source_sha===plan.sourceCommit&&
      row.role_oid===runtime.oid&&row.rolname===runtime.name&&row.rolcanlogin===true&&typeof row.enabled==='boolean'),
    'current-rotation-writer-registry');
  const producerSha256=enabled[0].producer_sha256;
  const producers=[{producerSha256,role:{name:runtime.name,oid:runtime.oid}}];
  return {kind:producerSha256===ordinary?'ordinary':'interactive',ordinary,interactive,producers,registrySha256:hash(producers)};
}

async function readRotationWriterScope(client,plan,runtime,admission,writerScope){
  const {operationEpoch,operationRegistry}=writerScope;
  const currentEpoch=admission.epoch;
  demand(epoch(currentEpoch)&&BigInt(currentEpoch)>=BigInt(plan.initialEpoch)&&
    typeof admission.newWork==='boolean'&&admission.newWork===admission.recovery&&
    ['active','uncertain'].every(key=>Number.isInteger(admission[key])&&admission[key]>=0),
    'current-rotation-writer-admission');
  const currentRegistry=admission.newWork?'interactive':'ordinary';
  const delta=BigInt(operationEpoch)-BigInt(currentEpoch);
  demand(delta===0n?operationRegistry===currentRegistry:
    (delta===1n||delta===-1n)&&currentRegistry==='ordinary'&&operationRegistry==='interactive',
    'current-rotation-writer-epoch');

  const registry=await readRotationRegistry(client,plan,runtime,currentEpoch);
  demand(registry.kind===currentRegistry,'current-rotation-writer-registry');

  const {rows:operations}=await client.query(`SELECT id::text,epoch::text,kind,state,producer_sha256,source_sha,
    database_role::text AS role_oid,completed_at,reconciliation_sha256 FROM frontend_admission.operations
    WHERE epoch=$1::bigint ORDER BY started_at,id LIMIT $2`,[operationEpoch,rotationWriterLimit+1]);
  const operationProducer=registry[operationRegistry];
  const expectedCounts=delta===1n||delta===0n&&currentRegistry==='ordinary'?{active:0,uncertain:0}:admission;
  demand(operations.length<=rotationWriterLimit&&(delta!==1n||operations.length===0)&&
    operations.every(row=>uuid(row.id)&&row.epoch===operationEpoch&&row.producer_sha256===operationProducer&&
      row.source_sha===plan.sourceCommit&&row.role_oid===runtime.oid&&['new-work','recovery'].includes(row.kind)&&
      ['active','uncertain','completed'].includes(row.state)&&
      (row.state==='completed'?row.completed_at instanceof Date&&Number.isFinite(+row.completed_at):row.completed_at===null)&&
      (row.reconciliation_sha256===null||row.state==='completed'&&digest(row.reconciliation_sha256)))&&
    ['active','uncertain'].every(key=>admission[key]===expectedCounts[key]&&
      operations.filter(row=>row.state===key).length===expectedCounts[key]),
    'current-rotation-writer-operations');
  return {currentEpoch,operationEpoch,currentRegistry,operationRegistry,operations,producers:registry.producers,registrySha256:registry.registrySha256};
}

export function readP2CertificationCurrent(client,prepared,plan,verify,initial=false,expectedProfile){
  return readCurrent(client,prepared,plan,verify,initial,expectedProfile,false);
}

function verifyReplacementKnownAckOperations(plan,admission,operations){
  const native=plan.nativePlan,windowEpoch=(BigInt(native.initialEpoch)+1n).toString();
  const settlements=operations.filter(row=>row.reconciliation_sha256!==null);
  demand(operations.length<=2&&(BigInt(admission.epoch)>=BigInt(windowEpoch)||operations.length===0)&&
    operations.every(row=>uuid(row.id)&&row.epoch===windowEpoch&&row.kind==='recovery'&&
    row.source_sha===plan.sourceCommit&&row.producer_sha256===native.producer.producerSha256&&row.role_oid===native.producer.role.oid&&
    (row.state==='completed'?row.completed_at instanceof Date&&Number.isFinite(+row.completed_at):
      ['active','uncertain'].includes(row.state)&&row.completed_at===null)&&
    (row.reconciliation_sha256===null||row.state==='completed'&&digest(row.reconciliation_sha256)))&&
    admission.active<=1&&admission.uncertain<=1&&
    operations.filter(row=>row.state==='active').length===admission.active&&operations.filter(row=>row.state==='uncertain').length===admission.uncertain&&
    (settlements.length===0||settlements.length===1&&admission.epoch===(BigInt(native.initialEpoch)+2n).toString()&&
      !admission.newWork&&!admission.recovery&&admission.active===0&&admission.uncertain===0&&operations.length===2),
    'current-replacement-known-ack-operations');
  return settlements.length===1;
}

function verifyReplacementKnownAckClosure(plan,current){
  const {admission,witness}=current;
  demand(admission.epoch===(BigInt(plan.nativePlan.initialEpoch)+2n).toString()&&
    witness.operations.length===2&&witness.operations.every(row=>row.state==='completed')&&
    witness.operations.filter(row=>digest(row.reconciliation_sha256)).length===1&&witness.orderViolations.length===0,
    'current-replacement-known-ack-closure');
}

function requireAcknowledgedDeliveries(deliveries,checkpoint){
  demand(deliveries.length===2&&deliveries.every(row=>row.status==='acknowledged'&&row.acknowledged_at instanceof Date&&
    Number.isFinite(+row.acknowledged_at)&&Number.isInteger(row.attempts)&&row.attempts>0&&row.lease_until===null&&row.lease_id===null),
    checkpoint);
}

async function readCurrent(client,prepared,plan,verify,initial,expectedProfile,interrupted,writerScope){
  const {job,artifact,baseline}=prepared.migration,target=job.target,owner=prepared.plan.owner;
  const {historicalLogins,replacementRelease}=prepared.plan;
  const replacementKnownAck=replacementRelease&&plan.mode===knownAckMode;
  const selectedProfile=profileFields(expectedProfile,plan,job,historicalLogins,interrupted,replacementRelease);
  if(replacementRelease)requireReplacementArtifact(job,artifact,baseline);
  demand(name(owner.name)&&plan.sourceCommit===job.sourceCommit&&plan.targetSha256===prepared.plan.targetSha256&&plan.targetSha256===targetHash(target)&&
    artifact.sqlArtifactSha256===job.sqlArtifactSha256&&artifact.contractManifestSha256===job.contractManifestSha256,'current-target');await verify();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let checkpoint='current-transaction';
  try{
    demand((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only==='on');
    checkpoint='current-lineage-schema';
    if(replacementRelease){
      await verifyReplacementIdentity(client,target,replacementRelease);
      const {verifyReplacementJournalTable}=await import('./p2-frontend-replacement-written.mjs');
      await verifyReplacementJournalTable(client,replacementRelease.migrationRoleOid);
    }
    const journalSql='SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC';
    const after=(await (replacementRelease?client.query(journalSql+' LIMIT $1',[artifact.migrations.length+1]):client.query(journalSql))).rows;
    demand(after.length===artifact.migrations.length&&assertAppliedMigrationLineage(artifact.expected,after)===artifact.migrations.at(-1).folderMillis&&
      isDeepStrictEqual(await readMigrationCatalog(client),baseline.catalog));
    checkpoint='current-runtime';
    const verifyRuntime=replacementRelease?(await import('./p2-recovery-current-probe.mjs')).verifyReplacementRuntimeGrants:verifyRecoveryRuntimeGrants;
    const runtime=await verifyRuntime(client,target,owner);
    demand(prepared.plan.producers.some(row=>row.role.name===runtime.name&&row.role.oid===runtime.oid));
    if(interrupted||replacementRelease)demand(isDeepStrictEqual(owner,plan.nativePlan.owner)&&isDeepStrictEqual(runtime,plan.nativePlan.producer.role));
    if(replacementRelease)demand(prepared.plan.producers.length===1&&isDeepStrictEqual(prepared.plan.producers[0],plan.nativePlan.producer));
    checkpoint='current-owner';const owners=(await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname=$1',[owner.name])).rows;
    demand(owners.length===1&&owners[0].oid===owner.oid&&owners[0].rolconfig===null&&owners[0].rolconnlimit===-1&&owners[0].rolvaliduntil===null&&
      ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>owners[0][key]===false));
    let loginProof;
    if(replacementRelease){
      checkpoint='current-replacement-logins';
      await verifyReplacementLogins(client,target,replacementRelease,runtime,owner);
      const {verifyReplacementAdmissionRelations}=await import('./p2-frontend-replacement-written.mjs');
      await verifyReplacementAdmissionRelations(client,owner.oid);
      loginProof=replacementProof(replacementRelease);
    }else{
      checkpoint='current-retired';const retired=historicalLogins.retiredLogins;
      const logins=(await client.query('SELECT oid::text,rolname,rolcanlogin FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname',[retired.map(row=>row.name)])).rows;
      demand(logins.length===retired.length&&logins.every(row=>row.rolcanlogin===false&&retired.some(expected=>expected.oid===row.oid&&expected.name===row.rolname)));
      await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
      demand((await client.query('SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE usesysid=ANY($1::oid[])',[retired.map(row=>row.oid)])).rows[0].count===0);
      loginProof={retiredLogins:retired,oldLoginsDenied:true,oldRoleSessions:0};
    }
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===owner.oid);
    checkpoint='current-admission-routines';const routines=(await client.query(`SELECT p.proname,p.prosecdef,p.proowner::text AS owner,p.proconfig,p.prosrc,p.prokind,
      EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p WHERE p.pronamespace='frontend_admission'::regnamespace ORDER BY p.proname`)).rows;
    demand(routines.length===5&&routines.every(row=>bodies[row.proname]===createHash('sha256').update(row.prosrc).digest('hex')&&row.owner===owner.oid&&row.public_execute===false&&
      (['begin_operation','finish_operation'].includes(row.proname)?row.prokind==='p'&&!row.prosecdef&&row.proconfig===null:row.prokind==='f'&&row.prosecdef&&isDeepStrictEqual(row.proconfig,['search_path=pg_catalog, frontend_admission']))));
    const controls=(await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton')).rows;
    const counts=(await client.query("SELECT count(*) FILTER(WHERE state='active')::int AS active,count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations")).rows[0];
    demand(controls.length===1&&controls[0].environment==='staging'&&controls[0].target_sha256===plan.targetSha256);
    checkpoint='current-admission-state';
    const admission={epoch:controls[0].epoch,newWork:controls[0].new_work,recovery:controls[0].recovery,...counts};
    if(writerScope)return {environment:'staging',releaseId:job.releaseId,targetSha256:plan.targetSha256,admission,journalSha256:hash(after),
      writerScope:await readRotationWriterScope(client,plan,runtime,admission,writerScope)};
    admissionPolicy(plan,admission,initial,interrupted);
    if(replacementRelease&&initial)demand(isDeepStrictEqual(admission,{epoch:plan.initialEpoch,newWork:false,recovery:false,active:0,uncertain:0}));
    let interactive;
    if(plan.mode===interactiveMode){
      checkpoint='current-interactive-producers';
      interactive=await observeInteractiveProducers(client,plan,prepared.plan.producers,runtime,admission);
    }else{
      checkpoint='current-producers';
      const producers=(await client.query('SELECT producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.producers WHERE enabled ORDER BY producer_sha256')).rows;
      demand(producers.length===prepared.plan.producers.length&&producers.every((row,index)=>row.producer_sha256===prepared.plan.producers[index].producerSha256&&row.source_sha===job.sourceCommit&&row.role_oid===prepared.plan.producers[index].role.oid));
      checkpoint='current-admission-state';
      const unresolved=(await client.query("SELECT id::text,epoch::text,kind,producer_sha256,source_sha,database_role::text AS role_oid FROM frontend_admission.operations WHERE state<>'completed' ORDER BY id LIMIT 4097")).rows;
      if(interrupted)demand(unresolved.length===0,'current-interrupted-closed');
      const preNative=BigInt(admission.epoch)<=BigInt(plan.initialEpoch)+(plan.startState==='qualified-ready'?1n:0n);
      demand(unresolved.length<=4096&&(plan.mode==='contain-native'||unresolved.every(row=>row.source_sha===plan.sourceCommit&&
        (['auth-preparation','browser-pending'].includes(plan.mode)?prepared.plan.producers.some(producer=>producer.producerSha256===row.producer_sha256&&producer.role.oid===row.role_oid)&&
          BigInt(row.epoch)<=BigInt(plan.initialEpoch)+1n:
        (preNative?prepared.plan.producers.some(producer=>producer.producerSha256===row.producer_sha256&&producer.role.oid===row.role_oid)&&BigInt(row.epoch)<=BigInt(plan.initialEpoch):
          row.kind==='recovery'&&row.producer_sha256===plan.nativePlan.producer.producerSha256&&row.role_oid===plan.nativePlan.producer.role.oid&&
          BigInt(row.epoch)>=BigInt(plan.nativePlan.initialEpoch)&&BigInt(row.epoch)<=BigInt(plan.nativePlan.initialEpoch)+1n)))));
    }
    checkpoint='current-command-witness';demand(name(target.user));await client.query(`SET LOCAL ROLE "${target.user}"`);
    const nativePlan=plan.nativePlan,ids=nativePlan.commandWitnesses.map(row=>row.commandId);
    const commandRows=(await client.query('SELECT command_id::text,user_id::text,account_version::text,action,issued_at,command FROM public.customer_account_commands WHERE command_id=ANY($1::uuid[]) ORDER BY command_id',[ids])).rows;
    const commands=commandRows.map(row=>({commandId:row.command_id,accountVersion:row.account_version,action:row.action,issuedAt:new Date(row.issued_at).toISOString(),canonicalSha256:createHash('sha256').update(canonical(row.command)).digest('hex')}));
    demand(commands.length===ids.length&&commands.every(row=>nativePlan.commandWitnesses.some(expected=>expected.commandId===row.commandId&&expected.accountVersion===row.accountVersion&&expected.action===row.action)));
    const deliveries=(await client.query(`SELECT command_id::text,receiver,status,attempts,acknowledged_at,lease_until${interrupted||replacementKnownAck?',lease_id::text':''}
      FROM public.customer_account_deliveries WHERE command_id=ANY($1::uuid[]) ORDER BY command_id,receiver`,[ids])).rows;
    demand(deliveries.length===commands.length*2&&commands.every(command=>['course','community'].every(receiver=>deliveries.filter(row=>row.command_id===command.commandId&&row.receiver===receiver).length===1)));
    if(interrupted)requireAcknowledgedDeliveries(deliveries,'current-interrupted-deliveries');
    const orderViolations=(await client.query(`SELECT later.command_id::text AS later_command_id,prior.command_id::text AS prior_command_id,d.receiver
      FROM public.customer_account_commands later JOIN public.customer_account_deliveries d ON d.command_id=later.command_id
      JOIN public.customer_account_commands prior ON prior.user_id=later.user_id AND prior.account_version<later.account_version
      LEFT JOIN public.customer_account_deliveries pd ON pd.command_id=prior.command_id AND pd.receiver=d.receiver
      WHERE later.command_id=ANY($1::uuid[]) AND d.status='acknowledged' AND (pd.status IS DISTINCT FROM 'acknowledged' OR pd.acknowledged_at IS NULL OR pd.acknowledged_at>d.acknowledged_at) LIMIT 4097`,[ids])).rows;
    demand(orderViolations.length<=4096);await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const operations=(await client.query(`SELECT id::text,epoch::text,kind,state,producer_sha256,source_sha,database_role::text AS role_oid,completed_at,reconciliation_sha256
      FROM frontend_admission.operations WHERE epoch >= $1::bigint ORDER BY started_at,id LIMIT 4097`,[(BigInt(nativePlan.initialEpoch)+(plan.mode==='direct-worker'?0n:1n)).toString()])).rows;
    demand(operations.length<=4096);
    if(interactive){
      checkpoint='current-interactive-operations';
      requireInteractiveOperations(plan,admission,operations,interactive);
    }
    if(replacementKnownAck&&verifyReplacementKnownAckOperations(plan,admission,operations)){
      requireAcknowledgedDeliveries(deliveries,'current-replacement-known-ack-deliveries');
      demand(orderViolations.length===0,'current-replacement-known-ack-deliveries');
    }
    if(interrupted||replacementKnownAck)for(const row of deliveries)delete row.lease_id;
    if(interrupted){
      const selected=operations.find(row=>row.id===plan.operationId), windowEpoch=(BigInt(nativePlan.initialEpoch)+1n).toString();
      demand(operations.length===2&&selected?.reconciliation_sha256===plan.reconciliationSha256&&orderViolations.length===0&&
        operations.every(row=>row.state==='completed'&&row.completed_at instanceof Date&&Number.isFinite(+row.completed_at)&&
          row.kind==='recovery'&&row.epoch===windowEpoch&&row.source_sha===plan.sourceCommit&&
          row.producer_sha256===nativePlan.producer.producerSha256&&row.role_oid===nativePlan.producer.role.oid&&
          (row===selected||row.reconciliation_sha256===null)),'current-interrupted-settlement');
    }
    const witness={commands,deliveries,orderViolations,operations};
    return{version:plan.version,...selectedProfile,status:'P2_CERTIFICATION_DATABASE_CURRENT',service:'frontend',environment:'staging',releaseId:job.releaseId,certificationActionId:plan.certificationActionId,
      sourceCommit:job.sourceCommit,candidateSha256:plan.candidateSha256,targetSha256:plan.targetSha256,planSha256:plan.planSha256,
      ...Object.fromEntries(['migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256','contractPhase','phase2ContractManifestSha256'].map(key=>[key,job[key]])),
      target:{...Object.fromEntries(['host','port','database','user','serverMajor'].map(key=>[key,target[key]])),...selectedProfile},after,journalSha256:hash(after),schemaVerified:true,runtimeRoleVerified:true,
      owner,runtime,...loginProof,admission,witness,witnessSha256:hash(witness),sqlReplayed:false,trafficAuthorized:false};
  }catch(error){if(!error.checkpoint)error.checkpoint=checkpoint;throw error;}finally{await client.query('ROLLBACK');}
}

export function withP2CertificationFrontendSession(prepared,plan,dependencies,task,expectedProfile){
  return withCertificationSession(prepared,plan,dependencies,task,expectedProfile,false);
}

export function withP2ProfiledInterruptedFrontendSession(prepared,frontendPlan,dependencies,task){
  return withCertificationSession(prepared,frontendPlan,dependencies,task,currentProfile,true);
}

async function withCertificationSession(prepared,plan,{getUrl,verifyEnvironment},task,expectedProfile,interrupted){
  const job=prepared.migration.job, target=job.target;
  const {historicalLogins,replacementRelease}=prepared.plan;
  const selectedProfile=profileFields(expectedProfile,plan,job,historicalLogins,interrupted,replacementRelease);
  if(replacementRelease)requireReplacementArtifact(job,prepared.migration.artifact,prepared.migration.baseline);
  const client=new Client(options(await getUrl(),target,interrupted));let lost=false,locked=false,identity,marker;
  client.on('error',()=>{lost=true;});
  const verify=async()=>{
    await verifyEnvironment();demand(!lost&&client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const actual=(await client.query("SELECT pg_catalog.pg_backend_pid() AS pid,current_user AS username,session_user AS session_username,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(actual.username===target.user&&actual.session_username===target.user&&actual.database===target.database&&actual.major===target.serverMajor&&(!identity||identity.pid===actual.pid));identity=actual;
    if(interrupted)await requireReadOnlySession(client);
    if(replacementRelease)await verifyReplacementIdentity(client,target,replacementRelease);
    if(locked)demand((await client.query(RECOVERY_HELD_LOCK,[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true);
    if(marker)demand((await client.query(RECOVERY_HELD_LOCK,[marker])).rows[0]?.held===true);
  };
  try{
    await client.connect();await verify();locked=(await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS locked',[FRONTEND_MIGRATION_LOCK])).rows[0]?.locked===true;demand(locked);
    marker=randomBytes(32).toString('hex');
    if(replacementRelease){
      const {rows:[nonce]}=await client.query(`SELECT CASE WHEN pg_catalog.hashtext($1)<>pg_catalog.hashtext($2)
        THEN pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) ELSE false END AS locked`,[marker,FRONTEND_MIGRATION_LOCK]);
      demand(nonce?.locked===true,'current-replacement-nonce-lock');
    }else await client.query('SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))',[marker]);
    const backendStart=(await client.query(`SELECT ${replacementRelease?replacementBackendStart:'backend_start::text'} AS backend_start
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()`)).rows[0]?.backend_start;
    demand(replacementRelease?replacementStart(backendStart):typeof backendStart==='string');
    const receipt=await readCurrent(client,prepared,plan,verify,true,expectedProfile,interrupted);
    const probe={version:plan.version,...selectedProfile,marker,backendPid:identity.pid,backendStart,job:prepared.migration.job,baseline:prepared.migration.baseline,
      owner:prepared.plan.owner,producers:prepared.plan.producers,...(replacementRelease?{replacementRelease}:{historicalLogins}),plan,receipt};
    let result;
    if(interrupted){
      const {journalSha256,witnessSha256}=receipt;
      let active=true;
      const readback=async()=>{
        demand(active,'current-interrupted-session-closed');
        const current=await readCurrent(client,prepared,plan,verify,false,currentProfile,true);
        await verify();
        demand(current.journalSha256===journalSha256&&current.witnessSha256===witnessSha256,'current-interrupted-witness-changed');
        return current;
      };
      try{result=await task({verify,receipt,probe,readCurrent:readback});}finally{active=false;}
    }else result=await task({client,verify,receipt,probe});
    await verify();return result;
  }catch(error){const failure=new Error('P2_CERTIFICATION_PHYSICAL_SESSION_FAILED');if(typeof error?.checkpoint==='string'&&/^[a-z-]{1,80}$/u.test(error.checkpoint))failure.checkpoint=error.checkpoint;throw failure;}
  finally{try{if(locked)await client.query('SELECT pg_catalog.pg_advisory_unlock_all()');}catch{lost=true;}try{await client.end();}catch{lost=true;}if(lost)throw new Error('P2_CERTIFICATION_PHYSICAL_CLEANUP_UNCERTAIN');}
}

async function requireReadOnlySession(client){
  demand((await client.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only==='on',
    'current-interrupted-read-only');
}

export function observeP2CertificationPhysical(input,dependencies,expectedProfile){
  return observeCertificationPhysical(input,dependencies,expectedProfile,false);
}

export function observeP2ProfiledInterruptedFrontendPhysical(input,dependencies){
  return observeCertificationPhysical(input,dependencies,currentProfile,true);
}

export function observeP2ProfiledReplacementFrontendPhysical(input,dependencies){
  return observeCertificationPhysical(input,dependencies,currentProfile,false,true);
}

export function observeP2ProfiledInterruptedReplacementFrontendPhysical(input,dependencies){
  return observeCertificationPhysical(input,dependencies,currentProfile,true,true);
}

export function observeP2ProfiledReplacementRotationWriterScope(input,dependencies){
  return observeCertificationPhysical(input,dependencies,currentProfile,false,true,true);
}

function requireReplacementReceipt(input,artifact){
  const {job,plan,receipt,owner,producers,replacementRelease}=input;
  requireQualificationTargetProfile(currentProfile,receipt,receipt?.target);
  requireReplacementArtifact(job,artifact,input.baseline);
  demand(receipt.version===2&&receipt.status==='P2_CERTIFICATION_DATABASE_CURRENT'&&receipt.service==='frontend'&&
    receipt.environment==='staging'&&receipt.releaseId===job.releaseId&&receipt.sourceCommit===job.sourceCommit&&
    ['certificationActionId','candidateSha256','targetSha256','planSha256'].every(key=>receipt[key]===plan[key])&&
    ['migrationImageDigest','sqlArtifactSha256','schemaBaselineSha256','contractManifestSha256','contractPhase','phase2ContractManifestSha256']
      .every(key=>receipt[key]===job[key])&&
    isDeepStrictEqual(receipt.replacementRelease,replacementRelease)&&receipt.effectiveLoginBoundaryVerified===true&&
    receipt.predecessorRuntimeRoleAbsent===true&&['oldLoginsDenied','oldRoleSessions','retiredLogins'].every(key=>!Object.hasOwn(receipt,key))&&
    targetHash(receipt.target)===plan.targetSha256&&receipt.sqlReplayed===false&&receipt.trafficAuthorized===false&&
    receipt.schemaVerified===true&&receipt.runtimeRoleVerified===true&&
    isDeepStrictEqual(receipt.admission,{epoch:plan.initialEpoch,newWork:false,recovery:false,active:0,uncertain:0})&&
    isDeepStrictEqual(receipt.owner,owner)&&isDeepStrictEqual(owner,plan.nativePlan.owner)&&
    isDeepStrictEqual(receipt.runtime,plan.nativePlan.producer.role)&&isDeepStrictEqual(producers,[plan.nativePlan.producer])&&
    isDeepStrictEqual(receipt.after,artifact.migrations.map(({hash,folderMillis})=>({hash,created_at:String(folderMillis)})))&&
    receipt.journalSha256===hash(receipt.after)&&receipt.witnessSha256===hash(receipt.witness)&&
    digest(input.marker)&&Number.isSafeInteger(input.backendPid)&&input.backendPid>0&&input.backendPid<=2147483647&&
    replacementStart(input.backendStart),'current-replacement-receipt');
}

async function verifyReplacementParent(client,input,closing,observationLocked){
  await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const replacement=input.replacementRelease;
  const {rows:parents}=await client.query(`SELECT ${replacementBackendStart} AS backend_start,application_name,
    datid::text AS database_oid,usesysid::text AS migration_role_oid,backend_type
    FROM pg_catalog.pg_stat_activity WHERE pid=$1`,[input.backendPid]);
  if(closing)demand(parents.length===0,'current-replacement-backend-still-present');
  else demand(isDeepStrictEqual(parents,[{backend_start:input.backendStart,application_name:'lash-her-p2-bounded-certification',
    database_oid:replacement.databaseOid,migration_role_oid:replacement.migrationRoleOid,backend_type:'client backend'}]),
    'current-replacement-backend-identity');
  const {rows:[key]}=await client.query('SELECT pg_catalog.hashtext($1)<>pg_catalog.hashtext($2) AS keys_distinct',
    [FRONTEND_MIGRATION_LOCK,input.marker]);
  demand(key?.keys_distinct===true,'current-replacement-lock-identity');
  const {rows:locks}=await client.query(`SELECT required.slot,l.pid,l.mode,l.granted
    FROM pg_catalog.pg_locks l JOIN (VALUES
      (1,pg_catalog.hashtext($1)::bigint),(2,pg_catalog.hashtext($2)::bigint)) required(slot,key)
    ON l.classid=((required.key>>32)&4294967295)::oid AND l.objid=(required.key&4294967295)::oid
    WHERE l.locktype='advisory' AND l.database=$3::oid AND l.objsubid=1 ORDER BY required.slot`,
  [FRONTEND_MIGRATION_LOCK,input.marker,replacement.databaseOid]);
  const holder=observationLocked?client.processID:input.backendPid;
  const slots=closing?(observationLocked?[1]:[]):[1,2];
  demand(isDeepStrictEqual(locks,slots.map(slot=>({slot,pid:holder,mode:'ExclusiveLock',granted:true}))),
    'current-replacement-lock-identity');
}

async function observeCertificationPhysical(input,{getUrl},expectedProfile,interrupted,replacing=false,rotationWriter=false){
  const replacementRelease=replacing?input?.replacementRelease:undefined;
  demand(Object.hasOwn(input??{},'replacementRelease')===replacing&&
    (!replacing||exact(input,['operation','version','qualificationTargetProfile','marker','backendPid','backendStart','job','baseline',
      'owner','producers','replacementRelease','plan','receipt',...(rotationWriter?['writerScope']:[])])),'current-replacement-probe');
  const selectedProfile=profileFields(expectedProfile,input?.plan,input?.job,input?.historicalLogins,interrupted,replacementRelease);
  if(expectedProfile===undefined)demand(!Object.hasOwn(input,'qualificationTargetProfile'));
  else requireQualificationTargetProfile(currentProfile,input);
  const closing=input.operation==='verify-closed';
  demand(input.version===input.plan.version&&
    (rotationWriter?input.operation===rotationWriterOperation:['observe','verify-schema','witness','fence','verify-closed'].includes(input.operation))&&
    (expectedProfile===undefined?!closing:input.operation!=='fence')&&/^[a-f0-9]{64}$/u.test(input.marker??'')&&Number.isSafeInteger(input.backendPid)&&typeof input.backendStart==='string');
  if(interrupted){
    const {receipt,plan,job}=input;
    requireQualificationTargetProfile(currentProfile,receipt,receipt?.target);
    demand(receipt.version===2&&receipt.status==='P2_CERTIFICATION_DATABASE_CURRENT'&&receipt.service==='frontend'&&
      receipt.releaseId===job.releaseId&&receipt.sourceCommit===job.sourceCommit&&receipt.environment==='staging'&&
      ['certificationActionId','candidateSha256','targetSha256','planSha256'].every(key=>receipt[key]===plan[key])&&
      receipt.sqlReplayed===false&&receipt.trafficAuthorized===false&&targetHash(receipt.target)===plan.targetSha256&&
      receipt.admission?.epoch===plan.initialEpoch&&receipt.admission.newWork===false&&receipt.admission.recovery===false&&
      receipt.admission.active===0&&receipt.admission.uncertain===0&&digest(receipt.journalSha256)&&digest(receipt.witnessSha256)&&
      digest(input.marker)&&input.backendPid>0&&input.backendStart.length>0&&input.backendStart.length<=80,
      'current-interrupted-receipt');
  }
  const replacementArtifact=replacing?frontendMigrationArtifact():undefined;
  if(replacing)requireReplacementReceipt(input,replacementArtifact);
  if(rotationWriter)requireRotationWriterRequest(input);
  const client=new Client(options(await getUrl(),input.job.target,interrupted||replacing));let lost=false,observationLocked=false;client.on('error',()=>{lost=true;});
  try{
    await client.connect();demand(client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const verify=async()=>{
      demand(!lost);const actual=(await client.query("SELECT current_user AS role,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
      demand(actual.role===input.job.target.user&&actual.database===input.job.target.database&&actual.major===input.job.target.serverMajor);
      if(interrupted)await requireReadOnlySession(client);
      if(replacing){
        await verifyReplacementIdentity(client,input.job.target,replacementRelease);
        demand((await client.query('SHOW default_transaction_read_only')).rows[0]?.default_transaction_read_only==='on',
          'current-replacement-read-only');
      }
    };await verify();
    const owner=(await client.query('SELECT oid::text,rolcanlogin,rolsuper,rolinherit,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolconfig,rolconnlimit,rolvaliduntil FROM pg_catalog.pg_roles WHERE rolname=$1',[input.owner.name])).rows[0];
    demand(owner?.oid===input.owner.oid&&owner.rolconfig===null&&owner.rolconnlimit===-1&&owner.rolvaliduntil===null&&
      ['rolcanlogin','rolsuper','rolinherit','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'].every(key=>owner[key]===false));
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===input.owner.oid);
    if(input.operation==='fence'){
      demand(name(input.owner.name));await client.query('BEGIN');
      try{await client.query(`SET LOCAL ROLE "${input.owner.name}"`);const rows=(await client.query('SELECT environment,target_sha256 FROM frontend_admission.control WHERE singleton FOR UPDATE')).rows;
        demand(rows.length===1&&rows[0].environment==='staging'&&rows[0].target_sha256===input.plan.targetSha256);
        await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND (new_work OR recovery)');await client.query('COMMIT');
      }catch{await client.query('ROLLBACK');throw new Error('P2_CERTIFICATION_CONTAINMENT_UNKNOWN');}
      return{version:1,status:'P2_FRONTEND_ADMISSION_CLOSED',frontendAdmissionClosed:true};
    }
    const verifyParent=async()=>{
      if(replacing)return verifyReplacementParent(client,input,closing,observationLocked);
      if(closing)await client.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
      const parent=(await client.query('SELECT backend_start::text FROM pg_catalog.pg_stat_activity WHERE pid=$1',[input.backendPid])).rows[0];
      demand(closing?parent?.backend_start!==input.backendStart:parent?.backend_start===input.backendStart);
      const sql=closing?RECOVERY_HELD_LOCK.replace(' AND pid=pg_backend_pid()',''):RECOVERY_HELD_LOCK.replace('pid=pg_backend_pid()','pid=$2');
      for(const key of [FRONTEND_MIGRATION_LOCK,input.marker]){
        const observed=await client.query(sql,closing?[key]:[key,input.backendPid]);
        demand(observed.rows[0]?.held===!closing);
      }
    };
    await verifyParent();
    if(replacing&&closing){
      const {rows:[lock]}=await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS acquired',[FRONTEND_MIGRATION_LOCK]);
      demand(lock?.acquired===true,'current-replacement-observation-lock');
      observationLocked=true;
    }
    const verifyCurrent=expectedProfile===undefined?verify:async()=>{await verify();await verifyParent();};
    const prepared={migration:{job:input.job,artifact:replacementArtifact??frontendMigrationArtifact(),baseline:input.baseline},plan:{owner:input.owner,producers:input.producers,
      ...(replacing?{replacementRelease}:{historicalLogins:input.historicalLogins}),targetSha256:input.plan.targetSha256}};
    const current=await readCurrent(client,prepared,input.plan,verifyCurrent,false,expectedProfile,interrupted,
      rotationWriter?input.writerScope:undefined);
    if(expectedProfile!==undefined)await verifyCurrent();
    if(observationLocked){
      const {rows:[lock]}=await client.query('SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1)) AS released',[FRONTEND_MIGRATION_LOCK]);
      demand(lock?.released===true,'current-replacement-observation-lock');
      observationLocked=false;
      await verifyCurrent();
    }
    if(interrupted)demand(current.journalSha256===input.receipt.journalSha256&&current.witnessSha256===input.receipt.witnessSha256,
      'current-interrupted-witness-changed');
    if(closing&&replacing&&input.plan.mode===knownAckMode)verifyReplacementKnownAckClosure(input.plan,current);
    if(closing)demand(current.admission.newWork===false&&current.admission.recovery===false&&current.admission.active===0&&current.admission.uncertain===0&&
      (input.plan.mode!==interactiveMode||current.admission.epoch===interactiveClosedEpoch(input.plan)&&
        current.witness.operations.every(row=>row.reconciliation_sha256===null)), 'current-admission-closure');
    return{version:input.version,...selectedProfile,status:rotationWriter?'P2_ROTATION_WRITER_SCOPE_VERIFIED':
      closing?'P2_CERTIFICATION_FRONTEND_SESSION_CLOSED':'P2_FRONTEND_PHYSICAL_LOCK_VERIFIED',marker:input.marker,backendPid:input.backendPid,sourceCommit:input.job.sourceCommit,admission:current.admission,journalSha256:current.journalSha256,
      ...(expectedProfile===undefined?{}:{backendStart:input.backendStart,environment:current.environment,releaseId:current.releaseId,targetSha256:current.targetSha256}),
      ...(replacing?replacementProof(replacementRelease):{}),
      ...(rotationWriter?{writerScope:current.writerScope}:{witnessSha256:current.witnessSha256}),
      ...(input.operation==='witness'?{witness:current.witness}:{}),
      ...(closing?{backendAbsent:true,migrationLockReleased:true,nonceLockReleased:true}:{})};
  }finally{try{await client.end();demand(!lost);}catch{throw new Error('P2_CERTIFICATION_OBSERVER_CLEANUP_UNCERTAIN');}}
}

// The Linux guard invokes this fixed command only after independently accepting
// the physical probe, retaining its canonical flock, and reaping its mutators.
export function containP2ProfiledCertificationAdmission(probe,dependencies){
  return containProfiledCertificationAdmission(probe,dependencies,false);
}

export function containP2ProfiledReplacementCertificationAdmission(probe,dependencies){
  return containProfiledCertificationAdmission(probe,dependencies,true);
}

export function containP2ProfiledReplacementRotationAdmission(probe,dependencies){
  return containProfiledCertificationAdmission(probe,dependencies,true,true);
}

function requireRotationGuardState(plan,row,registry){
  const offset=BigInt(row.epoch)-BigInt(plan.initialEpoch);
  demand(offset>=0n&&offset<=rotationEpochs&&row.new_work===row.recovery&&
    (row.new_work?offset%2n===1n&&registry.kind==='interactive':
      offset%2n===0n&&(registry.kind==='ordinary'||offset>0n)),
    'guard-rotation-admission-state');
}

async function containProfiledCertificationAdmission(probe,{getUrl},replacing,rotationGuard=false){
  const {job,plan,owner,historicalLogins,receipt}=probe;
  demand(Object.hasOwn(probe,'replacementRelease')===replacing&&
    (!replacing||exact(probe,['version','qualificationTargetProfile','marker','backendPid','backendStart','job','baseline',
      'owner','producers','replacementRelease','plan','receipt'])),'current-replacement-probe');
  const replacementRelease=replacing?probe.replacementRelease:undefined;
  const selectedProfile=profileFields(currentProfile,plan,job,historicalLogins,false,replacementRelease);
  if(replacing)requireReplacementReceipt(probe,frontendMigrationArtifact());
  if(rotationGuard){
    requireRotationFrontendPlan(probe);
    demand(epoch((BigInt(plan.initialEpoch)+rotationEpochs).toString()),'guard-rotation-epoch');
  }
  requireQualificationTargetProfile(currentProfile,probe,receipt,receipt.target);
  const target=job.target;
  demand(probe.version===2&&receipt.version===2&&receipt.status==='P2_CERTIFICATION_DATABASE_CURRENT'&&
    name(owner.name)&&/^[1-9][0-9]{0,9}$/u.test(owner.oid??'')&&isDeepStrictEqual(receipt.owner,owner)&&
    plan.sourceCommit===job.sourceCommit&&plan.originalReleaseId===job.releaseId&&
    receipt.sourceCommit===job.sourceCommit&&receipt.releaseId===job.releaseId&&
    receipt.certificationActionId===plan.certificationActionId&&receipt.planSha256===plan.planSha256&&
    receipt.candidateSha256===plan.candidateSha256&&receipt.targetSha256===plan.targetSha256&&plan.targetSha256===targetHash(target)&&
    ['host','port','database','user','serverMajor'].every(key=>receipt.target[key]===target[key])&&
    receipt.admission?.epoch===plan.initialEpoch&&receipt.admission.newWork===false&&receipt.admission.recovery===false&&
    (plan.mode!==interactiveMode||receipt.admission.active===0&&receipt.admission.uncertain===0&&
      isDeepStrictEqual(receipt.runtime,plan.nativePlan.producer.role)&&Array.isArray(receipt.witness?.operations)&&
      receipt.witness.operations.length===0&&receipt.witnessSha256===hash(receipt.witness)));
  const client=new Client(options(await getUrl(),target));let lock=false,started=false,lost=false;
  client.on('error',()=>{lost=true;});
  const verify=async()=>{
    demand(!lost&&client.connection?.stream?.encrypted===true&&client.connection.stream.authorized===true);
    const identity=(await client.query("SELECT current_user AS role,session_user AS session_role,pg_catalog.current_database() AS database,pg_catalog.current_setting('server_version_num')::int/10000 AS major")).rows[0];
    demand(identity?.role===target.user&&identity.session_role===target.user&&identity.database===target.database&&identity.major===target.serverMajor);
    if(replacing)await verifyReplacementIdentity(client,target,replacementRelease);
    if(lock)demand((await client.query(RECOVERY_HELD_LOCK,[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true);
  };
  try{
    await client.connect();await verify();
    lock=(await client.query('SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext($1)) AS held',[FRONTEND_MIGRATION_LOCK])).rows[0]?.held===true;
    demand(lock,'guard-physical-lock');await verify();
    if(replacing){
      await verifyReplacementParent(client,probe,true,true);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');started=true;
      const {verifyReplacementJournalTable,verifyReplacementAdmissionRelations}=await import('./p2-frontend-replacement-written.mjs');
      await verifyReplacementJournalTable(client,replacementRelease.migrationRoleOid);
      await verifyReplacementAdmissionRelations(client,owner.oid);
      const rows=(await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC NULLS FIRST,id ASC LIMIT $1',
        [receipt.after.length+1])).rows;
      demand(isDeepStrictEqual(rows,receipt.after)&&isDeepStrictEqual(await readMigrationCatalog(client),probe.baseline.catalog),
        'guard-replacement-journal-schema');
      const {verifyReplacementRuntimeGrants}=await import('./p2-recovery-current-probe.mjs');
      const runtime=await verifyReplacementRuntimeGrants(client,target,owner);
      demand(isDeepStrictEqual(runtime,receipt.runtime),'guard-replacement-runtime');
      await verifyReplacementLogins(client,target,replacementRelease,runtime,owner);
      await client.query('ROLLBACK');started=false;await verify();
      await verifyReplacementParent(client,probe,true,true);
    }
    await client.query('BEGIN');started=true;
    const role=(await client.query('SELECT oid::text,rolcanlogin,rolsuper FROM pg_catalog.pg_roles WHERE rolname=$1',[owner.name])).rows[0];
    demand(role?.oid===owner.oid&&role.rolcanlogin===false&&role.rolsuper===false);
    demand((await client.query("SELECT nspowner::text AS oid FROM pg_catalog.pg_namespace WHERE nspname='frontend_admission'")).rows[0]?.oid===owner.oid);
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const rows=(await client.query('SELECT environment,target_sha256,epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton FOR UPDATE NOWAIT')).rows;
    const row=rows[0];
    demand(rows.length===1&&row.environment==='staging'&&row.target_sha256===plan.targetSha256&&/^[1-9][0-9]{0,17}$/u.test(row.epoch??'')&&
      typeof row.new_work==='boolean'&&typeof row.recovery==='boolean'&&BigInt(row.epoch)>=BigInt(plan.initialEpoch)&&
      BigInt(row.epoch)<=BigInt(plan.initialEpoch)+(rotationGuard?rotationEpochs:4n));
    let rotationRegistry;
    if(rotationGuard){
      // Hold the control row and producer registry across the flag-only write.
      // An admitted operation can still finish against its unchanged record.
      await client.query('LOCK TABLE frontend_admission.producers IN SHARE MODE NOWAIT');
      rotationRegistry=await readRotationRegistry(client,plan,receipt.runtime,row.epoch);
      requireRotationGuardState(plan,row,rotationRegistry);
    }
    const changed=row.new_work||row.recovery;
    const epoch=changed?(await client.query('UPDATE frontend_admission.control SET new_work=false,recovery=false,epoch=epoch+1 WHERE singleton AND epoch=$1::bigint RETURNING epoch::text',[row.epoch])).rows[0]?.epoch:row.epoch;
    demand(epoch===(BigInt(row.epoch)+(changed?1n:0n)).toString());
    await client.query('COMMIT');started=false;await verify();
    if(rotationGuard)await verifyReplacementParent(client,probe,true,true);
    await client.query(rotationGuard?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN READ ONLY');started=true;
    await client.query(`SET LOCAL ROLE "${owner.name}"`);
    const closed=(await client.query('SELECT epoch::text,new_work,recovery FROM frontend_admission.control WHERE singleton AND environment=$1 AND target_sha256=$2',['staging',plan.targetSha256])).rows;
    demand(closed.length===1&&closed[0].epoch===epoch&&closed[0].new_work===false&&closed[0].recovery===false);
    let knownAckLedger;
    if(replacing&&plan.mode===knownAckMode){
      const {rows:[counts]}=await client.query(`SELECT count(*) FILTER(WHERE state='active')::int AS active,
        count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations WHERE state<>'completed'`);
      demand(counts&&['active','uncertain'].every(key=>Number.isInteger(counts[key])&&counts[key]>=0),'guard-replacement-known-ack-ledger');
      knownAckLedger={...counts,closedZero:counts.active===0&&counts.uncertain===0};
    }
    let rotationState;
    if(rotationGuard){
      const registry=await readRotationRegistry(client,plan,receipt.runtime,epoch);
      requireRotationGuardState(plan,closed[0],registry);
      demand(isDeepStrictEqual(registry,rotationRegistry),'guard-rotation-registry-changed');
      const {rows:[counts]}=await client.query(`SELECT count(*) FILTER(WHERE state='active')::int AS active,
        count(*) FILTER(WHERE state='uncertain')::int AS uncertain FROM frontend_admission.operations WHERE state<>'completed'`);
      demand(counts&&['active','uncertain'].every(key=>Number.isInteger(counts[key])&&counts[key]>=0),'guard-rotation-ledger');
      rotationState={newWork:false,recovery:false,...counts,registry:registry.kind,registrySha256:registry.registrySha256};
    }
    await client.query('ROLLBACK');started=false;await verify();
    if(rotationGuard)await verifyReplacementParent(client,probe,true,true);
    return {version:2,...selectedProfile,status:rotationGuard?'P2_PROFILED_ROTATION_GUARD_FRONTEND_CLOSED':
      'P2_PROFILED_CERTIFICATION_GUARD_FRONTEND_CLOSED',environment:'staging',
      releaseId:job.releaseId,sourceCommit:job.sourceCommit,certificationActionId:plan.certificationActionId,
      candidateSha256:plan.candidateSha256,targetSha256:plan.targetSha256,planSha256:plan.planSha256,
      epoch,frontendAdmissionClosed:true,admissionChanged:changed,sqlReplayed:false,releaseAccepted:false,
      ...(replacing?replacementProof(replacementRelease):{}),...(knownAckLedger?{knownAckLedger}:{}),...rotationState};
  }finally{
    if(started)try{await client.query('ROLLBACK');}catch{lost=true;}
    try{await client.end();}catch{lost=true;}
    demand(!lost,'guard-session-cleanup');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const flags=process.argv.slice(2);demand(flags.length===0||(flags.length===1&&['--profiled-current','--profiled-current-guard-fence',
      '--profiled-known-ack-interrupted','--profiled-replacement','--profiled-replacement-guard-fence',
      '--profiled-replacement-known-ack-interrupted',rotationWriterFlag,rotationGuardFlag].includes(flags[0])));
    const raw=readFileSync(0);demand(raw.length>0&&raw.length<=2_000_000);
    const expectedProfile=flags.length?currentProfile:undefined;
    const input=expectedProfile?decodeQualificationTargetJson(raw,'carrier'):JSON.parse(raw);
    const dependencies={getUrl:()=>process.env.FRONTEND_STAGING_MIGRATION_DATABASE_URL};
    const output=flags[0]==='--profiled-current-guard-fence'
      ?await containP2ProfiledCertificationAdmission(input,dependencies)
      :flags[0]==='--profiled-replacement-guard-fence'
        ?await containP2ProfiledReplacementCertificationAdmission(input,dependencies)
      :flags[0]===rotationGuardFlag
        ?await containP2ProfiledReplacementRotationAdmission(input,dependencies)
      :flags[0]===rotationWriterFlag
        ?await observeP2ProfiledReplacementRotationWriterScope(input,dependencies)
      :flags[0]==='--profiled-replacement'
        ?await observeP2ProfiledReplacementFrontendPhysical(input,dependencies)
      :flags[0]==='--profiled-replacement-known-ack-interrupted'
        ?await observeP2ProfiledInterruptedReplacementFrontendPhysical(input,dependencies)
        :flags[0]==='--profiled-known-ack-interrupted'
          ?await observeP2ProfiledInterruptedFrontendPhysical(input,dependencies)
          :await observeP2CertificationPhysical(input,dependencies,expectedProfile);
    console.log(JSON.stringify(output));
  }
  catch{console.error('P2_CERTIFICATION_PHYSICAL_REFUSED');process.exitCode=1;}
}

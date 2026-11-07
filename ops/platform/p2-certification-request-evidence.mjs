// Actual retained request-detail artifacts. No inferred provider queue or API schema.
import {basename,dirname,resolve,join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {readFrontendReleaseEvidence,frontendReleaseReceiptStore,frontendPrivateReceiptDirectory} from './frontend-release-receipts.mjs';
import {p2NativeHash,validateP2NativeRequestObservation} from './p2-lifecycle-native.mjs';

const demand=ok=>{if(!ok)throw new Error('P2_CERTIFICATION_REQUEST_EVIDENCE_REFUSED');};
const keys=['version','kind','reviewerGithubUserId','certificationActionId','nativePlanSha256','windowEpoch','recordedAt','observations'];
const detailKeys=['version','kind','reviewerGithubUserId','projectId','deploymentId','path','method','providerRequestTypeFilter','providerRequestId','startedAt','completedAt','httpStatus','logScope','admittedLogLine'];

export function collectP2CertificationRequestDetails(nativePlan,windowEpoch,input,{directory,certificationActionId}){
  // No supported automatic provider request-details collector is installed.
  // Explicit operator observations use the existing reviewed finite contract.
  demand(input?.kind==='operator-recorded-request-details'&&typeof input.path==='string'&&resolve(input.path)===input.path);
  const bytes=readFrontendReleaseEvidence(dirname(input.path),basename(input.path)),artifact=JSON.parse(bytes);
  demand(artifact&&typeof artifact==='object'&&!Array.isArray(artifact)&&isDeepStrictEqual(Object.keys(artifact).sort(),[...keys].sort())&&
    artifact.version===1&&artifact.kind===input.kind&&artifact.reviewerGithubUserId==='8996309'&&artifact.certificationActionId===certificationActionId&&
    artifact.nativePlanSha256===nativePlan.planSha256&&artifact.windowEpoch===windowEpoch&&
    typeof artifact.recordedAt==='string'&&new Date(artifact.recordedAt).toISOString()===artifact.recordedAt&&
    Array.isArray(artifact.observations)&&artifact.observations.length>0&&artifact.observations.length<=4096);
  const observations=artifact.observations.map(row=>{demand(row&&typeof row==='object'&&!Array.isArray(row)&&isDeepStrictEqual(Object.keys(row).sort(),[...detailKeys].sort()));return validateP2NativeRequestObservation(nativePlan,row,windowEpoch);});
  demand(new Set(observations.map(row=>row.providerRequestId)).size===observations.length);
  const artifactSha256=p2NativeHash(bytes),name=nativePlan.planSha256+'-'+artifactSha256+'.json';
  frontendPrivateReceiptDirectory(directory);const evidenceDirectory=join(directory,'native-request-evidence');mkdirSync(evidenceDirectory,{mode:0o700});
  const store=frontendReleaseReceiptStore(evidenceDirectory);store.retain(name,bytes);
  store.record('p2-native-request-evidence-provenance.json',{version:1,status:'P2_OPERATOR_REQUEST_DETAILS_RETAINED',
    kind:artifact.kind,reviewerGithubUserId:artifact.reviewerGithubUserId,certificationActionId,nativePlanSha256:nativePlan.planSha256,windowEpoch,
    artifactSha256,artifactReceipt:name,recordedAt:artifact.recordedAt,requestCount:observations.length,
    automaticProviderEvidence:false,providerInventoryComplete:false,providerCancellationVerified:false});
  return observations;
}

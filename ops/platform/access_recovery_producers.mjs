// Fixed-team read-only producer observations. No environment readback or write.
import assert from "node:assert/strict";
import {readBoundedJson} from "./release-inputs.mjs";
export const PROJECT="prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM";
export const TEAM="team_2Hrn5eMZyZxfAWdmYvyKi9t3";
export const DEPLOYMENT="dpl_CdhFqwVANweysVe9cCTNpmHfduiy";

export async function readRecoveryProducers(token,{fetch=globalThis.fetch,now=Date.now}={}) {
  assert.ok(typeof token==="string"&&token.length>0);
  const get=async path=>readBoundedJson(await fetch("https://api.vercel.com"+path+(path.includes("?")?"&":"?")+"teamId="+TEAM,
    {method:"GET",redirect:"error",signal:AbortSignal.timeout(30000),headers:{authorization:"Bearer "+token,accept:"application/json"}}));
  const p=await get("/v9/projects/"+PROJECT);
  assert.equal(p.id,PROJECT);assert.equal(p.accountId,TEAM);assert.equal(p.link?.type,"github");assert.equal(String(p.link?.repoId),"1114139712");
  assert.equal(p.targets?.production?.id,DEPLOYMENT);
  assert.ok(Number.isSafeInteger(p.crons?.disabledAt)&&p.crons.disabledAt>0&&now()-p.crons.disabledAt>=16000);
  assert.equal(p.crons.deploymentId,DEPLOYMENT);
  const d=await get("/v13/deployments/"+DEPLOYMENT+"?withGitRepoInfo=true");
  assert.equal(d.id,DEPLOYMENT);assert.equal(d.projectId,PROJECT);assert.equal(d.readyState,"READY");assert.equal(d.target,"production");
  assert.equal(d.gitSource?.type,"github");assert.equal(String(d.gitSource?.repoId),"1114139712");
  assert.equal(d.gitSource?.sha,"74ca26736e5834fce639407278b4575bf4d05670");assert.equal(d.meta?.lashReleaseId,"p1-41541683416-1");
  const alias=await get("/v4/aliases/staging.lashher.com");
  assert.equal(alias.alias,"staging.lashher.com");assert.equal(alias.projectId,PROJECT);assert.equal(alias.deploymentId,DEPLOYMENT);
  return {status:"ACCESS_RECOVERY_FRONTEND_PRODUCERS_VERIFIED",projectId:PROJECT,deploymentId:DEPLOYMENT,
    schedulesEnabled:false,disabledAt:p.crons.disabledAt,sourceCommit:d.gitSource.sha,providerMutationsPerformed:false};
}

export function verifyRecoveryMux(value,now=Date.now()) {
  assert.equal(value.status,"MUX_DEV_DASHBOARD_INVENTORY_VERIFIED");assert.equal(value.organizationId,"4g1uhq");
  assert.equal(value.environmentId,"7j65e8");assert.equal(value.environmentName,"Lash Her Academy [DEV]");
  assert.equal(value.sourceUrl,"https://dashboard.mux.com/organizations/4g1uhq/environments/7j65e8/settings/webhooks?page=1&limit=25&create=false");
  assert.equal(value.inventoryComplete,true);assert.equal(value.settingsChanged,false);assert.equal(value.stagingGatewayWebhookCount,0);
  assert.deepEqual(value.webhooks,[{address:"http://localhost:4000/v1/webhooks/mux",enabled:true}]);
  assert.ok(Number.isSafeInteger(value.observedAt)&&now-value.observedAt>=0&&now-value.observedAt<=300000);
  for(const key of ["maskedAccessibilitySha256","maskedScreenshotSha256"])assert.match(value[key],/^[a-f0-9]{64}$/u);
  return value;
}

import assert from "node:assert/strict";
import test from "node:test";
import {readRecoveryProducers,verifyRecoveryMux,PROJECT,TEAM,DEPLOYMENT} from "./access_recovery_producers.mjs";

function owned() {
  const project={id:PROJECT,accountId:TEAM,link:{type:"github",repoId:1114139712},targets:{production:{id:DEPLOYMENT}},
    crons:{deploymentId:DEPLOYMENT,disabledAt:1000},env:[{value:"owned-secret-must-not-return"}]};
  const deployment={id:DEPLOYMENT,projectId:PROJECT,readyState:"READY",target:"production",gitSource:{type:"github",repoId:1114139712,
    sha:"74ca26736e5834fce639407278b4575bf4d05670"},meta:{lashReleaseId:"p1-41541683416-1"}};
  const alias={alias:"staging.lashher.com",projectId:PROJECT,deploymentId:DEPLOYMENT},calls=[];
  const fetch=async (url,options)=> {
    calls.push({url,options});const u=new URL(url);assert.equal(u.origin,"https://api.vercel.com");assert.equal(u.searchParams.get("teamId"),TEAM);
    assert.equal(options.method,"GET");assert.equal(options.redirect,"error");assert.equal(options.headers.authorization,"Bearer owned-private-token");
    return Response.json(u.pathname.startsWith("/v9/projects/")?project:u.pathname.startsWith("/v13/deployments/")?deployment:alias);
  };
  return {project,deployment,alias,calls,fetch,now:()=>100000};
}
test("fixed staging producer observation is read-only and omits provider environment values",async()=> {
  const f=owned(),value=await readRecoveryProducers("owned-private-token",f);
  assert.equal(value.schedulesEnabled,false);assert.equal(f.calls.length,3);
  assert.ok(!JSON.stringify(value).includes("owned-secret"));assert.ok(!JSON.stringify(value).includes("owned-private-token"));
});
test("changed source, enabled or undrained crons, another project or alias refuse",async()=> {
  for(const mutate of [f=>{f.project.crons.disabledAt=null;},f=>{f.project.crons.disabledAt=99000;},
    f=>{f.project.accountId="other";},f=>{f.project.crons.deploymentId="dpl_other";},
    f=>{f.deployment.gitSource.sha="a".repeat(40);},f=>{f.alias.deploymentId="dpl_other";}]) {
    const f=owned();mutate(f);await assert.rejects(readRecoveryProducers("owned-private-token",f));
  }
});
test("provider redirects and oversized JSON refuse",async()=> {
  await assert.rejects(readRecoveryProducers("owned",{fetch:async()=>new Response("",{status:302})}));
  await assert.rejects(readRecoveryProducers("owned",{fetch:async()=>Response.json({value:"x".repeat(2100000)})}));
});
test("fresh complete Dev Mux inventory must still have no staging callback",()=> {
  const v={status:"MUX_DEV_DASHBOARD_INVENTORY_VERIFIED",organizationId:"4g1uhq",environmentId:"7j65e8",environmentName:"Lash Her Academy [DEV]",
    sourceUrl:"https://dashboard.mux.com/organizations/4g1uhq/environments/7j65e8/settings/webhooks?page=1&limit=25&create=false",
    inventoryComplete:true,settingsChanged:false,stagingGatewayWebhookCount:0,webhooks:[{address:"http://localhost:4000/v1/webhooks/mux",enabled:true}],
    observedAt:1000,maskedAccessibilitySha256:"a".repeat(64),maskedScreenshotSha256:"b".repeat(64)};
  assert.equal(verifyRecoveryMux(v,2000),v);
  for(const mutate of [d=>{d.observedAt=100000;},d=>{d.observedAt=-500000;},d=>{d.inventoryComplete=false;},d=>{d.stagingGatewayWebhookCount=1;},d=>{d.webhooks.push({address:"https://api-staging.lashher.com/course/v1/webhooks/mux",enabled:true});}]) {
    const d=structuredClone(v);mutate(d);assert.throws(()=>verifyRecoveryMux(d,2000));
  }
});

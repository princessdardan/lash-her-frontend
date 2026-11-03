import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {verifyOperatorCi,verifyExactHeadWorkflow} from "./recreation_source.mjs";
import {REQUIRED_SOURCE_JOBS} from "./source-policy.mjs";

function fixture() {
  const sourceCommit="a".repeat(40),branch="codex/p1-owned-recreation";
  const workflowBytes=Buffer.from(JSON.stringify({name:"CI",jobs:{owned:{steps:[{
    uses:"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",with:{ref:"${{ github.event.pull_request.head.sha || github.sha }}","persist-credentials":false}}]}}}));
  const repo={full_name:"princessdardan/lash-her-frontend",id:1114139712,owner:{id:8996309},private:false};
  const run={id:1234,run_number:22,run_attempt:1,head_sha:sourceCommit,head_branch:branch,repository:repo,head_repository:repo,
    actor:{id:8996309},path:".github/workflows/ci.yml",event:"pull_request",status:"completed",conclusion:"success"};
  const jobs=REQUIRED_SOURCE_JOBS.frontend.map(name=>({name,status:"completed",conclusion:"success"}));
  const calls=[];
  const api=async path=> {
    calls.push(path);
    if(path.endsWith("/lash-her-frontend"))return repo;
    if(path.includes("/branches/"))return {name:branch,commit:{sha:sourceCommit}};
    if(path.includes("/workflows/ci.yml/runs?"))return {total_count:1,workflow_runs:[run]};
    if(path.includes("/attempts/1/jobs?"))return {total_count:jobs.length,jobs};
    if(path.includes("/contents/"))return {type:"file",encoding:"base64",size:workflowBytes.length,content:workflowBytes.toString("base64")};
    throw Error("Unexpected owned API path");
  };
  return {sourceCommit,branch,workflowBytes,repo,run,jobs,calls,api};
}
test("supplemental source proof binds current canonical PR head, every required job and exact workflow bytes",async()=> {
  const f=fixture(),result=await verifyOperatorCi(f);
  assert.equal(result.requiredChecks,"passed");assert.equal(result.sourceCommit,f.sourceCommit);
  assert.equal(result.applicationCandidateRebuilt,false);assert.equal(result.ciEvent,"pull_request");
  assert.equal(f.calls.filter(path=>path.includes("/branches/")).length,2);
});
test("forked source, wrong actor, failed or skipped jobs and missing workflow refuse",async()=> {
  for(const change of [f=>{f.run.head_repository={...f.repo,full_name:"outsider/fork"};},f=>{f.run.actor.id=1;},
    f=>{f.jobs[0].conclusion="skipped";},f=>{f.jobs.splice(0,1);},f=>{f.run.conclusion="failure";},
    f=>{f.workflowBytes=Buffer.from("substituted workflow");}]) {
    const f=fixture();change(f);await assert.rejects(verifyOperatorCi(f));
  }
});
test("newer failed attempts and moved source heads cannot hide behind prior green CI",async()=> {
  const f=fixture(),api=f.api;
  await assert.rejects(verifyOperatorCi({...f,api:async path=>path.includes("/workflows/ci.yml/runs?")?
    {total_count:2,workflow_runs:[f.run,{...f.run,run_attempt:2,conclusion:"failure"}]}:api(path)}));
  let heads=0;
  await assert.rejects(verifyOperatorCi({...f,api:async path=> {
    const value=await api(path);
    return path.includes("/branches/")&&++heads===2?{name:f.branch,commit:{sha:"b".repeat(40)}}:value;
  }}));
});
test("real CI workflow pins every checkout to exact PR source and never persists its token",()=> {
  const raw=readFileSync(new URL("../../.github/workflows/ci.yml",import.meta.url));
  assert.equal(verifyExactHeadWorkflow(raw).length,64);
  const changed=raw.toString().replaceAll("          ref: ${{ github.event.pull_request.head.sha || github.sha }}\n","");
  assert.throws(()=>verifyExactHeadWorkflow(Buffer.from(changed)));
});

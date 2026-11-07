import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyOperatorCi,verifyExactHeadWorkflow,readOperatorSourceFiles,readProfiledCurrentOperatorSourceFiles} from "./recreation_source.mjs";
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
test("the complete committed operator source fits the real public installation envelope",()=> {
  const root=fileURLToPath(new URL("../..",import.meta.url));
  const sourceCommit=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  const files=readProfiledCurrentOperatorSourceFiles(root);
  assert.equal(files.filter(file=>file.path.startsWith("ops/platform/profiles/frontend-historical-sources/")).length,33);
  assert.ok(Buffer.byteLength(JSON.stringify({commit:sourceCommit,files}))<=56_000_000);
});
test("actual Git source handoff accepts 512 files and refuses 513 with the per-file byte limit intact",()=> {
  const directory=mkdtempSync(join(tmpdir(),"p2-source-count-"));
  const git=args=>execFileSync("git",["-C",directory,...args],{stdio:["ignore","pipe","pipe"]});
  try {
    git(["init","--quiet"]);mkdirSync(join(directory,"ops"));
    for(let index=0;index<512;index++)writeFileSync(join(directory,`ops/owned-${index}.mjs`),"// owned source\n");
    git(["add","ops"]);assert.equal(readOperatorSourceFiles(directory).length,512);
    writeFileSync(join(directory,"ops/overflow.mjs"),"// owned source\n");git(["add","ops/overflow.mjs"]);
    assert.throws(()=>readOperatorSourceFiles(directory));
    assert.equal(readProfiledCurrentOperatorSourceFiles(directory).length,513);
    const additions=Array.from({length:31},(_,index)=>`ops/profiled-${index}.mjs`);
    for(const name of additions)writeFileSync(join(directory,name),"// owned source\n");
    git(["add","ops"]);assert.equal(readProfiledCurrentOperatorSourceFiles(directory).length,544);
    writeFileSync(join(directory,"ops/profiled-overflow.mjs"),"// owned source\n");git(["add","ops"]);
    assert.throws(()=>readProfiledCurrentOperatorSourceFiles(directory));
    git(["rm","--cached","ops/overflow.mjs","ops/profiled-overflow.mjs",...additions]);
    writeFileSync(join(directory,"ops/owned-0.mjs"),Buffer.alloc(2_000_001));
    assert.throws(()=>readOperatorSourceFiles(directory));
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test("actual Git source handoff accepts exactly 41 MB and refuses one extra decoded byte",()=> {
  const directory=mkdtempSync(join(tmpdir(),"p2-source-bytes-"));
  const git=args=>execFileSync("git",["-C",directory,...args],{stdio:["ignore","pipe","pipe"]});
  try {
    git(["init","--quiet"]);mkdirSync(join(directory,"ops"));
    for(let index=0;index<20;index++)writeFileSync(join(directory,`ops/owned-${index}.mjs`),Buffer.alloc(2_000_000,120));
    const last=join(directory,"ops/owned-last.mjs");writeFileSync(last,Buffer.alloc(1_000_000,120));
    git(["add","ops"]);
    const files=readOperatorSourceFiles(directory);
    assert.equal(files.reduce((total,file)=>total+Buffer.from(file.data,"base64").length,0),41_000_000);
    assert.ok(Buffer.byteLength(JSON.stringify({commit:"a".repeat(40),files}))<=56_000_000);
    writeFileSync(last,Buffer.alloc(1_000_001,120));
    assert.throws(()=>readOperatorSourceFiles(directory));
    writeFileSync(last,Buffer.alloc(1_850_000,120));
    const profiled=readProfiledCurrentOperatorSourceFiles(directory);
    assert.equal(profiled.reduce((total,file)=>total+Buffer.from(file.data,"base64").length,0),41_850_000);
    assert.ok(Buffer.byteLength(JSON.stringify({commit:"a".repeat(40),files:profiled}))<=56_000_000);
    writeFileSync(last,Buffer.alloc(1_850_001,120));
    assert.throws(()=>readProfiledCurrentOperatorSourceFiles(directory));
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test("operator source refuses a tracked symlink into a private file",()=> {
  const directory=mkdtempSync(join(tmpdir(),"p2-source-symlink-"));
  const git=args=>execFileSync("git",["-C",directory,...args],{stdio:["ignore","pipe","pipe"]});
  try {
    git(["init","--quiet"]);mkdirSync(join(directory,"ops"));
    writeFileSync(join(directory,"owned-private.txt"),"owned fixture only\n",{mode:0o600});
    symlinkSync("../owned-private.txt",join(directory,"ops/link.mjs"));git(["add","ops"]);
    assert.throws(()=>readOperatorSourceFiles(directory),/symlink refused/u);
    assert.throws(()=>readProfiledCurrentOperatorSourceFiles(directory),/symlink refused/u);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

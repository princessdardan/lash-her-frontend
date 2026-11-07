// Supplemental operator tooling CI. Application images keep their existing
// qualified source pins; this proof never claims a new image candidate.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {lstatSync,readFileSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {parse} from "yaml";
import {assertSourceCheckout} from "./source-checkout.mjs";
import {REQUIRED_SOURCE_JOBS,SOURCE_OPERATOR_ID,SOURCE_REPOSITORY_IDS} from "./source-policy.mjs";
import {sha256} from "./recreation_inputs.mjs";

const repository="princessdardan/lash-her-frontend";
export const LEGACY_OPERATOR_SOURCE_BOUNDS = Object.freeze({ files: 512, decodedBytes: 41_000_000 });
export const PROFILED_CURRENT_OPERATOR_SOURCE_BOUNDS = Object.freeze({ files: 544, decodedBytes: 41_900_000 });
export function verifyExactHeadWorkflow(raw) {
  const workflow=parse(raw.toString("utf8"));
  assert.ok(workflow.jobs&&Object.keys(workflow.jobs).length>0,"Operator CI jobs required");
  for(const job of Object.values(workflow.jobs)) {
    assert.ok(Array.isArray(job.steps),"Explicit operator CI steps required");
    const checkout=job.steps.filter(step=>typeof step.uses==="string"&&step.uses.startsWith("actions/checkout@"));
    assert.equal(checkout.length,1,"One exact checkout per operator CI job required");
    assert.equal(checkout[0].uses,"actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803");
    assert.equal(checkout[0].with?.ref,"${{ github.event.pull_request.head.sha || github.sha }}");
    assert.equal(checkout[0].with?.["persist-credentials"],false);
  }
  return sha256(raw);
}
export async function verifyOperatorCi({api,sourceCommit,branch,workflowBytes}) {
  assert.match(sourceCommit,/^[a-f0-9]{40}$/u);
  assert.match(branch,/^(?:main|staging|codex\/[a-z0-9][a-z0-9./_-]{0,110})$/u);
  const prefix="/repos/"+repository;
  const metadata=await api(prefix);
  assert.equal(metadata.full_name,repository);assert.equal(String(metadata.id),SOURCE_REPOSITORY_IDS.frontend);
  assert.equal(String(metadata.owner?.id),SOURCE_OPERATOR_ID);assert.equal(metadata.private,false);
  const headPath=prefix+"/branches/"+encodeURIComponent(branch);
  const head=await api(headPath);
  assert.equal(head.name,branch);assert.equal(head.commit?.sha,sourceCommit);
  const runs=await api(prefix+`/actions/workflows/ci.yml/runs?head_sha=${sourceCommit}&per_page=100`);
  assert.ok(Array.isArray(runs.workflow_runs)&&runs.total_count===runs.workflow_runs.length&&runs.total_count>0&&runs.total_count<=100,"Complete exact-source CI history required");
  const run=[...runs.workflow_runs].sort((a,b)=>b.run_number-a.run_number||b.run_attempt-a.run_attempt)[0];
  assert.ok(Number.isSafeInteger(run.id)&&run.id>0&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0);
  assert.equal(run.head_sha,sourceCommit);assert.equal(run.head_branch,branch);
  assert.equal(run.repository?.full_name,repository);assert.equal(String(run.repository?.id),SOURCE_REPOSITORY_IDS.frontend);
  assert.equal(run.head_repository?.full_name,repository);assert.equal(String(run.head_repository?.id),SOURCE_REPOSITORY_IDS.frontend);
  assert.equal(String(run.actor?.id),SOURCE_OPERATOR_ID);
  assert.equal(run.path,".github/workflows/ci.yml");assert.ok(["push","pull_request","workflow_dispatch"].includes(run.event));
  assert.equal(run.status,"completed");assert.equal(run.conclusion,"success","Latest operator-source CI must pass");
  const jobs=await api(prefix+`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  assert.ok(Array.isArray(jobs.jobs)&&jobs.jobs.length===jobs.total_count&&jobs.total_count<=100
    &&new Set(jobs.jobs.map(job=>job.name)).size===jobs.jobs.length);
  assert.ok(REQUIRED_SOURCE_JOBS.frontend.every(name=>jobs.jobs.some(job=>job.name===name)),"All ten operator-source jobs required");
  assert.ok(jobs.jobs.every(job=>job.status==="completed"&&job.conclusion==="success"),"Every current operator-source job must pass");
  const workflow=await api(prefix+`/contents/.github/workflows/ci.yml?ref=${sourceCommit}`);
  assert.equal(workflow.type,"file");assert.equal(workflow.encoding,"base64");
  assert.ok(Number.isSafeInteger(workflow.size)&&workflow.size>0&&workflow.size<=262144);
  const encoded=workflow.content.replace(/\n/gu,""),raw=Buffer.from(encoded,"base64");
  assert.equal(raw.length,workflow.size);assert.equal(raw.toString("base64"),encoded);assert.deepEqual(raw,workflowBytes);
  verifyExactHeadWorkflow(raw);
  const final=await api(headPath);assert.equal(final.commit?.sha,sourceCommit);
  return {sourceKind:"supplemental-recovery-tooling",sourceCommit,branch,requiredChecks:"passed",
    ciRunId:String(run.id),ciAttempt:run.run_attempt,ciEvent:run.event,ciWorkflowSha256:sha256(raw),
    ciUrl:`https://github.com/${repository}/actions/runs/${run.id}`,applicationCandidateRebuilt:false};
}

function readBoundedOperatorSourceFiles(source, bounds) {
  const git=args=>execFileSync("git",["-C",source,...args],{encoding:"utf8",timeout:10000,maxBuffer:16_000_000,
    stdio:["ignore","pipe","pipe"]});
  const paths=git(["ls-files","-z","--","ops"]).split("\0").filter(path=>path&&/\.(?:py|mjs|json|yaml|yml|service|timer|sh|guard)$/u.test(path));
  // Complete integration includes fixed certification and rotation packages.
  // Keep source count finite; aggregate and transport bytes are bounded separately.
  assert.ok(paths.length>0&&paths.length<=bounds.files);
  let total=0;
  const canonicalSource = realpathSync(source);
  return paths.map(path=> {
    assert.ok(path.startsWith("ops/")&&!path.split("/").includes(".."));
    const file=join(canonicalSource,path);
    const info=lstatSync(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink()&&realpathSync(file)===file,"Operator source symlink refused");
    const raw=readFileSync(file);total+=raw.length;
    // Preserve every immutable historical source profile and complete operator
    // dependency. This decoded cap still fits the fixed 56 MB public transport.
    assert.ok(raw.length<=2_000_000&&total<=bounds.decodedBytes);
    return {path,sha256:sha256(raw),data:raw.toString("base64")};
  });
}
export function readOperatorSourceFiles(source) {
  return readBoundedOperatorSourceFiles(source, LEGACY_OPERATOR_SOURCE_BOUNDS);
}
export function readProfiledCurrentOperatorSourceFiles(source) {
  return readBoundedOperatorSourceFiles(source, PROFILED_CURRENT_OPERATOR_SOURCE_BOUNDS);
}
function committedBoundedOperatorSource(source, sourceCommit, readFiles) {
  const git=args=>execFileSync("git",["-C",source,...args],{encoding:"utf8",timeout:10000,maxBuffer:16_000_000,
    stdio:["ignore","pipe","pipe"]});
  assert.equal(git(["remote","get-url","origin"]).trim(),"https://github.com/"+repository+".git");
  assert.equal(realpathSync(git(["rev-parse","--show-toplevel"]).trim()),realpathSync(source));
  assertSourceCheckout(source,sourceCommit);
  const branch=git(["branch","--show-current"]).trim();
  const files=readFiles(source);
  // A public source handoff never includes dotenv, dependencies or private
  // retained receipts. Git cleanliness is checked again before returning.
  assertSourceCheckout(source,sourceCommit);
  return {files,branch,workflowBytes:readFileSync(join(source,".github/workflows/ci.yml"))};
}

export function committedOperatorSource(source, sourceCommit) {
  return committedBoundedOperatorSource(source, sourceCommit, readOperatorSourceFiles);
}
export function committedProfiledCurrentOperatorSource(source, sourceCommit) {
  return committedBoundedOperatorSource(source, sourceCommit, readProfiledCurrentOperatorSourceFiles);
}

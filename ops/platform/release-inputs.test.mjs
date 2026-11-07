import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseInputs } from "./release-inputs.mjs";
import { sourceFixture } from "./release-inputs.fixture.mjs";

const historyPath = (f, repo = "lash-her-frontend") => `/repos/princessdardan/${repo}/actions/workflows/ci.yml/runs?branch=main&head_sha=${f.sha}&per_page=100`;

test("manual dispatch accepts unprotected repositories, records actual protection and verifies exact CI", async () => {
  const f = sourceFixture(), proof = await verifyReleaseInputs(f.options);
  assert.equal(Object.keys(proof.sources).length, 3);
  assert.equal(proof.sources.course.commit, f.sha);
  assert.equal(proof.sources.frontend.branchProtected, true);
  assert.equal(proof.sources.course.branchProtected, false);
  assert.equal(proof.sources.community.sourceProtection, "operator-dispatch-and-ci");
  assert.equal(proof.sourceApproval.mode, "single-operator-dispatch");
  assert.equal(proof.sources.frontend.ciAttempt, 1);
  assert.equal(proof.version, 4);
  assert.equal(proof.contractPhase, "p2");
  assert.equal(proof.phase2ContractManifestSha256, f.context.phase2ContractManifestSha256);
});

test("new source proofs require the P2 hash and every API contract revision before provider access", async () => {
  for (const change of [
    context => { delete context.phase2ContractManifestSha256; },
    context => { context.phase2ContractManifestSha256 = `sha256:${"0".repeat(64)}`; },
    context => { delete context.contractPhase; },
    ...["course", "community", "enrollmentEvent"].map(name => context => { context.phase2ContractRevisions[name] = "b".repeat(40); }),
  ]) {
    const f = sourceFixture(); change(f.context);
    await assert.rejects(verifyReleaseInputs(f.options)); assert.equal(f.calls.length, 0);
  }
});

test("non-operator, fork, PR and substituted frontend refuse before provider access", async () => {
  for (const change of [
    (f) => ({ ...f.context, actorId: "123" }),
    (f) => ({ ...f.context, workflowSha: "b".repeat(40) }),
    (f) => ({ ...f.context, workflowRef: "refs/pull/1/merge" }),
    (f) => ({ ...f.context, repositoryId: "123" }),
    (f) => ({ ...f.context, event: "push" }),
  ]) {
    const f = sourceFixture();
    await assert.rejects(verifyReleaseInputs({ ...f.options, context: change(f) }));
    assert.equal(f.calls.length, 0);
  }
});

test("coordinator must be public, current and dispatched by the sole operator", async () => {
  for (const change of [
    (f) => { f.responses.get("/repos/princessdardan/lash-her-frontend").private = true; },
    (f) => { f.responses.get(`/repos/${f.context.repository}/actions/runs/9001`).triggering_actor.id = 123; },
    (f) => { f.responses.get(`/repos/${f.context.repository}/actions/runs/9001`).head_sha = "b".repeat(40); },
    (f) => { f.responses.get(`/repos/${f.context.repository}/actions/runs/9001`).status = "completed"; },
  ]) { const f = sourceFixture(); change(f); await assert.rejects(verifyReleaseInputs(f.options)); }
});

test("branch protection is optional and operator reruns recheck current CI", async () => {
  const f = sourceFixture();
  f.responses.get("/repos/princessdardan/lash-her-frontend/branches/main").protected = false;
  f.context.runAttempt = "2";
  f.responses.get(`/repos/${f.context.repository}/actions/runs/9001`).run_attempt = 2;
  const proof = await verifyReleaseInputs(f.options);
  assert.equal(proof.sourceApproval.runAttempt, 2);
  assert.equal(proof.sources.frontend.branchProtected, false);
  f.responses.get(historyPath(f)).workflow_runs[0].conclusion = "failure";
  await assert.rejects(verifyReleaseInputs(f.options));
});

test("latest CI failure, skipped jobs, missing scans and forged repository/workflow refuse", async () => {
  for (const mutate of [
    (run) => run.conclusion = "failure", (run) => run.status = "in_progress",
    (run) => run.path = ".github/workflows/other.yml", (run) => run.event = "pull_request",
    (run) => run.head_repository.full_name = "outsider/fork", (run) => run.repository.id = 123,
  ]) {
    const f = sourceFixture(); mutate(f.responses.get(historyPath(f)).workflow_runs[0]);
    await assert.rejects(verifyReleaseInputs(f.options));
  }
  for (const mutate of [(jobs) => jobs.jobs[0].conclusion = "skipped", (jobs) => { jobs.jobs.pop(); jobs.total_count--; }]) {
    const f = sourceFixture(); mutate(f.responses.get("/repos/princessdardan/lash-her-frontend/actions/runs/100/attempts/1/jobs?per_page=100"));
    await assert.rejects(verifyReleaseInputs(f.options));
  }
});

test("source API failures are sanitized and newer failures cannot hide behind old success", async () => {
  const f = sourceFixture();
  await assert.rejects(verifyReleaseInputs({ ...f.options, fetch: async () => { throw new Error("private fixture token"); } }), { message: "Source CI verification unavailable" });
  const history = f.responses.get(historyPath(f)); history.total_count = 2;
  history.workflow_runs.push({ ...history.workflow_runs[0], run_number: 9, conclusion: "failure" });
  await assert.rejects(verifyReleaseInputs(f.options));
});

test("frontend staging coordinates private API main heads without extra API branches", async () => {
  const f = sourceFixture();
  f.context.branch = "staging"; f.context.workflowRef = "refs/heads/staging";
  const repo = "/repos/princessdardan/lash-her-frontend";
  f.responses.get(`${repo}/actions/runs/9001`).head_branch = "staging";
  const head = f.responses.get(`${repo}/branches/main`); head.name = "staging";
  f.responses.set(`${repo}/branches/staging`, head);
  const history = f.responses.get(historyPath(f)); history.workflow_runs[0].head_branch = "staging";
  f.responses.set(`${repo}/actions/workflows/ci.yml/runs?branch=staging&head_sha=${f.sha}&per_page=100`, history);
  const proof = await verifyReleaseInputs(f.options);
  assert.equal(proof.sources.frontend.branch, "staging");
  assert.equal(proof.sources.course.branch, "main");
  assert.equal(proof.sources.community.branch, "main");
  assert.ok(!f.calls.some((path) => /lash-her-(?:course|community)-api\/branches\/staging/u.test(path)));
});

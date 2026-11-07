import { SOURCE_REPOSITORIES, SOURCE_REPOSITORY_IDS, SOURCE_OPERATOR_ID, SOURCE_WORKFLOW, REQUIRED_SOURCE_JOBS } from "./source-policy.mjs";

export function sourceFixture({ revisions = undefined, contractManifestSha256 = `sha256:${"b".repeat(64)}`,
  phase2ContractManifestSha256 = `sha256:${"c".repeat(64)}` } = {}) {
  const now = new Date("2026-11-01T12:00:00.000Z"), sha = revisions?.frontend ?? "a".repeat(40);
  revisions ??= { frontend: sha, course: sha, community: sha };
  const context = { repository: SOURCE_REPOSITORIES.frontend, repositoryId: SOURCE_REPOSITORY_IDS.frontend,
    ownerId: SOURCE_OPERATOR_ID, actorId: SOURCE_OPERATOR_ID, event: "workflow_dispatch", branch: "main", workflowRef: "refs/heads/main",
    workflowSha: sha, runId: "9001", runAttempt: "1", revisions, contractManifestSha256,
    contractPhase: "p2", phase2ContractManifestSha256, phase2ContractRevisions: { course: revisions.course, community: revisions.community, enrollmentEvent: revisions.community } };
  const responses = new Map([["/user", { id: Number(SOURCE_OPERATOR_ID) }]]);
  responses.set(`/repos/${context.repository}/actions/runs/${context.runId}`, { id: Number(context.runId), run_attempt: 1, path: SOURCE_WORKFLOW,
    event: "workflow_dispatch", head_sha: sha, head_branch: "main", actor: { id: Number(SOURCE_OPERATOR_ID) }, triggering_actor: { id: Number(SOURCE_OPERATOR_ID) },
    repository: { full_name: context.repository, id: Number(context.repositoryId) }, head_repository: { full_name: context.repository, id: Number(context.repositoryId) }, status: "in_progress", conclusion: null });
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    const repositoryId = SOURCE_REPOSITORY_IDS[name], ciRunId = "100", sourceSha = revisions[name];
    const workflow = Buffer.from(`name: CI\n# ${repository}\n`);
    responses.set(`/repos/${repository}`, { full_name: repository, id: Number(repositoryId), owner: { id: Number(SOURCE_OPERATOR_ID) }, private: name !== "frontend" });
    responses.set(`/repos/${repository}/branches/main`, { name: "main", protected: name === "frontend", commit: { sha: sourceSha } });
    responses.set(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&head_sha=${sourceSha}&per_page=100`, { total_count: 1, workflow_runs: [{ id: Number(ciRunId), run_number: 8, run_attempt: 1,
      path: ".github/workflows/ci.yml", head_sha: sourceSha, head_branch: "main", event: "push", status: "completed", conclusion: "success",
      repository: { full_name: repository, id: Number(repositoryId) }, head_repository: { full_name: repository, id: Number(repositoryId) } }] });
    responses.set(`/repos/${repository}/actions/runs/${ciRunId}/attempts/1/jobs?per_page=100`, { total_count: REQUIRED_SOURCE_JOBS[name].length,
      jobs: REQUIRED_SOURCE_JOBS[name].map((name) => ({ name, status: "completed", conclusion: "success" })) });
    responses.set(`/repos/${repository}/contents/.github/workflows/ci.yml?ref=${sourceSha}`, { type: "file", encoding: "base64", size: workflow.length,
      content: workflow.toString("base64"), sha: "c".repeat(40) });
  }
  const calls = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url); if (parsed.origin !== "https://api.github.com" || init.redirect !== "error") throw new Error("Fixture destination refused");
    const path = parsed.pathname + parsed.search; calls.push(path);
    const response = responses.get(path);
    return new Response(JSON.stringify(response ?? {}), { status: response ? 200 : 404 });
  };
  return { responses, calls, sha, now, context,
    options: { context, token: "fixture-read-token", now, fetch } };
}

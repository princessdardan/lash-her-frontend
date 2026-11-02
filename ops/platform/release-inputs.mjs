import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contractManifestHash } from "./release.mjs";
import { SOURCE_REPOSITORIES, SOURCE_REPOSITORY_IDS, SOURCE_OPERATOR_ID, SOURCE_WORKFLOW, REQUIRED_SOURCE_JOBS, SOURCE_APPROVAL_MODE, assertSourceContext, isRevision, sourceBranchFor } from "./source-policy.mjs";
import { createHash } from "node:crypto";
const sourceHash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export { SOURCE_REPOSITORIES } from "./source-policy.mjs";

export function githubSourceApi(token, fetch = globalThis.fetch) {
  return async (path) => {
    try {
      if (!token || !path.startsWith("/repos/princessdardan/")) throw new Error();
      return await readBoundedJson(await fetch(`https://api.github.com${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" },
        signal: AbortSignal.timeout(10_000), redirect: "error",
      }));
    } catch { throw new Error("Source CI verification unavailable"); }
  };
}

export async function verifyCoordinatorRun(api, context) {
  assertSourceContext(context);
  const run = await api(`/repos/${SOURCE_REPOSITORIES.frontend}/actions/runs/${context.runId}`);

  if (String(run.id) !== context.runId || String(run.run_attempt) !== context.runAttempt || run.path !== SOURCE_WORKFLOW ||
      run.event !== "workflow_dispatch" || run.head_sha !== context.workflowSha || run.head_branch !== context.branch ||
      String(run.actor?.id) !== SOURCE_OPERATOR_ID || String(run.triggering_actor?.id) !== SOURCE_OPERATOR_ID ||
      run.repository?.full_name !== SOURCE_REPOSITORIES.frontend || String(run.repository?.id) !== SOURCE_REPOSITORY_IDS.frontend ||
      run.head_repository?.full_name !== SOURCE_REPOSITORIES.frontend || String(run.head_repository?.id) !== SOURCE_REPOSITORY_IDS.frontend ||
      run.status !== "in_progress" || run.conclusion !== null) throw new Error("Current operator-dispatched coordinator run required");
  const head = await api(`/repos/${SOURCE_REPOSITORIES.frontend}/branches/${context.branch}`);
  if (head.name !== context.branch || head.commit?.sha !== context.workflowSha) throw new Error("Current coordinator head required");
}

// Exact revisions and current successful CI are required even when native
// branch protections are unavailable. Record protection without requiring it.
export async function inspectSourceRevisions({ branch, revisions, api }) {
  if (!["main", "staging"].includes(branch) || !Object.keys(SOURCE_REPOSITORIES).every((name) => isRevision(revisions?.[name]))) throw new Error("Exact source revisions required");
  const sources = {};
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    const sha = revisions[name], sourceBranch = sourceBranchFor(name, branch);
    const metadata = await api(`/repos/${repository}`);
    if (metadata.full_name !== repository || String(metadata.id) !== SOURCE_REPOSITORY_IDS[name] || String(metadata.owner?.id) !== SOURCE_OPERATOR_ID ||
        metadata.private !== (name !== "frontend")) throw new Error("Pinned source repository identity required");
    const headPath = `/repos/${repository}/branches/${sourceBranch}`;
    const head = await api(headPath);
    if (head.name !== sourceBranch || head.commit?.sha !== sha || typeof head.protected !== "boolean") throw new Error(`${name} source head mismatch`);
    const runs = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=${sourceBranch}&head_sha=${sha}&per_page=100`);
    if (!Array.isArray(runs.workflow_runs) || runs.total_count < 1 || runs.total_count > 100 || runs.total_count !== runs.workflow_runs.length) throw new Error(`${name} CI history incomplete`);
    const run = [...runs.workflow_runs].sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
    if (!Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.run_number) || run.run_number < 1 ||
        !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.path !== ".github/workflows/ci.yml" || run.head_sha !== sha || run.head_branch !== sourceBranch ||
        run.repository?.full_name !== repository || String(run.repository?.id) !== SOURCE_REPOSITORY_IDS[name] ||
        run.head_repository?.full_name !== repository || String(run.head_repository?.id) !== SOURCE_REPOSITORY_IDS[name] ||
        !["push", "workflow_dispatch"].includes(run.event) || run.status !== "completed" || run.conclusion !== "success") throw new Error(`${name} current CI run must pass`);
    const jobs = await api(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100 ||
        !REQUIRED_SOURCE_JOBS[name].every((required) => jobs.jobs.some((job) => job.name === required)) ||
        !jobs.jobs.every((job) => job.status === "completed" && job.conclusion === "success")) throw new Error(`${name} required jobs must all pass`);
    const workflow = await api(`/repos/${repository}/contents/.github/workflows/ci.yml?ref=${sha}`);
    if (workflow.type !== "file" || workflow.encoding !== "base64" || !Number.isSafeInteger(workflow.size) || workflow.size < 1 || workflow.size > 262_144 || typeof workflow.content !== "string") throw new Error("Pinned CI workflow required");
    const encoded = workflow.content.replace(/\n/gu, ""), bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== workflow.size || bytes.toString("base64") !== encoded) throw new Error("Pinned CI workflow required");
    const finalHead = await api(headPath);
    if (finalHead.commit?.sha !== sha || finalHead.protected !== head.protected) throw new Error(`${name} source moved during verification`);
    sources[name] = { repository: `https://github.com/${repository}.git`, repositoryId: SOURCE_REPOSITORY_IDS[name], commit: sha,
      requiredChecks: "passed", branch: sourceBranch, branchProtected: head.protected,
      sourceProtection: head.protected ? "native-branch-protection" : "operator-dispatch-and-ci",
      ciRunId: String(run.id), ciAttempt: run.run_attempt, ciWorkflowSha256: sourceHash(bytes),
      ciUrl: `https://github.com/${repository}/actions/runs/${run.id}` };
  }
  return sources;
}

export async function verifyReleaseInputs({ context, token, fetch = globalThis.fetch, now = new Date() }) {
  // These checks use GitHub's authenticated API and ordinary workflow context.
  // They are not independent cryptographic approval of repository-controlled code.
  assertSourceContext(context);
  const api = githubSourceApi(token, fetch);
  await verifyCoordinatorRun(api, context);
  const sources = await inspectSourceRevisions({ branch: context.branch, revisions: context.revisions, api });
  const checkedAt = now.toISOString();
  return { version: 3, checkedAt, workflowSha: context.workflowSha, workflowRef: context.workflowRef,
    contractManifestSha256: context.contractManifestSha256, sources,
    sourceApproval: { mode: SOURCE_APPROVAL_MODE, operatorGithubUserId: SOURCE_OPERATOR_ID,
      runId: context.runId, runAttempt: Number(context.runAttempt), verifiedAt: checkedAt } };
}

async function readBoundedJson(response, maximum = 2 * 1024 * 1024) {
  if (!response.ok || !response.body) throw new Error("Bounded JSON response required");
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > maximum) throw new Error("JSON response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function sourceContextFromEnvironment(environment = process.env) {
  return { repository: environment.GITHUB_REPOSITORY, repositoryId: environment.GITHUB_REPOSITORY_ID,
    ownerId: environment.GITHUB_REPOSITORY_OWNER_ID, actorId: environment.GITHUB_ACTOR_ID, event: environment.GITHUB_EVENT_NAME,
    branch: environment.SOURCE_BRANCH, workflowRef: environment.GITHUB_REF, workflowSha: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT,
    revisions: { frontend: environment.FRONTEND_REVISION, course: environment.COURSE_REVISION, community: environment.COMMUNITY_REVISION },
    contractManifestSha256: contractManifestHash() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith("--")) throw new Error("Usage");
    const context = sourceContextFromEnvironment();
    const proof = await verifyReleaseInputs({ context, token: process.env.SOURCE_READ_TOKEN });
    writeFileSync(process.argv[2], JSON.stringify(proof, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stdout.write("Operator dispatch, exact source revisions and current CI verified\n");
  } catch { process.stderr.write("Source verification refused\n"); process.exitCode = 1; }
}

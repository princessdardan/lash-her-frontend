export const SOURCE_REPOSITORIES = Object.freeze({
  frontend: "princessdardan/lash-her-frontend",
  course: "princessdardan/lash-her-course-api",
  community: "princessdardan/lash-her-community-api",
});
export const SOURCE_REPOSITORY_IDS = Object.freeze({ frontend: "1114139712", course: "1296925924", community: "1332194577" });
export const SOURCE_OPERATOR_ID = "8996309";
export const SOURCE_WORKFLOW = ".github/workflows/platform-artifacts.yml";
export const REQUIRED_SOURCE_JOBS = Object.freeze({
  frontend: ["gateway-and-platform", "quality-and-unit", "database", "audit", "build", "browser", "browser (chromium)", "browser (firefox)", "browser (webkit)"],
  course: ["quality", "postgres", "containers"],
  community: ["quality", "postgres", "containers"],
});
export const isRevision = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) && !/^0+$/u.test(value);

// GitHub's authenticated manual dispatch is the source-build approval.
// This policy does not claim independence from a compromised GitHub account.
export const SOURCE_APPROVAL_MODE = "single-operator-dispatch";
export function assertSourceContext(context) {
  const id = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value);
  if (context?.repository !== SOURCE_REPOSITORIES.frontend || context.repositoryId !== SOURCE_REPOSITORY_IDS.frontend ||
      context.ownerId !== SOURCE_OPERATOR_ID || context.actorId !== SOURCE_OPERATOR_ID || context.event !== "workflow_dispatch" ||
      !["main", "staging"].includes(context.branch) || context.workflowRef !== `refs/heads/${context.branch}` ||
      !isRevision(context.workflowSha) || context.revisions?.frontend !== context.workflowSha ||
      !Object.keys(SOURCE_REPOSITORIES).every((name) => isRevision(context.revisions?.[name])) ||
      !id(context.runId) || !id(context.runAttempt) ||
      !/^sha256:[0-9a-f]{64}$/u.test(context.contractManifestSha256 ?? "") || /^sha256:0+$/u.test(context.contractManifestSha256)) {
    throw new Error("Canonical operator-dispatched source context required");
  }
}

// Private API releases use their existing main branch. Frontend staging is a
// separate coordinator choice, not a reason to maintain extra API branches.
export function sourceBranchFor(name, coordinatorBranch) {
  if (!Object.hasOwn(SOURCE_REPOSITORIES, name) || !["main", "staging"].includes(coordinatorBranch)) throw new Error("Source branch selection refused");
  return name === "frontend" ? coordinatorBranch : "main";
}

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

const workflowPath = ".github/workflows/ci.yml";
const jobNames = { frontend: "frontend-operator-migrations", gateway: "gateway-and-platform" };
const guard = "${{ steps.image-inputs.outputs.changed == 'true' }}";
const retainGuard = "${{ !cancelled() && steps.image-inputs.outputs.changed == 'true' }}";
const frontendDirectories = ["ops/platform/", "ops/staging/", "ops/gateway/runtime/", "drizzle/", "contracts/api-integration/", "vendor/"];
const frontendFiles = new Set([
  "package.json", "package-lock.json", "tsconfig.json",
  "src/lib/private-db/migration-lineage.ts",
  "scripts/api-contract-tools.mjs", "scripts/api-contract-compatibility-review.mjs", "scripts/register-server-only-test.mjs",
  // Gateway inputs mounted by the frontend PostgreSQL fixtures.
  "ops/gateway/routes.json", "ops/gateway/assessment-attempt.mjs", "ops/gateway/lesson-resume-position.mjs",
  "ops/gateway/staging-owner-authoring.mjs", "ops/gateway/staging-owner-authoring-fixture.json",
  "ops/gateway/staging-review-community.mjs", "ops/gateway/staging-review-notifications.mjs",
]);

function imageInput(target, path) {
  if (target === "frontend") {
    return frontendFiles.has(path) || frontendDirectories.some(directory => path.startsWith(directory));
  }
  return path.startsWith("ops/gateway/") && path !== "ops/gateway/README.md" && !/^ops\/gateway\/[^/]+\.test\.mjs$/u.test(path);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function changedPaths(eventName, event) {
  const pr = eventName === "pull_request";
  const base = pr ? event.pull_request?.base?.sha : event.before;
  const head = pr ? event.pull_request?.head?.sha : event.after;
  const revision = value => /^[0-9a-f]{40}$/u.test(value ?? "") && !/^0+$/u.test(value);
  if (!revision(base) || !revision(head)) return null;
  try {
    // PRs compare the submitted changes with their merge base. Pushes compare
    // the two branch states, including multi-commit pushes and merge commits.
    const start = pr ? git("merge-base", base, head).trim() : base;
    const paths = git("diff", "--name-only", "--no-renames", "-z", start, head, "--").split("\0").filter(Boolean);
    return { start, head, paths };
  } catch {
    return null;
  }
}

function imageConfiguration(target, revision) {
  const workflow = parse(git("show", `${revision}:${workflowPath}`));
  const { steps, ...job } = workflow.jobs[jobNames[target]];
  const buildx = steps.findIndex(step => step.uses?.startsWith("docker/setup-buildx-action@"));
  if (buildx < 0) throw new Error("Expected image build setup in CI");
  const imageSteps = steps.filter((step, index) => step.id !== "image-inputs" &&
    (target === "frontend" || index >= buildx || step.uses?.startsWith("docker/setup-docker-action@")));
  const { defaults, env, permissions } = workflow;
  return { defaults, env, permissions, job, steps: imageSteps.map(step => {
    // Selection guards do not change the build or scan configuration.
    const { if: condition, ...definition } = step;
    if (!condition || condition === guard) return definition;
    return { ...definition, if: condition === retainGuard ? "${{ !cancelled() }}" : condition };
  }) };
}

function qualificationReason(target, eventName, event) {
  if (eventName === "workflow_dispatch") return "Explicit release qualification";
  const diff = changedPaths(eventName, event);
  if (!diff) return "Change range unavailable";
  if (diff.paths.some(path => imageInput(target, path))) return "Image or qualification fixture inputs changed";
  if (diff.paths.includes(workflowPath)) {
    try {
      if (!isDeepStrictEqual(imageConfiguration(target, diff.start), imageConfiguration(target, diff.head))) {
        return "Image qualification configuration changed";
      }
    } catch {
      return "Prior image qualification configuration unavailable";
    }
  }
  return null;
}

const target = process.argv[2];
if (!Object.hasOwn(jobNames, target)) throw new Error("Expected frontend or gateway image target");
const eventName = process.env.GITHUB_EVENT_NAME;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const reason = qualificationReason(target, eventName, event);
appendFileSync(process.env.GITHUB_OUTPUT, `changed=${Boolean(reason)}\n`);
console.log(reason ? `${jobNames[target]}: ${reason}.` : `${jobNames[target]}: image qualification skipped because its inputs did not change.`);

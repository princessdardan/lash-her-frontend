import { readFile } from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = "test-results/playwright-results.json";
const REQUIRED_PROJECTS = ["chromium", "firefox", "webkit"];
const REQUIRED_SCENARIOS = [
  [
    "admin-calendar-self-service.spec.ts",
    "employee completes OAuth and assigns the persisted calendar as busy-only",
  ],
  [
    "admin-calendar-self-service.spec.ts",
    "owner cannot disable a calendar assignment that receives bookings",
  ],
  [
    "admin-operations.spec.ts",
    "renders every actionable queue with versioned evidence state",
  ],
  [
    "admin-operations.spec.ts",
    "shows the exact step-up action and target without executing it",
  ],
  [
    "checkout.spec.ts",
    "handles checkout initialization failure without clearing cart",
  ],
  [
    "checkout.spec.ts",
    "forwards successful Helcim events to validation and routes to confirmation",
  ],
  [
    "checkout.spec.ts",
    "keeps cart visible when Helcim reports a declined payment",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "enabled Canada checkout completes real quote and payment operation polling",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "enabled manual pickup completes real payment initialization and risk clearance",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "address scanner prefetch is non-consuming and explicit exchange submits a high-risk incident",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "replacement inventory fallback route reserves a complete typed full refund",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "replacement attestation prepares and adopts a purchasable labeled generation",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "address cancellation requires exact owner step-up and preserves the active generation",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "admin operation mutation rejects a stale case version and requires conflict refresh",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "supplemental offer exchange is explicit and a late payment after pickup is reserved for refund",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "enabled U.S. checkout snapshots DDU terms and completes certified payment",
  ],
  [
    "commerce-enabled-workflows.spec.ts",
    "tracking exception recovers to delivery, sends durable emails, and records the provider return",
  ],
  [
    "service-booking-payment-page.spec.ts",
    "service booking redirects to dedicated payment page and mounts Square container",
  ],
];

const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
const executions = [];
collectExecutions(report.suites ?? [], executions);

for (const project of REQUIRED_PROJECTS) {
  for (const [spec, title] of REQUIRED_SCENARIOS) {
    const execution = executions.find(
      (candidate) =>
        candidate.project === project &&
        path.basename(candidate.file) === spec &&
        candidate.title === title,
    );
    if (!execution) {
      throw new Error(
        `Required Playwright scenario was not run in ${project}: ${spec} — ${title}`,
      );
    }
    if (execution.status !== "passed") {
      throw new Error(
        `Required Playwright scenario did not pass in ${project} (${execution.status}): ${spec} — ${title}`,
      );
    }
  }
}

console.info(
  `[playwright-coverage] Verified ${REQUIRED_SCENARIOS.length} required scenarios passed without skips in each of ${REQUIRED_PROJECTS.length} browser projects.`,
);

function collectExecutions(suites, output, inheritedFile = "") {
  for (const suite of suites) {
    const file = suite.file || inheritedFile;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const statuses = (test.results ?? []).map((result) => result.status);
        output.push({
          file: spec.file || file,
          project: test.projectName,
          status: statuses.includes("passed")
            ? "passed"
            : statuses.at(-1) || test.status || "not-run",
          title: spec.title,
        });
      }
    }
    collectExecutions(suite.suites ?? [], output, file);
  }
}

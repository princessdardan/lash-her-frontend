import { readFile } from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = "test-results/playwright-results.json";
const REQUIRED_PROJECTS = ["chromium", "firefox", "webkit"];
// NOTE: The Helcim->Square payment migration retired the obsolete Helcim
// `checkout.spec.ts` (3 scenarios) and `commerce-enabled-workflows.spec.ts`
// (10 scenarios) suites, which drove the deleted `/api/checkout/validate-payment`
// flow. Their entries were removed from this required list. The remaining
// scenarios (admin self-service, admin operations, and the Square service-booking
// payment page) still run and stay gated. When the Square commerce E2E harness
// lands, add its critical scenarios here.
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

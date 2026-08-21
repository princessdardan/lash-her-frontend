import { readFile } from "node:fs/promises";
import path from "node:path";

const REPORT_PATH = "coverage/critical/coverage-summary.json";

// Per-file branch floors prevent a well-tested small helper from hiding an
// untested payment, refund, retention, token, or job-claiming implementation.
// Raise these floors as additional failure paths are added to the test matrix.
const REQUIRED_BRANCH_COVERAGE = new Map([
  // product-payment-finalizer.ts was the Helcim product finalizer, deleted in
  // the Helcim->Square cutover (commit aa59555); its Square replacements
  // (square-product-finalizer.ts et al.) carry their own DB coverage.
  ["src/lib/commerce/product-payment-operation.ts", 70],
  ["src/lib/private-db/shipping-retention.ts", 65],
  ["src/lib/shipping/customer-decisions.ts", 55],
  ["src/lib/shipping/customer-refunds.ts", 67],
  ["src/lib/shipping/operation-worker.ts", 52],
  ["src/lib/shipping/policy-jobs.ts", 70],
  ["src/lib/shipping/quote-token.ts", 80],
  ["src/lib/shipping/risk-review.ts", 45],
  ["src/lib/shipping/shipment-store.ts", 57],
  ["src/lib/shipping/status.ts", 78],
]);

const report = JSON.parse(await readFile(REPORT_PATH, "utf8"));
const normalizedEntries = new Map(
  Object.entries(report)
    .filter(([file]) => file !== "total")
    .map(([file, metrics]) => [normalizePath(file), metrics]),
);
const failures = [];

for (const [file, minimum] of REQUIRED_BRANCH_COVERAGE) {
  const metrics = normalizedEntries.get(file);
  if (!metrics) {
    failures.push(`${file}: missing from source coverage report`);
    continue;
  }
  const actual = Number(metrics.branches?.pct);
  if (!Number.isFinite(actual) || actual < minimum) {
    failures.push(`${file}: ${actual}% branches, requires ${minimum}%`);
  }
}

if (failures.length > 0) {
  throw new Error(`Critical source coverage failed:\n${failures.join("\n")}`);
}

console.info(
  `[critical-coverage] Verified real branch coverage floors for ${REQUIRED_BRANCH_COVERAGE.size} critical source modules.`,
);

function normalizePath(file) {
  const absolute = path.resolve(file);
  return path.relative(process.cwd(), absolute).split(path.sep).join("/");
}

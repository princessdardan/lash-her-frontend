import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const SERVER_ONLY_TEST_FILES = new Set([
  "src/app/api/cron/customer-email-outbox/route.test.ts",
  "src/app/api/admin/shipping/operation-reviews/handler.test.ts",
  "src/app/api/admin/shipping/package-profiles/handler.test.ts",
  "src/app/(site)/orders/payment-offer/interstitial/route.test.ts",
  "src/lib/admin/implicit-staff-provider.test.ts",
  "src/lib/admin/square-team-selection.test.ts",
  "src/lib/admin/step-up-proof.test.ts",
  "src/lib/booking/operations/model-mode.test.ts",
  "src/lib/booking/operations/public-offerings.test.ts",
  "src/lib/booking/operations/sanity-service-link.test.ts",
  "src/lib/booking/square-team-client.test.ts",
  "src/lib/commerce/order-store-supplemental-reference.test.ts",
  "src/lib/commerce/product-stock-abandoned-sweep.test.ts",
  "src/lib/commerce/supplemental-payment-offer-link-handler.test.ts",
  "src/lib/marketing-campaign/campaign-email-html.test.ts",
  "src/lib/shipping/address-approval-step-up.test.ts",
  "src/lib/shipping/address-changes.test.ts",
  "src/lib/shipping/cases.test.ts",
  "src/lib/shipping/chitchats-client.test.ts",
  "src/lib/shipping/config.test.ts",
  "src/lib/shipping/configured-owner.test.ts",
  "src/lib/shipping/configured-quote-context.test.ts",
  "src/lib/shipping/manual-checkout-readiness.test.ts",
  "src/lib/shipping/operation-worker.test.ts",
  "src/lib/shipping/package-profiles.test.ts",
  "src/lib/shipping/p10-termination.test.ts",
  "src/lib/shipping/policy-mode.test.ts",
  "src/lib/shipping/policy-worker.test.ts",
  "src/lib/shipping/prepare-quote.test.ts",
  "src/lib/shipping/quote-token.test.ts",
  "src/lib/shipping/shipment-store.test.ts",
  "src/lib/structured-data.test.ts",
]);

const DB_TEST_FILES = new Set([
  "src/data/commerce-e2e-catalog-fixture.test.ts",
  "src/lib/admin/step-up-proof.db.test.ts",
  "src/lib/admin/operations-workspaces.db.test.ts",
  "src/lib/commerce/customer-email-outbox.db.test.ts",
  "src/lib/commerce/product-order-creation.db.test.ts",
  "src/lib/commerce/product-stock-abandoned-sweep.db.test.ts",
  "src/lib/commerce/product-stock-store.db.test.ts",
  "src/lib/commerce/product-stock-sync.db.test.ts",
  "src/lib/commerce/late-capture-refund.db.test.ts",
  "src/lib/commerce/square-obligation-reconciliation.db.test.ts",
  "src/lib/commerce/square-product-finalizer.db.test.ts",
  "src/lib/commerce/square-training-card-finalizer.db.test.ts",
  "src/lib/commerce/square-supplemental-finalizer.db.test.ts",
  "src/lib/commerce/supplemental-payment-offers.db.test.ts",
  "src/lib/admin/employee-attribution-analytics.db.test.ts",
  "src/lib/admin/implicit-staff-provider.db.test.ts",
  "src/lib/admin/offering-resource-admin.db.test.ts",
  "src/lib/admin/service-offering-ownership-invariant.db.test.ts",
  "src/lib/admin/square-attribution-invariant.db.test.ts",
  "src/lib/booking/payments/service-reconciliation-monitor.test.ts",
  "src/lib/private-db/appointment-finalization-repository.db.test.ts",
  "src/lib/private-db/booking-legacy-import-repository.db.test.ts",
  "src/lib/private-db/legacy-operational-cutover-repository.db.test.ts",
  "src/lib/private-db/booking-public-read-repositories.db.test.ts",
  "src/lib/private-db/booking-reservation-repository.db.test.ts",
  "src/lib/private-db/calendar-connection-repository.db.test.ts",
  "src/lib/private-db/card-on-file-repository.db.test.ts",
  "src/lib/private-db/shipping-retention.db.test.ts",
  "src/lib/shipping/address-payment-revocation.db.test.ts",
  "src/lib/shipping/address-service-decisions.db.test.ts",
  "src/lib/shipping/address-signature-decisions.db.test.ts",
  "src/lib/shipping/customer-decisions.db.test.ts",
  "src/lib/shipping/customer-refunds.db.test.ts",
  "src/lib/shipping/address-risk.db.test.ts",
  "src/lib/shipping/case-refund-remedy.db.test.ts",
  "src/lib/shipping/case-resolution-invariants.db.test.ts",
  "src/lib/shipping/cases-concurrency.db.test.ts",
  "src/lib/shipping/frozen-activation.db.test.ts",
  "src/lib/shipping/operation-worker.db.test.ts",
  "src/lib/shipping/operations-actions.db.test.ts",
  "src/lib/shipping/package-profiles.db.test.ts",
  "src/lib/shipping/policy-jobs.db.test.ts",
  "src/lib/shipping/policy-p10.db.test.ts",
  "src/lib/shipping/provider-event-ordering.db.test.ts",
  "src/lib/shipping/quote-reuse.db.test.ts",
  "src/lib/shipping/risk-review.db.test.ts",
  "src/lib/shipping/shipment-operations.db.test.ts",
  "src/lib/shipping/shipment-store.db.test.ts",
  "src/lib/shipping/shipment-retry-exhaustion.db.test.ts",
  "src/lib/shipping/shipment-variance-refund-gate.db.test.ts",
]);

const mode = process.argv[2] ?? "--no-db";
if (!new Set(["--no-db", "--db-only"]).has(mode)) {
  throw new Error(`Unsupported test mode: ${mode}`);
}

const testFiles = (await listTestFiles("src")).sort();
const registeredTestFiles = new Set([
  ...SERVER_ONLY_TEST_FILES,
  ...DB_TEST_FILES,
]);
const missingRegisteredFiles = [...registeredTestFiles].filter(
  (file) => !testFiles.includes(file),
);

if (missingRegisteredFiles.length > 0) {
  throw new Error(
    `Registered unit test file list is stale: ${missingRegisteredFiles.join(", ")}`,
  );
}

const dbAwareTestFiles = (
  await Promise.all(
    testFiles.map(async (file) => ({
      file,
      usesTestDatabase: (await readFile(file, "utf8")).includes(
        "TEST_DATABASE_URL",
      ),
    })),
  )
)
  .filter(({ usesTestDatabase }) => usesTestDatabase)
  .map(({ file }) => file);
const unregisteredDbTestFiles = dbAwareTestFiles.filter(
  (file) => !DB_TEST_FILES.has(file),
);

if (unregisteredDbTestFiles.length > 0) {
  throw new Error(
    `DB unit test files must be registered in DB_TEST_FILES: ${unregisteredDbTestFiles.join(", ")}`,
  );
}

const incorrectlyRegisteredDbTestFiles = [...DB_TEST_FILES].filter(
  (file) => !dbAwareTestFiles.includes(file),
);

if (incorrectlyRegisteredDbTestFiles.length > 0) {
  throw new Error(
    `DB_TEST_FILES entries must reference TEST_DATABASE_URL: ${incorrectlyRegisteredDbTestFiles.join(", ")}`,
  );
}

const regularTestFiles = testFiles.filter(
  (file) => !SERVER_ONLY_TEST_FILES.has(file) && !DB_TEST_FILES.has(file),
);
const serverOnlyTestFiles = testFiles.filter((file) =>
  SERVER_ONLY_TEST_FILES.has(file),
);
const dbTestFiles = testFiles.filter((file) => DB_TEST_FILES.has(file));

if (mode === "--no-db") {
  runTests(regularTestFiles, []);
  runTests(serverOnlyTestFiles, [
    "--import",
    "./scripts/register-server-only-test.mjs",
  ]);
} else {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is required for the authoritative DB unit test suite",
    );
  }

  runTests(dbTestFiles, ["--conditions=react-server", "--test-concurrency=1"]);
}

async function listTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function runTests(files, nodeOptions) {
  if (files.length === 0) {
    return;
  }
  const needsServerTestEnvironment =
    mode === "--db-only" ||
    nodeOptions.includes("./scripts/register-server-only-test.mjs");

  const env = needsServerTestEnvironment
    ? {
        ...process.env,
        NEXT_PUBLIC_SANITY_DATASET:
          process.env.NEXT_PUBLIC_SANITY_DATASET ?? "test-dataset",
        NEXT_PUBLIC_SANITY_PROJECT_ID:
          process.env.NEXT_PUBLIC_SANITY_PROJECT_ID ?? "test-project",
      }
    : { ...process.env };

  // The DB tests run under `--conditions=react-server` (so `server-only`
  // resolves to its no-op stub). That condition also forces React 18 onto its
  // `react-server` entry, which throws "not yet supported outside of
  // experimental channels" the moment a module under test transitively imports
  // React. Register the React-compat resolve hook via NODE_OPTIONS — not a
  // command-line flag — so it also reaches each *.db.test.ts's inner
  // `execFileSync` subprocess (which inherits this env), keeping React on its
  // normal entry while `server-only` stays stubbed by the condition.
  if (nodeOptions.includes("--conditions=react-server")) {
    const reactCompatHook = pathToFileURL(
      path.resolve("scripts/register-react-server-db-compat.mjs"),
    ).href;
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${reactCompatHook}`]
      .filter(Boolean)
      .join(" ");
  }

  const result = spawnSync(
    process.execPath,
    [...nodeOptions, "--import", "tsx", "--test", ...files],
    {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

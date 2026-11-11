import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const SERVER_ONLY_TEST_FILES = new Set([
  "src/lib/security/checkout-abuse-control.test.ts",
  "src/app/api/internal/release-probe/handler.test.ts",
  "src/app/api/internal/release-scheduler-probe/handler.test.ts",
  "src/lib/api-integration/phase2-gateway-smoke.test.ts",
  "src/lib/writer-admission/google-binding-probe.test.ts",
  "src/lib/admin/read-operation.test.ts",
  "src/lib/admin/calendar-discovery-result.test.ts",
  "src/lib/writer-admission/square-binding-probe.test.ts",
  "src/lib/course-authoring/page-data.test.ts",
  "src/lib/course-support/manual-grant-handler.test.ts",
  "src/lib/course-support/manual-revoke-handler.test.ts",
  "src/lib/admin/authorization-operation.test.ts",
  "src/lib/admin/auth-callback-admission.test.ts",
  "src/lib/admin/auth-route-admission.test.ts",
  "src/lib/writer-admission/resend-binding-probe.test.ts",
  "src/lib/customer-lifecycle/worker.test.ts",
  "src/lib/customer-lifecycle/cron.test.ts",
  "src/lib/customer-lifecycle/native-trace.test.ts",
  "src/lib/learning/rollout.test.ts",
  "src/lib/api-integration/course-admin-handler.test.ts",
  "src/lib/writer-admission/shipping-execution.test.ts",
  "src/lib/api-integration/request-origin.test.ts",
  "src/lib/customer-lifecycle/handler.test.ts",
  "src/lib/api-integration/lifecycle-service-jwt.test.ts",
  "src/lib/api-integration/account-lifecycle-client.test.ts",
  "src/lib/api-integration/course-client.test.ts",
  "src/lib/api-integration/application-jwt.test.ts",
  "src/lib/writer-admission/public-forms.test.ts",
  "src/lib/writer-admission/remaining-workers.test.ts",
  "src/lib/writer-admission/admin-identity.test.ts",
  "src/lib/writer-admission/admin-interactive.test.ts",
  "src/lib/writer-admission/booking-interactive.test.ts",
  "src/lib/customer-auth/handler.test.ts",
  "src/lib/writer-admission/shipping-preparation.test.ts",
  "src/lib/writer-admission/product-refund-worker.test.ts",
  "src/lib/writer-admission/stock-sweep.test.ts",
  "src/lib/writer-admission/customer-email-outbox.test.ts",
  "src/lib/writer-admission/service-reconciliation.test.ts",
  "src/lib/writer-admission/training-split-reconciliation.test.ts",
  "src/lib/writer-admission/commerce-capture.test.ts",
  "src/lib/writer-admission/booking-outcome.test.ts",
  "src/app/api/booking/square/return/route.test.ts",
  "src/app/api/booking/oauth/start/route.test.ts",
  "src/lib/writer-admission/runtime.test.ts",
  "src/lib/writer-admission/square-refund.test.ts",
  "src/lib/writer-admission/square-invoice.test.ts",
  "src/lib/writer-admission/square-product.test.ts",
  "src/lib/writer-admission/square-training-card.test.ts",
  "src/lib/writer-admission/square-training-split.test.ts",
  "src/lib/writer-admission/square-no-show.test.ts",
  "src/lib/writer-admission/square-operational.test.ts",
  "src/lib/writer-admission/square-booking.test.ts",
  "src/lib/writer-admission/consent-recovery.test.ts",
  "src/lib/writer-admission/training.test.ts",
  "src/lib/writer-admission/manual-scripts.test.ts",
  "src/lib/api-integration/gateway-transport.test.ts",
  "src/lib/api-integration/rollout-flags.test.ts",
  "src/app/api/admin/shipping/label-handler.test.ts",
  "src/lib/api-integration/response-validation.test.ts",
  "src/lib/env/application-environment.test.ts",
  "src/lib/env/staging-email-policy.test.ts",
  "src/lib/highlevel/highlevel.test.ts",
  "src/app/actions/form.test.ts",
  "src/app/api/marketing/unsubscribe/handler.test.ts",
  "src/app/api/cron/customer-email-outbox/route.test.ts",
  "src/app/api/admin/shipping/package-profiles/handler.test.ts",
  "src/lib/admin/implicit-staff-provider.test.ts",
  "src/lib/admin/square-team-selection.test.ts",
  "src/lib/admin/step-up-proof.test.ts",
  "src/lib/booking/operations/model-mode.test.ts",
  "src/lib/booking/operations/public-offerings.test.ts",
  "src/lib/booking/operations/sanity-service-link.test.ts",
  "src/lib/booking/square-team-client.test.ts",
  "src/lib/commerce/product-stock-abandoned-sweep.test.ts",
  "src/lib/commerce/customer-email-outbox-worker.test.ts",
  "src/lib/contact-popup/signup-offer.test.ts",
  "src/lib/marketing-campaign/campaign-email-html.test.ts",
  "src/lib/marketing-contact/unsubscribe-token.test.ts",
  "src/lib/shipping/chitchats-client.test.ts",
  "src/lib/shipping/config.test.ts",
  "src/lib/shipping/policy-alerts.test.ts",
  "src/lib/shipping/configured-owner.test.ts",
  "src/lib/shipping/configured-quote-context.test.ts",
  "src/lib/shipping/manual-checkout-readiness.test.ts",
  "src/lib/shipping/operation-worker.test.ts",
  "src/lib/shipping/package-profiles.test.ts",
  "src/lib/shipping/prepare-quote.test.ts",
  "src/lib/shipping/quote-token.test.ts",
  "src/lib/shipping/shipment-store.test.ts",
  "src/lib/structured-data.test.ts",
]);

const DB_TEST_FILES = new Set([
  "src/lib/customer-lifecycle/faults.db.test.ts",
  "src/lib/customer-lifecycle/store.db.test.ts",
  "src/lib/customer-auth/store.db.test.ts",
  "src/lib/customer-auth/receipts.db.test.ts",
  "src/lib/customer-auth/session-issuance.db.test.ts",
  "src/lib/highlevel/retention.db.test.ts",
  "src/lib/highlevel/highlevel.db.test.ts",
  "src/lib/courses/signup.db.test.ts",
  "src/data/commerce-e2e-catalog-fixture.test.ts",
  "src/lib/admin/step-up-proof.db.test.ts",
  "src/lib/admin/operations-workspaces.db.test.ts",
  "src/lib/commerce/customer-email-outbox.db.test.ts",
  "src/lib/commerce/product-order-creation.db.test.ts",
  "src/lib/commerce/product-stock-abandoned-sweep.db.test.ts",
  "src/lib/commerce/product-stock-store.db.test.ts",
  "src/lib/commerce/product-stock-sync.db.test.ts",
  "src/lib/commerce/late-capture-refund.db.test.ts",
  "src/lib/commerce/square-product-finalizer.db.test.ts",
  "src/lib/commerce/square-training-card-finalizer.db.test.ts",
  "src/lib/commerce/square-training-split.db.test.ts",
  "src/lib/commerce/training-square-invoice-publication.db.test.ts",
  "src/lib/admin/employee-attribution-analytics.db.test.ts",
  "src/lib/marketing-contact/marketing-contact-store.db.test.ts",
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
  "src/lib/shipping/customer-refunds.db.test.ts",
  "src/lib/shipping/frozen-activation.db.test.ts",
  "src/lib/shipping/operation-worker.db.test.ts",
  "src/lib/shipping/package-profiles.db.test.ts",
  "src/lib/shipping/provider-event-ordering.db.test.ts",
  "src/lib/shipping/quote-reuse.db.test.ts",
  "src/lib/shipping/shipment-operations.db.test.ts",
  "src/lib/shipping/shipment-store.db.test.ts",
  "src/lib/shipping/shipment-retry-exhaustion.db.test.ts",
  "src/lib/shipping/shipment-variance-refund-gate.db.test.ts",
]);

const mode = process.argv[2] ?? "--no-db";
// These tests pass synthetic environment records to pure policy functions;
// mentioning TEST_DATABASE_URL does not open or mutate a database.
const PURE_ENV_POLICY_TEST_FILES = new Set([
  "src/lib/private-db/isolated-commerce-fixture.test.ts",
]);
if (!new Set(["--no-db", "--db-only"]).has(mode)) {
  throw new Error(`Unsupported test mode: ${mode}`);
}

const testDatabaseUrl = mode === "--db-only" ? requireIsolatedTestDatabaseUrl() : undefined;

const testFiles = (await listTestFiles("src")).sort();
const registeredTestFiles = new Set([
  ...SERVER_ONLY_TEST_FILES,
  ...DB_TEST_FILES,
  ...PURE_ENV_POLICY_TEST_FILES,
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
      usesTestDatabase: !PURE_ENV_POLICY_TEST_FILES.has(file) && (await readFile(file, "utf8")).includes(
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
  runTests(dbTestFiles, ["--conditions=react-server", "--test-concurrency=1"]);
}

function requireIsolatedTestDatabaseUrl() {
  const refuse = () => {
    throw new Error("DB unit tests require TEST_DATABASE_URL to name a disposable loopback PostgreSQL database");
  };
  const releaseEnvironment = [
    process.env.APP_ENV,
    process.env.VERCEL_ENV,
    process.env.VERCEL_TARGET_ENV,
  ].some(value => value === "staging" || value === "production");
  if (releaseEnvironment || !process.env.TEST_DATABASE_URL) refuse();

  let url;
  try {
    url = new URL(process.env.TEST_DATABASE_URL);
  } catch {
    refuse();
  }
  const options = [...url.searchParams.keys()];
  const database = url.pathname.slice(1).toLowerCase();
  const labels = database.split(/[-_]+/u);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase()) ||
    !/^\/[a-zA-Z0-9_-]{1,63}$/u.test(url.pathname) ||
    !labels.some(label => ["test", "ci", "integration", "audit", "roundtrip", "scratch", "owned", "e2e"].includes(label)) ||
    labels.some(label => ["prod", "production", "staging", "stage", "live", "main"].includes(label)) ||
    options.some(key => !["sslmode", "application_name", "connect_timeout", "sslrootcert", "sslcert", "sslkey"].includes(key)) ||
    new Set(options).size !== options.length || url.hash) {
    refuse();
  }
  // Bind every child to the checked test target, independent of an ambient PGPORT.
  if (!url.port) url.port = "5432";
  return url.href;
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

  if (testDatabaseUrl) {
    env.TEST_DATABASE_URL = testDatabaseUrl;
    env.DATABASE_URL = testDatabaseUrl;
  }

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

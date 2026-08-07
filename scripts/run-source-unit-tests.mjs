import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SERVER_ONLY_TEST_FILES = new Set([
  "src/lib/academy/course-api-adapter.test.ts",
  "src/lib/admin/implicit-staff-provider.test.ts",
  "src/lib/admin/square-team-selection.test.ts",
  "src/lib/booking/operations/model-mode.test.ts",
  "src/lib/booking/operations/public-offerings.test.ts",
  "src/lib/booking/operations/sanity-service-link.test.ts",
  "src/lib/booking/square-team-client.test.ts",
]);

const DB_TEST_FILES = new Set([
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
  runTests(serverOnlyTestFiles, ["--conditions=react-server"]);
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

  const result = spawnSync(
    process.execPath,
    [...nodeOptions, "--import", "tsx", "--test", ...files],
    {
      cwd: process.cwd(),
      env: process.env,
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

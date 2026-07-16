import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SERVER_ONLY_TEST_FILES = new Set([
  "src/lib/booking/operations/model-mode.test.ts",
  "src/lib/booking/operations/public-offerings.test.ts",
  "src/lib/booking/operations/sanity-service-link.test.ts",
  "src/lib/booking/square-team-client.test.ts",
  "src/lib/private-db/appointment-finalization-repository.db.test.ts",
  "src/lib/private-db/booking-legacy-import-repository.db.test.ts",
  "src/lib/private-db/booking-public-read-repositories.db.test.ts",
  "src/lib/private-db/booking-reservation-repository.db.test.ts",
]);

const testFiles = (await listTestFiles("src")).sort();
const missingServerOnlyFiles = [...SERVER_ONLY_TEST_FILES].filter(
  (file) => !testFiles.includes(file),
);

if (missingServerOnlyFiles.length > 0) {
  throw new Error(
    `Server-only unit test file list is stale: ${missingServerOnlyFiles.join(", ")}`,
  );
}

const regularTestFiles = testFiles.filter(
  (file) => !SERVER_ONLY_TEST_FILES.has(file),
);
const serverOnlyTestFiles = testFiles.filter((file) =>
  SERVER_ONLY_TEST_FILES.has(file),
);

runTests(regularTestFiles, []);
runTests(serverOnlyTestFiles, ["--conditions=react-server"]);

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

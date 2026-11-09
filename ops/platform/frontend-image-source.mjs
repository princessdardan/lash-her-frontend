import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const demand = (ok) => { if (!ok) throw new Error("FRONTEND_PACKAGED_SOURCE_REFUSED"); };
const fixed = ["package.json", "package-lock.json", "src/lib/private-db/migration-lineage.ts", "contracts/api-integration/v1/manifest.json",
  "scripts/api-contract-tools.mjs", "scripts/api-contract-compatibility-review.mjs",
  "ops/platform/qualification-target-profile.mjs", "ops/platform/qualification-target-profiles.json",
  "ops/platform/p2-profiled-current-probe.mjs", "ops/platform/p2-recovery-current-probe.mjs",
  "ops/platform/p2-frontend-replacement-probe.mjs", "ops/platform/frontend-admission-bootstrap.mjs",
  "ops/platform/p2-frontend-replacement-abort.mjs",
  ...["frontend-migration", "frontend-schema", "frontend-image", "frontend-image-source", "source-checkout", "release-inputs", "source-policy", "release"].map((name) => `ops/platform/${name}.mjs`),
  "drizzle/meta/_journal.json",
  ...["manifest.json", "course-api.json", "community-api.json", "enrollment-event.schema.json", "boundary-contracts.json", "README.md"]
    .map(file => `contracts/api-integration/p2-candidate/${file}`)];
function bytes(directory, relative) {
  let path = directory;
  for (const part of relative.split("/")) { path = join(path, part); demand(!lstatSync(path).isSymbolicLink()); }
  demand(lstatSync(path).isFile() && lstatSync(path).size <= 2_000_000);
  return readFileSync(path);
}
function files(directory) {
  const manifest = JSON.parse(bytes(directory, "contracts/api-integration/p2-candidate/manifest.json"));
  const review = "contracts/api-integration/p2-candidate/compatibility-review.json";
  return [...fixed, ...(manifest.status === "released" || existsSync(join(directory, review)) ? [review] : []),
    ...readdirSync(join(directory, "drizzle")).filter((name) => name.endsWith(".sql")).map((name) => `drizzle/${name}`)].sort();
}

// This manifest is produced in the immutable image build. It is never accepted
// by the ordinary checkout CLI as a substitute for its Git source check.
export function writePackagedFrontendSource(commit, directory = root) {
  demand(typeof commit === "string" && /^[a-f0-9]{40}$/u.test(commit) && !/^0+$/u.test(commit));
  const manifest = { version: 1, service: "frontend", commit,
    files: Object.fromEntries(files(directory).map((file) => [file, sha256(bytes(directory, file))])) };
  writeFileSync(join(directory, "migration-source.json"), JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o444 });
  return manifest;
}

export function verifyPackagedFrontendSource(directory = root, expectedCommit = undefined) {
  const manifest = JSON.parse(bytes(directory, "migration-source.json"));
  demand(manifest.version === 1 && manifest.service === "frontend" && /^[a-f0-9]{40}$/u.test(manifest.commit ?? "") && !/^0+$/u.test(manifest.commit));
  demand(expectedCommit === undefined || manifest.commit === expectedCommit);
  demand(isDeepStrictEqual(Object.keys(manifest.files ?? {}).sort(), files(directory)));
  for (const [file, digest] of Object.entries(manifest.files)) demand(sha256(bytes(directory, file)) === digest);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    demand(process.argv.length === 4 && process.argv[2] === "--write");
    writePackagedFrontendSource(process.argv[3]);
  } catch { console.error("FRONTEND_PACKAGED_SOURCE_REFUSED"); process.exitCode = 1; }
}

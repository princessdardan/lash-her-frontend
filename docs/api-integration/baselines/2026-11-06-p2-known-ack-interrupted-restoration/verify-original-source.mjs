import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = "2cae572e88ad1648e1419035376ee34795623b1ce26e1c53a8cebbdb7d66141c";
const VALIDATION = "7f6306506766bbccd2f41b871eaaf563495d9cba7561888cc753d4e2d83cedb6";
const REPOSITORY_PATH = "docs/api-integration/baselines/2026-11-06-p2-known-ack-interrupted-restoration/run-owned.mjs";
const demand = value => { if (!value) throw new Error("ORIGINAL_C_SOURCE_RESOLUTION_REFUSED"); };
const exact = (value, keys) => demand(value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// This verifier resolves archived evidence only. It grants no release authority.
export function verifyOriginalSource(base = dirname(fileURLToPath(import.meta.url))) {
  demand(resolve(base) === base && realpathSync(base) === base && !lstatSync(base).isSymbolicLink());
  const read = relative => {
    demand(typeof relative === "string" && relative.split("/").every(part => /^[a-z0-9.-]+$/u.test(part) && ![".", ".."].includes(part)));
    let current = base;
    for (const part of relative.split("/")) {
      current = join(current, part);
      demand(!lstatSync(current).isSymbolicLink() && realpathSync(current) === current);
    }
    const info = lstatSync(current);
    demand(info.isFile() && info.size > 0 && info.size <= 2_000_000);
    return readFileSync(current);
  };
  const mapping = JSON.parse(read("original-source-resolution.json"));
  exact(mapping, ["version", "claim", "productionCommit", "originalValidation", "originalSource", "retainedSource"]);
  exact(mapping.originalValidation, ["file", "sha256"]);
  exact(mapping.originalSource, ["file", "repositoryPath", "sha256"]);
  exact(mapping.retainedSource, ["file", "sha256"]);
  demand(mapping.version === 1 && mapping.claim === "archival-source-resolution-only" &&
    mapping.productionCommit === "d5ee9bee1d3ef6ba23774bb41883eb3c8fb605c7" &&
    mapping.originalValidation.file === "validation.json" && mapping.originalValidation.sha256 === VALIDATION &&
    mapping.originalSource.file === "run-owned.mjs" && mapping.originalSource.repositoryPath === REPOSITORY_PATH &&
    mapping.originalSource.sha256 === SOURCE && mapping.retainedSource.file === "source-d5-final-seven-case/run-owned.mjs" &&
    mapping.retainedSource.sha256 === SOURCE);
  const original = read(mapping.originalValidation.file);
  demand(digest(original) === VALIDATION && digest(read(mapping.retainedSource.file)) === SOURCE);
  const validation = JSON.parse(original);
  demand(validation.productionCommit === mapping.productionCommit &&
    validation.evidenceSha256?.["run-owned.mjs"] === SOURCE &&
    validation.ownedCSourceSha256?.[REPOSITORY_PATH] === SOURCE &&
    validation.sourceFileSha256?.[REPOSITORY_PATH] === SOURCE);
  return { status: "ORIGINAL_C_SOURCE_RESOLUTION_VERIFIED", originalValidationSha256: VALIDATION,
    retainedSourceSha256: SOURCE, releaseAccepted: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    demand(process.argv.length === 2);
    process.stdout.write(`${JSON.stringify(verifyOriginalSource())}\n`);
  } catch {
    process.stderr.write("ORIGINAL_C_SOURCE_RESOLUTION_REFUSED\n");
    process.exitCode = 1;
  }
}

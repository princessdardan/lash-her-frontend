import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { canonicalContract, sha256 } from "./api-contract-tools.mjs";

export const compatibilityReviewFile = "compatibility-review.json";
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const fullRevision = value => /^[a-f0-9]{40}$/u.test(value ?? "") && !/^0+$/u.test(value);
const digest = value => /^[a-f0-9]{64}$/u.test(value ?? "") && !/^0+$/u.test(value);
const demand = (ok, message = "Exact compatibility review required") => { if (!ok) throw new Error(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const nullableHash = value => value === null || digest(value);
const read = path => { const bytes = readFileSync(path); demand(bytes.length > 0 && bytes.length <= 10_000_000); return bytes; };
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: 12 * 1024 * 1024, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
}
function commit(root, revision) {
  demand(fullRevision(revision), "Review and bundle revisions must be full immutable commit SHAs");
  demand(git(root, ["cat-file", "-t", revision]).toString().trim() === "commit");
}
function repository(path) { return realpathSync(git(path, ["rev-parse", "--show-toplevel"]).toString().trim()); }
function gitPath(root, path) {
  const value = relative(root, realpathSync(path)).replaceAll("\\", "/");
  demand(value && !value.startsWith("../") && value !== ".."); return value;
}

// Read archival bytes directly from Git. A changed label in today's v1
// directory cannot manufacture an approved historical baseline.
function bundleFromFiles(load) {
  const manifestBytes = load("manifest.json"), manifest = JSON.parse(manifestBytes);
  demand(manifest.version === 1 && ["candidate", "released"].includes(manifest.status) && fullRevision(manifest.frontendBaseRevision));
  demand(isDeepStrictEqual(Object.keys(manifest.artifacts ?? {}).sort(), ["community", "course", "enrollmentEvent"]));
  const documents = {}, hashes = {}, files = ["manifest.json", "README.md", "boundary-contracts.json"];
  for (const name of ["course", "community", "enrollmentEvent"]) {
    const pin = manifest.artifacts[name];
    demand(fullRevision(pin?.revision) && digest(pin.sha256) && /^[a-z][a-z.-]*\.json$/u.test(pin.file));
    const bytes = load(pin.file); demand(sha256(bytes) === pin.sha256, `Contract hash mismatch: ${name}`);
    documents[name] = JSON.parse(bytes); hashes[name] = sha256(bytes); files.push(pin.file);
  }
  const boundaries = load("boundary-contracts.json");
  demand(sha256(boundaries) === manifest.boundarySha256, "Boundary contract hash mismatch");
  documents.boundaries = JSON.parse(boundaries); hashes.boundaries = sha256(boundaries);
  if (manifest.status === "released" || manifest.readmeSha256 !== undefined)
    demand(digest(manifest.readmeSha256) && sha256(load("README.md")) === manifest.readmeSha256, "Normative README hash mismatch");
  return { manifest, documents, hashes, files, manifestSha256: sha256(manifestBytes) };
}
export function readReviewBundle(directory) {
  return bundleFromFiles(file => read(resolve(directory, file)));
}
export function readReviewBundleAtRevision(root, revision, bundlePath = "contracts/api-integration/v1") {
  commit(root, revision);
  demand(bundlePath === "contracts/api-integration/v1", "Review baseline must use the archived v1 bundle");
  return bundleFromFiles(file => git(root, ["show", `${revision}:${bundlePath}/${file}`]));
}

const definitionHash = value => value === undefined ? null : sha256(canonicalContract(value));
function definitions(document) {
  const entries = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of methods) if (Object.hasOwn(item, method)) entries.set(`operation\0${method} ${path}`,
      { parameters: item.parameters, operation: item[method] });
  }
  for (const [kind, values] of Object.entries(document.components ?? {})) {
    demand(object(values), "Unsupported component collection");
    for (const [name, value] of Object.entries(values)) entries.set(`component\0${kind}/${name}`, value);
  }
  if (document.security !== undefined) entries.set("globalSecurity\0security", document.security);
  return entries;
}
function assertOtherWireContext(baseline, candidate) {
  const other = document => Object.fromEntries(Object.entries(document).filter(([key]) => !["paths", "components", "security"].includes(key)));
  demand(canonicalContract(other(baseline)) === canonicalContract(other(candidate)), "Unreviewed top-level contract change");
  const pathMetadata = item => Object.fromEntries(Object.entries(item ?? {}).filter(([key]) => !methods.has(key) && key !== "parameters"));
  for (const path of new Set([...Object.keys(baseline.paths ?? {}), ...Object.keys(candidate.paths ?? {})])) {
    demand(canonicalContract(pathMetadata(baseline.paths?.[path])) === canonicalContract(pathMetadata(candidate.paths?.[path])),
      "Unreviewed path-level contract change");
  }
}

// Same wire normalization as assertCompatible: annotations are excluded and
// inherited path parameters are included. Missing definitions use null hashes.
export function describeCompatibilityChanges(baseline, candidate) {
  const changes = [];
  for (const document of ["course", "community"]) {
    assertOtherWireContext(baseline[document], candidate[document]);
    const before = definitions(baseline[document]), after = definitions(candidate[document]);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const beforeSha256 = definitionHash(before.get(key)), afterSha256 = definitionHash(after.get(key));
      if (beforeSha256 === afterSha256) continue;
      const [kind, location] = key.split("\0");
      changes.push({ document, kind, location, change: beforeSha256 === null ? "added" : afterSha256 === null ? "removed" : "changed", beforeSha256, afterSha256 });
    }
  }
  return changes.sort((a, b) => {
    const left = `${a.document}\0${a.kind}\0${a.location}`, right = `${b.document}\0${b.kind}\0${b.location}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function annotation(value, required) {
  const present = Object.hasOwn(value, "requirementIds") || Object.hasOwn(value, "reason");
  if (!required && !present) return;
  demand(Array.isArray(value.requirementIds) && value.requirementIds.length > 0 && value.requirementIds.length <= 50 &&
    value.requirementIds.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(id)) &&
    new Set(value.requirementIds).size === value.requirementIds.length && typeof value.reason === "string" &&
    value.reason.trim().length > 0 && value.reason.length <= 4000, "A requirement mapping and reason are required for reviewed changes");
}
export function assertCompatibilityReviewRecord(review) {
  demand(exactKeys(review, ["version", "kind", "baseline", "candidate", "changes", "versionedDocuments"]) && review.version === 1 &&
    review.kind === "integration-contract-compatibility-review");
  demand(exactKeys(review.baseline, ["revision", "bundlePath", "manifestSha256"]) && fullRevision(review.baseline.revision) &&
    review.baseline.bundlePath === "contracts/api-integration/v1" && digest(review.baseline.manifestSha256));
  demand(exactKeys(review.candidate, ["manifestSha256"]) && digest(review.candidate.manifestSha256));
  demand(Array.isArray(review.changes) && review.changes.length <= 10_000);
  for (const change of review.changes) {
    demand(exactKeys(change, ["document", "kind", "location", "change", "beforeSha256", "afterSha256"], ["requirementIds", "reason"]) &&
      ["course", "community"].includes(change.document) && ["operation", "component", "globalSecurity"].includes(change.kind) &&
      typeof change.location === "string" && change.location.length > 0 && change.location.length <= 2000 &&
      ["added", "changed", "removed"].includes(change.change) && nullableHash(change.beforeSha256) && nullableHash(change.afterSha256));
    annotation(change, change.change !== "added");
  }
  demand(exactKeys(review.versionedDocuments, ["enrollmentEvent", "boundaries"]));
  for (const name of ["enrollmentEvent", "boundaries"]) {
    const entry = review.versionedDocuments[name];
    demand(exactKeys(entry, ["beforeSha256", "afterSha256", "classification"], name === "boundaries" ? ["requirementIds", "reason"] : []) &&
      digest(entry.beforeSha256) && digest(entry.afterSha256) &&
      (name === "enrollmentEvent" ? entry.classification === "unchanged" : ["unchanged", "info-title-only"].includes(entry.classification)));
    if (name === "boundaries") annotation(entry, entry.classification === "info-title-only");
  }
  return review;
}
const machineChange = ({ document, kind, location, change, beforeSha256, afterSha256 }) => ({ document, kind, location, change, beforeSha256, afterSha256 });
function withoutBoundaryTitle(value) {
  const copy = structuredClone(value);
  if (object(copy.info)) delete copy.info.title;
  return copy;
}
// Produces an inventory, not an approval. Required change rationale is left for
// the operator to supply; an unannotated changed/removed entry cannot verify.
export function buildCompatibilityReview(baseline, candidate, baselineRevision) {
  return { version: 1, kind: "integration-contract-compatibility-review",
    baseline: { revision: baselineRevision, bundlePath: "contracts/api-integration/v1", manifestSha256: baseline.manifestSha256 },
    candidate: { manifestSha256: candidate.manifestSha256 }, changes: describeCompatibilityChanges(baseline.documents, candidate.documents),
    versionedDocuments: {
      enrollmentEvent: { beforeSha256: baseline.hashes.enrollmentEvent, afterSha256: candidate.hashes.enrollmentEvent, classification: "unchanged" },
      boundaries: { beforeSha256: baseline.hashes.boundaries, afterSha256: candidate.hashes.boundaries,
        classification: isDeepStrictEqual(baseline.documents.boundaries, candidate.documents.boundaries) ? "unchanged" : "info-title-only" },
    } };
}
export function validateCompatibilityReview(review, baseline, candidate, baselineRevision) {
  assertCompatibilityReviewRecord(review);
  demand(review.baseline.revision === baselineRevision && baseline.manifest.status === "released" && candidate.manifest.status === "released" &&
    review.baseline.manifestSha256 === baseline.manifestSha256 && review.candidate.manifestSha256 === candidate.manifestSha256,
  "Compatibility review bundle identity mismatch");
  const expected = describeCompatibilityChanges(baseline.documents, candidate.documents);
  demand(isDeepStrictEqual(review.changes.map(machineChange), expected), "Compatibility review must enumerate the complete exact delta");
  const event = review.versionedDocuments.enrollmentEvent, boundaries = review.versionedDocuments.boundaries;
  demand(baseline.hashes.enrollmentEvent === candidate.hashes.enrollmentEvent && event.beforeSha256 === baseline.hashes.enrollmentEvent &&
    event.afterSha256 === candidate.hashes.enrollmentEvent, "Enrollment event bytes must remain unchanged");
  demand(boundaries.beforeSha256 === baseline.hashes.boundaries && boundaries.afterSha256 === candidate.hashes.boundaries);
  const sameBoundaries = isDeepStrictEqual(baseline.documents.boundaries, candidate.documents.boundaries);
  if (sameBoundaries) demand(boundaries.classification === "unchanged");
  else demand(boundaries.classification === "info-title-only" &&
    typeof baseline.documents.boundaries.info?.title === "string" && typeof candidate.documents.boundaries.info?.title === "string" &&
    baseline.documents.boundaries.info.title !== candidate.documents.boundaries.info.title &&
    isDeepStrictEqual(withoutBoundaryTitle(baseline.documents.boundaries), withoutBoundaryTitle(candidate.documents.boundaries)),
  "Only the explicitly reviewed boundary info.title change is permitted");
  return expected;
}

export function verifyCompatibilityReview({ reviewPath, reviewRevision, candidateDirectory, candidateRevision, baselineDirectory, baselineRevision }) {
  demand(lstatSync(reviewPath).isFile() && !lstatSync(reviewPath).isSymbolicLink(), "Review must be a committed regular file");
  reviewPath = realpathSync(reviewPath);
  const root = repository(dirname(reviewPath)); commit(root, reviewRevision);
  const reviewBytes = read(reviewPath), committedReview = git(root, ["show", `${reviewRevision}:${gitPath(root, reviewPath)}`]);
  demand(sha256(reviewBytes) === sha256(committedReview), "Review differs from immutable commit");
  const review = assertCompatibilityReviewRecord(JSON.parse(reviewBytes));
  demand(review.baseline.revision === baselineRevision, "Compatibility review baseline revision mismatch");
  const baseline = readReviewBundleAtRevision(root, baselineRevision, review.baseline.bundlePath);
  if (baselineDirectory) demand(readReviewBundle(baselineDirectory).manifestSha256 === baseline.manifestSha256,
    "Baseline directory differs from the archived released bundle");
  candidateDirectory = realpathSync(candidateDirectory);
  demand(repository(candidateDirectory) === root, "Candidate and review must belong to the same source repository");
  commit(root, candidateRevision);
  const candidate = readReviewBundle(candidateDirectory), prefix = gitPath(root, candidateDirectory);
  for (const file of candidate.files) demand(sha256(read(resolve(candidateDirectory, file))) === sha256(git(root, ["show", `${candidateRevision}:${prefix}/${file}`])),
    `Bundle differs from immutable commit: ${file}`);
  validateCompatibilityReview(review, baseline, candidate, baselineRevision);
  return { reviewSha256: sha256(reviewBytes), reviewRevision, baselineRevision, manifestSha256: candidate.manifestSha256 };
}

export function verifyPublishedPhase2Contracts(sourceRoot, sourceRevision) {
  const directory = resolve(sourceRoot, "contracts/api-integration/p2-candidate"), reviewPath = resolve(directory, compatibilityReviewFile);
  const review = assertCompatibilityReviewRecord(JSON.parse(read(reviewPath)));
  return verifyCompatibilityReview({ reviewPath, reviewRevision: sourceRevision, candidateDirectory: directory,
    candidateRevision: sourceRevision, baselineRevision: review.baseline.revision });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    demand(process.argv.length === 5 && process.argv[2] === "--verify-published");
    verifyPublishedPhase2Contracts(process.argv[3], process.argv[4]);
    console.log("PUBLISHED_PHASE2_CONTRACT_REVIEW_VERIFIED");
  } catch { console.error("PUBLISHED_PHASE2_CONTRACT_REVIEW_REFUSED"); process.exitCode = 1; }
}

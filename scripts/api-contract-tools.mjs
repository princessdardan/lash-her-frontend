import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";

export const contractDirectory = resolve(
  import.meta.dirname,
  "../contracts/api-integration/v1",
);
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export async function readContractBundle(directory = contractDirectory) {
  const manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.version !== 1 ||
    !["candidate", "released"].includes(manifest.status) ||
    !/^[0-9a-f]{40}$/.test(manifest.frontendBaseRevision)
  ) {
    throw new Error("Unsupported integration manifest");
  }
  const documents = {};
  for (const name of ["course", "community", "enrollmentEvent"]) {
    const pin = manifest.artifacts[name];
    if (
      !/^[0-9a-f]{40}$/.test(pin.revision) ||
      !/^[0-9a-f]{64}$/.test(pin.sha256)
    ) {
      throw new Error(`Invalid immutable pin: ${name}`);
    }
    if (!/^[a-z][a-z.-]*\.json$/.test(pin.file))
      throw new Error("Invalid artifact filename");
    const bytes = await readFile(resolve(directory, pin.file));
    if (sha256(bytes) !== pin.sha256)
      throw new Error(`Contract hash mismatch: ${name}`);
    documents[name] = JSON.parse(bytes);
  }
  const boundaries = await readFile(
    resolve(directory, "boundary-contracts.json"),
  );
  if (sha256(boundaries) !== manifest.boundarySha256)
    throw new Error("Boundary contract hash mismatch");
  documents.boundaries = JSON.parse(boundaries);
  if (manifest.status === "released" || manifest.readmeSha256 !== undefined) {
    const readme = await readFile(resolve(directory, "README.md"));
    if (
      !/^[0-9a-f]{64}$/.test(manifest.readmeSha256) ||
      sha256(readme) !== manifest.readmeSha256
    )
      throw new Error("Normative README hash mismatch");
  }
  return { manifest, documents };
}

// A label or a mutable directory is insufficient release evidence. Bind every
// normative bundle byte (including prose) to an explicitly selected Git commit.
export async function verifyBundleRevision(directory, manifest, revision) {
  if (!/^[0-9a-f]{40}$/.test(revision ?? ""))
    throw new Error("Bundle revision must be a full immutable commit SHA");
  directory = await realpath(directory);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
  }).trim();
  const prefix = relative(root, directory).replaceAll("\\", "/");
  for (const file of [
    "manifest.json",
    "README.md",
    "boundary-contracts.json",
    ...Object.values(manifest.artifacts).map((pin) => pin.file),
  ]) {
    const path = prefix ? `${prefix}/${file}` : file;
    const committed = execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: root,
    });
    if (sha256(committed) !== sha256(await readFile(resolve(directory, file))))
      throw new Error(`Bundle differs from immutable commit: ${file}`);
  }
}

export function verifySources(manifest, repositoryDirectory) {
  for (const [name, pin] of Object.entries(manifest.artifacts)) {
    const repository = resolve(repositoryDirectory, pin.repository);
    const committed = execFileSync(
      "git",
      ["show", `${pin.revision}:${pin.sourcePath}`],
      { cwd: repository },
    );
    if (sha256(committed) !== pin.sha256)
      throw new Error(`Pinned source mismatch: ${name}`);
  }
}

// Conservative compatibility: preserve every existing operation's wire contract.
// Additions are permitted; any existing structural change requires explicit review.
export function assertCompatible(baseline, candidate) {
  for (const [path, item] of Object.entries(baseline.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      const next = candidate.paths[path]?.[method];
      if (next === undefined)
        throw new Error(`Removed operation: ${method} ${path}`);
      if (
        canonical({ parameters: item.parameters, operation }) !==
        canonical({
          parameters: candidate.paths[path].parameters,
          operation: next,
        })
      ) {
        throw new Error(
          `Changed operation requires compatibility review: ${method} ${path}`,
        );
      }
    }
  }
  // Resolve referenced definitions conservatively, including bearer trust boundaries.
  for (const [kind, definitions] of Object.entries(baseline.components ?? {})) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (
        canonical(definition) !==
        canonical(candidate.components?.[kind]?.[name])
      ) {
        throw new Error(
          `Changed component requires compatibility review: ${kind}/${name}`,
        );
      }
    }
  }
  if (canonical(baseline.security) !== canonical(candidate.security)) {
    throw new Error("Changed global security requires compatibility review");
  }
}

function canonical(value) {
  const annotations = new Set([
    "description",
    "summary",
    "tags",
    "externalDocs",
    "example",
    "examples",
  ]);
  const maps = new Set([
    "properties",
    "schemas",
    "responses",
    "headers",
    "securitySchemes",
    "$defs",
    "definitions",
  ]);
  function sort(entry, parentKey) {
    if (Array.isArray(entry)) return entry.map((item) => sort(item));
    if (entry === null || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .filter((key) => maps.has(parentKey) || !annotations.has(key))
        .map((key) => [key, sort(entry[key], key)]),
    );
  }
  return JSON.stringify(sort(value));
}

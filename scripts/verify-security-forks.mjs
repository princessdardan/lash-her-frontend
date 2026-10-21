import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const securityRoot = path.join(root, "vendor/security");
const manifest = JSON.parse(
  readFileSync(path.join(securityRoot, "forks.json")),
);
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json")));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json")));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function filesIn(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);
      assert(!entry.isSymbolicLink(), `Unexpected symlink: ${relative}`);
      return entry.isDirectory()
        ? filesIn(path.join(directory, entry.name), relative)
        : [relative];
    })
    .sort();
}

for (const fork of manifest.forks) {
  const directory = path.join(securityRoot, fork.directory);
  const archive = path.join(securityRoot, fork.archive);
  const integrity =
    "sha512-" +
    createHash("sha512").update(readFileSync(archive)).digest("base64");
  assert.equal(
    integrity,
    fork.integrity,
    `${fork.dependency}: archive integrity`,
  );
  assert.equal(
    pkg.dependencies[fork.dependency],
    `file:vendor/security/${fork.archive}`,
  );
  assert.equal(pkg.overrides[fork.dependency], `$${fork.dependency}`);
  assert.deepEqual(
    filesIn(directory),
    Object.keys(fork.files).sort(),
    "Unrecorded source changes",
  );
  const archiveFiles = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(
    archiveFiles,
    Object.keys(fork.files)
      .map((file) => `package/${file}`)
      .sort(),
  );
  for (const [file, hash] of Object.entries(fork.files)) {
    assert(!path.isAbsolute(file) && !file.split("/").includes(".."));
    assert.equal(
      digest(readFileSync(path.join(directory, file))),
      hash,
      `Source changed: ${file}`,
    );
    assert.equal(
      digest(execFileSync("tar", ["-xOzf", archive, `package/${file}`])),
      hash,
      `Archive differs: ${file}`,
    );
  }

  const installations = new Set();
  for (const [location, entry] of Object.entries(lock.packages)) {
    const dependencies = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
    };
    if (dependencies[fork.dependency]) {
      const parentRequire = location
        ? createRequire(path.join(root, location, "package.json"))
        : require;
      installations.add(
        path.dirname(parentRequire.resolve(`${fork.dependency}/package.json`)),
      );
    }
    if (
      location.endsWith(`/node_modules/${fork.dependency}`) ||
      location === `node_modules/${fork.dependency}`
    ) {
      installations.add(path.join(root, location));
      assert.equal(entry.name, fork.name, `Unpatched lock entry: ${location}`);
      assert.equal(
        entry.integrity,
        fork.integrity,
        `Unexpected lock integrity: ${location}`,
      );
    }
  }
  assert(installations.size, `Missing dependency: ${fork.dependency}`);
  for (const installation of installations) {
    const installedPackage = JSON.parse(
      readFileSync(path.join(installation, "package.json")),
    );
    assert.equal(installedPackage.name, fork.name);
    assert.equal(installedPackage.version, fork.version);
    for (const [file, hash] of Object.entries(fork.files)) {
      assert.equal(
        digest(readFileSync(path.join(installation, file))),
        hash,
        `Installed code differs: ${installation}/${file}`,
      );
    }
  }
  console.log(
    `Verified ${fork.name}@${fork.version}: source, archive, and ${installations.size} installed location(s)`,
  );
}

for (const [location, entry] of Object.entries(lock.packages)) {
  assert(
    !location.endsWith("/node_modules/sprintf-js") &&
      location !== "node_modules/sprintf-js",
    "Legacy sprintf-js remains",
  );
  if (
    location.endsWith("/node_modules/argparse") ||
    location === "node_modules/argparse"
  ) {
    assert(!entry.version.startsWith("1."), "Legacy argparse remains");
  }
}

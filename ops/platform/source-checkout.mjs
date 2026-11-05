import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SOURCE_REPOSITORIES } from "./release-inputs.mjs";
import { phase2ContractManifestBinding } from "./release.mjs";

const SOURCE_PATHS = ["src", "scripts", "contracts", "ops", "tests", "drizzle", "tools", ":(glob).env*"];

function git(directory, args) {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

export function assertSourceCheckout(directory, commit) {
  try {
    if (!/^[0-9a-f]{40}$/u.test(commit ?? "") || /^0+$/u.test(commit)) throw new Error();
    const root = realpathSync(directory);
    // A missing nested checkout must not silently resolve to its parent repo.
    if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root ||
        git(root, ["rev-parse", "HEAD"]).trim() !== commit) throw new Error();
    git(root, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    git(root, ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    if (git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).length) throw new Error();
    // Ignored source or dotenv files can affect module resolution/configuration
    // without appearing in an ordinary clean-tree check. Installed dependencies
    // and Python bytecode caches are expected outputs, not source checkouts.
    const ignored = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...SOURCE_PATHS])
      .split("\0").filter(Boolean);
    const dependencyRoots = ["ops/gateway", "tools/api-contract-toolchain"].filter((path) => {
      try { git(root, ["ls-files", "--error-unmatch", "--", `${path}/package-lock.json`]); return true; }
      catch { return false; }
    }).map((path) => `${path}/node_modules/`);
    if (ignored.some((path) => {
      const parts = path.split("/");
      return !dependencyRoots.some((root) => path.startsWith(root)) && !(parts.includes("__pycache__") && path.endsWith(".pyc"));
    })) throw new Error();
  } catch { throw new Error("Pinned source checkout is missing, dirty or contains unexpected source/configuration"); }
}

export function verifySourceCheckouts(sourceRoot, sources, { requirePhase2 = false } = {}) {
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    if (sources?.[name]?.repository !== `https://github.com/${repository}.git` || sources[name].requiredChecks !== "passed") {
      throw new Error("Verified source repository pins required");
    }
    assertSourceCheckout(join(sourceRoot, repository.split("/")[1]), sources[name].commit);
  }
  if (requirePhase2) {
    const frontend = join(sourceRoot, "lash-her-frontend"), binding = phase2ContractManifestBinding(frontend, { requireReleased: true });
    if (binding.phase2ContractRevisions.course !== sources.course.commit || binding.phase2ContractRevisions.community !== sources.community.commit ||
      binding.phase2ContractRevisions.enrollmentEvent !== sources.community.commit) throw new Error("Exact phase 2 source contract pins required");
    const manifest = JSON.parse(readFileSync(join(frontend, "contracts/api-integration/p2-candidate/manifest.json")));
    for (const artifact of Object.values(manifest.artifacts)) {
      const bytes = readFileSync(join(sourceRoot, artifact.repository, artifact.sourcePath));
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Exact phase 2 API contract source required");
    }
    return binding;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5 || process.argv[2] !== "--phase2") throw new Error();
    const proof = JSON.parse(readFileSync(process.argv[4]));
    const binding = verifySourceCheckouts(resolve(process.argv[3]), proof.sources, { requirePhase2: true });
    if (proof.version !== 4 || proof.contractPhase !== "p2" || proof.phase2ContractManifestSha256 !== binding.phase2ContractManifestSha256) throw new Error();
    console.log("PHASE2_CONTRACT_SOURCE_VERIFIED");
  } catch { console.error("PHASE2_CONTRACT_SOURCE_REFUSED"); process.exitCode = 1; }
}

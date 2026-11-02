import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_REPOSITORIES } from "./release-inputs.mjs";

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

export function verifySourceCheckouts(sourceRoot, sources) {
  for (const [name, repository] of Object.entries(SOURCE_REPOSITORIES)) {
    if (sources?.[name]?.repository !== `https://github.com/${repository}.git` || sources[name].requiredChecks !== "passed") {
      throw new Error("Verified source repository pins required");
    }
    assertSourceCheckout(join(sourceRoot, repository.split("/")[1]), sources[name].commit);
  }
}

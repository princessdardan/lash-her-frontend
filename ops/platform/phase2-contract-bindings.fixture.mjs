// Owned immutable source repositories for contract/source-CLI tests only.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompatibilityReview, readReviewBundle, readReviewBundleAtRevision } from "../../scripts/api-contract-compatibility-review.mjs";

const frontend = fileURLToPath(new URL("../..", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function phase2SourceFixture(run) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase2-contract-source-"))), sources = {};
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const commit = repo => {
    git(repo, "add", ".");
    git(repo, "-c", "user.name=Owned fixture", "-c", "user.email=owned@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-gpg-sign", "-m", "Owned P2 source fixture");
    return git(repo, "rev-parse", "HEAD");
  };
  const source = join(directory, "lash-her-frontend"), bundle = join(source, "contracts/api-integration/p2-candidate");
  mkdirSync(bundle, { recursive: true });
  cpSync(join(frontend, "contracts/api-integration/p2-candidate"), bundle, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json")));
  manifest.status = "released";
  manifest.readmeSha256 = hash(readFileSync(join(bundle, "README.md")));
  try {
    for (const name of ["course", "community"]) {
      const repo = join(directory, `lash-her-${name}-api`); mkdirSync(repo);
      git(repo, "init", "--quiet");
      for (const artifact of Object.values(manifest.artifacts).filter(item => item.repository === `lash-her-${name}-api`)) {
        const path = join(repo, artifact.sourcePath); mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(join(bundle, artifact.file)));
      }
      sources[name] = { repository: `https://github.com/princessdardan/lash-her-${name}-api.git`, commit: commit(repo), requiredChecks: "passed" };
    }
    for (const file of ["release-inputs.mjs", "source-policy.mjs", "release.mjs", "source-checkout.mjs"]) {
      mkdirSync(join(source, "ops/platform"), { recursive: true });
      writeFileSync(join(source, "ops/platform", file), readFileSync(join(frontend, "ops/platform", file)));
    }
    for (const file of ["api-contract-tools.mjs", "api-contract-compatibility-review.mjs"]) {
      mkdirSync(join(source, "scripts"), { recursive: true });
      writeFileSync(join(source, "scripts", file), readFileSync(join(frontend, "scripts", file)));
    }
    rmSync(join(bundle, "compatibility-review.json"), { force: true });
    git(source, "init", "--quiet");
    manifest.frontendBaseRevision = commit(source);
    for (const [name, artifact] of Object.entries(manifest.artifacts)) artifact.revision = sources[name === "enrollmentEvent" ? "community" : name].commit;
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest) + "\n");
    const archive = join(source, "contracts/api-integration/v1");
    cpSync(bundle, archive, { recursive: true });
    const baselineRevision = commit(source);
    const reviewPath = join(bundle, "compatibility-review.json");
    const review = buildCompatibilityReview(readReviewBundleAtRevision(source, baselineRevision), readReviewBundle(bundle), baselineRevision);
    writeFileSync(reviewPath, JSON.stringify(review) + "\n");
    sources.frontend = { repository: "https://github.com/princessdardan/lash-her-frontend.git", commit: commit(source), requiredChecks: "passed" };
    const retain = () => {
      const bytes = JSON.stringify(manifest) + "\n";
      writeFileSync(join(bundle, "manifest.json"), bytes); review.candidate.manifestSha256 = hash(bytes);
      writeFileSync(reviewPath, JSON.stringify(review) + "\n"); sources.frontend.commit = commit(source);
    };
    return run({ directory, source, bundle, sources, manifest, retain, commit, baselineRevision, reviewPath, review });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}


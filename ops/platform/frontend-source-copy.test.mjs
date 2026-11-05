import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { frontendMigrationArtifact } from "./frontend-migration.mjs";

const source = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("the actual owned source-copy branch produces an executable migration CLI with its complete contract verifier closure", () => {
  const parent = ts.createSourceFile("parent.mjs", readFileSync(new URL("./test-frontend-migration-local.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let copyBranch;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(parent) === "process.env.FRONTEND_PACKAGED_MIGRATION_ROOT") copyBranch = node.elseStatement;
    ts.forEachChild(node, visit);
  };
  visit(parent); assert.ok(copyBranch && ts.isBlock(copyBranch));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "frontend-source-copy-"))), app = join(directory, "app");
  try {
    // Execute only the real source-copy branch, without starting the parent's
    // PostgreSQL cluster, then load its real CLI in a separate Node process.
    runInNewContext(copyBranch.getText(parent), { app, source, cleanEnv: { PATH: process.env.PATH },
      commit: undefined, mkdirSync, copyFileSync, cpSync, symlinkSync, writeFileSync, join,
      run: (program, args, options) => execFileSync(program, args, { encoding: "utf8", stdio: "pipe", ...options }) });
    const invoke = () => spawnSync(process.execPath, ["ops/platform/frontend-migration.mjs", "--manifest-only"], {
      cwd: app, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    });
    const result = invoke(); assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout), expected = frontendMigrationArtifact(source);
    for (const key of ["sqlArtifactSha256", "contractManifestSha256", "contractPhase", "phase2ContractManifestSha256"]) assert.equal(manifest[key], expected[key]);
    for (const file of ["api-contract-tools.mjs", "api-contract-compatibility-review.mjs"]) {
      const target = join(app, "scripts", file), original = readFileSync(target);
      assert.deepEqual(original, readFileSync(join(source, "scripts", file)));
      rmSync(target);
      const missing = invoke(); assert.equal(missing.status, 1); assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/u);
      writeFileSync(target, original);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

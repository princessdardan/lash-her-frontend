import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parse } from "yaml";
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
    for (const name of ["qualification-target-profile.mjs", "qualification-target-profiles.json"])
      assert.deepEqual(readFileSync(join(app, "ops/platform", name)), readFileSync(join(source, "ops/platform", name)));
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

for (const fixture of [
  { name: "source CI", file: "ci.yml", job: "frontend-operator-migrations", prefix: "$PWD", marker: "FRONTEND_MIGRATION_EXPORT_SCHEMA=true" },
  { name: "candidate rehearsal", file: "platform-artifacts.yml", job: "candidate", prefix: "$PWD/sources/lash-her-frontend", marker: "frontend-migration-rehearsal.json" },
]) {
test(`${fixture.name} owned Docker fixture COPY inputs exist inside its actual build context`, () => {
  const workflow = parse(readFileSync(new URL(`../../.github/workflows/${fixture.file}`, import.meta.url), "utf8"));
  const build = workflow.jobs[fixture.job].steps.find(step => step.run?.includes("Dockerfile.frontend-migration-test"))?.run;
  assert.ok(build);
  const command = build.replace(/\\\n\s*/gu, " ").split("\n").find(line => line.includes("docker build"));
  const selectedContext = command?.trim().match(/(?:^|\s)([A-Za-z0-9/._-]+)$/u)?.[1];
  const expected = fixture.name === "source CI" ? "ops/platform" : "sources/lash-her-frontend/ops/platform";
  assert.equal(selectedContext, expected);
  const directory = join(source, "ops/platform");
  const verify = text => {
    for (const line of text.split("\n").filter(line => /^COPY\s/u.test(line) && !/^COPY\s+--from=/u.test(line))) {
      const instruction = /^COPY ([A-Za-z0-9/._-]+) ([A-Za-z0-9/._-]+)$/u.exec(line);
      assert.ok(instruction, "Review unsupported fixture COPY syntax against the actual build context");
      const input = resolve(directory, instruction[1]);
      assert.ok(input.startsWith(`${directory}/`) && existsSync(input), `Fixture COPY input is outside or missing from ${selectedContext}`);
    }
  };
  const dockerfile = readFileSync(new URL("./Dockerfile.frontend-migration-test", import.meta.url), "utf8");
  verify(dockerfile);
  assert.throws(() => verify(`${dockerfile}\nCOPY ops/gateway/routes.json /source/ops/gateway/routes.json\n`), /Fixture COPY input/u);
});

test(`${fixture.name} readonly mounts can load the actual protected route and validators`, () => {
  const workflow = parse(readFileSync(new URL(`../../.github/workflows/${fixture.file}`, import.meta.url), "utf8"));
  const run = workflow.jobs[fixture.job].steps.find(step => step.run?.includes(fixture.marker))?.run;
  assert.ok(run);
  const mounts = [...run.matchAll(/--mount "type=bind,src=([^,"]+),dst=([^,"]+),readonly"/gu)]
    .map(([, source, destination]) => ({ source, destination })).sort((a, b) => b.destination.length - a.destination.length);
  const mountedSource = file => {
    const destination = `/source/${file}`;
    const mount = mounts.find(item => destination === item.destination || destination.startsWith(`${item.destination}/`));
    assert.ok(mount, `Owned fixture does not mount ${file}`);
    assert.ok(mount.source === fixture.prefix || mount.source.startsWith(`${fixture.prefix}/`));
    return resolve(source, mount.source.slice(fixture.prefix.length).replace(/^\//u, ""), destination.slice(mount.destination.length).replace(/^\//u, ""));
  };
  const app = realpathSync(mkdtempSync(join(tmpdir(), "frontend-mounted-import-")));
  const copy = file => { const target = join(app, file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(mountedSource(file), target); };
  const copied = new Set();
  const copyRuntimeImports = file => {
    if (copied.has(file)) return;
    copied.add(file); copy(file);
    if (file.endsWith(".json")) return;
    const syntax = ts.createSourceFile(file, readFileSync(join(source, file), "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of syntax.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || statement.isTypeOnly ||
        statement.importClause?.isTypeOnly || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const base = specifier.startsWith("@/") ? resolve(source, "src", specifier.slice(2)) : resolve(source, dirname(file), specifier);
      const target = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}.json`, join(base, "index.ts")]
        .find(path => existsSync(path) && statSync(path).isFile());
      assert.ok(target, `Missing actual source import: ${statement.moduleSpecifier.text}`);
      copyRuntimeImports(relative(source, target));
    }
  };
  try {
    for (const file of ["package.json", "tsconfig.json", "scripts/register-server-only-test.mjs"]) copy(file);
    symlinkSync(realpathSync(mountedSource("node_modules")), join(app, "node_modules"), "dir");
    const entries = ["src/lib/api-integration/response-validation.ts", "src/lib/api-integration/candidate-validation.ts",
      "src/app/api/internal/release-probe/route.ts"];
    for (const file of entries) copyRuntimeImports(file);
    const code = `for (const url of ${JSON.stringify(entries.map(file => pathToFileURL(join(app, file)).href))}) await import(url); console.log("RESPONSE_VALIDATOR_MOUNT_CLOSURE_PASS");`;
    const imported = spawnSync(process.execPath, ["--import", "tsx", "--import", join(app, "scripts/register-server-only-test.mjs"), "--input-type=module", "--eval", code], {
      cwd: app, env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(imported.error); assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /RESPONSE_VALIDATOR_MOUNT_CLOSURE_PASS/u);
    // The previous CI context omitted this actual eager dependency. Removing
    // only it must reproduce the real import failure, without DB/network calls.
    rmSync(join(app, "ops/gateway/routes.json"));
    const missing = spawnSync(process.execPath, ["--import", "tsx", "--import", join(app, "scripts/register-server-only-test.mjs"), "--input-type=module", "--eval", code], {
      cwd: app, env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 10_000,
    });
    assert.ifError(missing.error); assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cannot find module '[^']*ops\/gateway\/routes\.json'/u);
  } finally { rmSync(app, { recursive: true, force: true }); }
});
}

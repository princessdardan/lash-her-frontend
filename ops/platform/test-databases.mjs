import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// Owns one new disposable PG16 container. No external URL or live credential is
// accepted, inherited or printed. Never attaches to an existing database.
const runId = randomUUID();
const container = `lash-p1-test-${runId}`;
const logDirectory = resolve(tmpdir(), container);
mkdirSync(logDirectory, { mode: 0o700 });
const roots = {
  frontend: resolve(import.meta.dirname, "../.."),
  course: resolve(import.meta.dirname, "../../../lash-her-course-api"),
  community: resolve(import.meta.dirname, "../../../lash-her-community-api"),
};
const records = [];
const fixturePassword = `isolated-fixture-${randomUUID()}`;
let created = false;

function docker(args, allowFailure = false) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  if (!allowFailure && result.status !== 0) {
    writeFileSync(resolve(logDirectory, "docker-error.log"), (result.stderr ?? "").replaceAll(fixturePassword, "[fixture redacted]"), { mode: 0o600 });
    throw new Error("Owned local PostgreSQL operation failed; inspect the local sanitized diagnostic");
  }
  return result;
}

function run(name, cwd, args, env) {
  const log = openSync(resolve(logDirectory, `${name}.log`), "w", 0o600);
  try {
    const result = spawnSync("npm", args, { cwd, env, stdio: ["ignore", log, log], timeout: 300_000 });
    records.push({ name, passed: result.status === 0 });
    process.stdout.write(`${name}: ${result.status === 0 ? "PASS" : "FAIL"}\n`);
    if (result.status !== 0) throw new Error(`Isolated check failed: ${name}`);
  } finally { closeSync(log); }
}

try {
  docker(["run", "--detach", "--name", container, "--label", `codex.lash-p1-test=${runId}`,
    "--env", `POSTGRES_PASSWORD=${fixturePassword}`, "--publish", "127.0.0.1::5432", "postgres:16"]);
  created = true;
  const deadline = Date.now() + 30_000;
  while (docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], true).status !== 0) {
    if (Date.now() >= deadline) throw new Error("Owned local PostgreSQL readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const portOutput = docker(["port", container, "5432/tcp"]).stdout.trim();
  if (!/^127\.0\.0\.1:[0-9]+$/u.test(portOutput)) throw new Error("Owned database must bind loopback only");
  const port = portOutput.split(":")[1];
  const inherited = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const adminUrl = `postgresql://postgres:${fixturePassword}@127.0.0.1:${port}/postgres`;
  for (const [name, root] of Object.entries(roots)) {
    const database = `lash_her_${name}_p1_test`;
    docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${database}`]);
    const url = `postgresql://postgres:${fixturePassword}@127.0.0.1:${port}/${database}?sslmode=disable`;
    const env = {
      ...inherited, NODE_ENV: "test", CI: "true", DATABASE_TARGET: "test", TEST_DATABASE_URL: url,
      DEV_DATABASE_URL: "", STAGING_DATABASE_URL: "", PROD_DATABASE_URL: "", DATABASE_URL: name === "frontend" ? url : "",
      PRIVATE_DB_MIGRATION_TARGET: "local", PRIVATE_DB_MIGRATION_HOST: "127.0.0.1",
      NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10", NEXT_PUBLIC_SANITY_PROJECT_ID: "3auncj84",
      RUN_DATABASE_INTEGRATION_TESTS: "true", DATABASE_ADMIN_URL: adminUrl,
      MIGRATION_ROUNDTRIP_ALLOW_DESTRUCTIVE: "true",
    };
    run(`${name}-clean-migrations`, root, ["run", "db:migrate"], env);
    run(`${name}-database-tests`, root, ["run", name === "frontend" ? "test:unit:db" : "test:database"], env);
    if (name === "frontend" && process.argv.includes("--browser")) {
      run("frontend-course-browser", root, ["test", "--", "--config", "tests/courses.playwright.config.ts"], {
        ...env, COURSE_E2E_DATABASE_URL: url,
      });
    }
    if (name !== "frontend") run(`${name}-migration-roundtrip`, root, ["run", "db:migrations:roundtrip"], env);
  }
} finally {
  if (created) docker(["rm", "--force", "--volumes", container], true);
  writeFileSync(resolve(logDirectory, "results.json"), JSON.stringify({ runId, records }, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`Local evidence: ${logDirectory}\n`);
}

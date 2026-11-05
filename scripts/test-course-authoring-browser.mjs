// Owns both disposable PostgreSQL16 databases, a fixed Course source export and
// loopback Next/Course servers. Accepts no database URL or live provider config.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { encode } from "next-auth/jwt";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const courseSource =
  process.env.COURSE_AUTHORING_API_SOURCE ?? "/private/tmp/lash-phase2-course";
const courseSha = "11ea33d085e277bf4d9517476b683b5389c8eaa8";
const pgBin = process.env.PG16_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";
const temporary = await mkdtemp(join(tmpdir(), "lash-authoring-browser-"));
const cluster = join(temporary, "postgres"),
  courseExport = join(temporary, "course");
const databasePort = await freePort(),
  coursePort = await freePort(),
  frontendPort = await freePort();
const origin = `http://localhost:${frontendPort}`,
  apiOrigin = `http://127.0.0.1:${coursePort}`;
const frontendUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_authoring_frontend_integration?sslmode=disable`;
const courseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_authoring_course_integration?sslmode=disable`;
const signingKey = randomBytes(32).toString("hex"),
  authKey = randomBytes(32).toString("hex");
const workload = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200 })).toString("base64url")}.fixture`;
const common = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  LC_ALL: "C",
  LANG: "C",
  NO_COLOR: "1",
  NODE_NO_WARNINGS: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};
const children = [];
let started = false;
try {
  if ((await run("git", ["status", "--porcelain"], root)).trim())
    throw new Error(
      "Commit the exact frontend source before browser qualification",
    );
  const frontendSha = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  await mkdir(courseExport);
  await exportSource();
  const candidateHash = createHash("sha256")
    .update(
      await readFile(
        join(root, "contracts/api-integration/p2-candidate/course-api.json"),
      ),
    )
    .digest("hex");
  if (
    candidateHash !==
    createHash("sha256")
      .update(await readFile(join(courseExport, "openapi/course-api.json")))
      .digest("hex")
  )
    throw new Error(
      "Frontend candidate must match the exact exported Course artifact",
    );
  const migrationsApplied = {};
  if (
    (await readFile(join(courseExport, "package-lock.json"), "utf8")) !==
    (await readFile(join(courseSource, "package-lock.json"), "utf8"))
  )
    throw new Error("Course dependency tree must match the exported lockfile");
  await symlink(
    join(courseSource, "node_modules"),
    join(courseExport, "node_modules"),
  );
  const version = await run(join(pgBin, "postgres"), ["--version"]);
  if (!/PostgreSQL\) 16\./u.test(version))
    throw new Error("Owned PostgreSQL16 is required");
  await run(join(pgBin, "initdb"), [
    "-D",
    cluster,
    "-U",
    "postgres",
    "--auth-local=trust",
    "--auth-host=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  await run(join(pgBin, "pg_ctl"), [
    "-D",
    cluster,
    "-l",
    join(temporary, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${databasePort} -c unix_socket_directories=`,
    "-w",
    "start",
  ]);
  started = true;
  const admin = new pg.Client({
    connectionString: `postgresql://postgres@127.0.0.1:${databasePort}/postgres`,
  });
  await admin.connect();
  try {
    await admin.query("create database lash_authoring_frontend_integration");
    await admin.query("create database lash_authoring_course_integration");
  } finally {
    await admin.end();
  }
  for (const [url, migrationsFolder] of [
    [frontendUrl, join(root, "drizzle")],
    [courseUrl, join(courseExport, "drizzle")],
  ]) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      if (url === frontendUrl) {
        // The reviewed frontend lineage commits each journal entry separately:
        // later indexes consume enum values introduced by prior migrations.
        await client.query("create schema drizzle");
        await client.query(
          "create table drizzle.__drizzle_migrations(id serial primary key, hash text not null, created_at bigint)",
        );
        for (const migration of readMigrationFiles({ migrationsFolder })) {
          await client.query("begin");
          try {
            for (const statement of migration.sql)
              await client.query(statement);
            await client.query(
              "insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",
              [migration.hash, migration.folderMillis],
            );
            await client.query("commit");
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        }
      } else await migrate(drizzle(client), { migrationsFolder });
      migrationsApplied[url === frontendUrl ? "frontend" : "course"] = (
        await client.query(
          "select count(*)::int count from drizzle.__drizzle_migrations",
        )
      ).rows[0].count;
    } finally {
      await client.end();
    }
  }
  const storage = {},
    client = new pg.Client({ connectionString: frontendUrl });
  await client.connect();
  try {
    for (const role of ["owner", "admin"]) {
      const id = randomUUID(),
        providerUserId = `authoring-${id}`,
        email = `${role}-${id}@example.test`;
      await client.query(
        "insert into admin_users(id,provider_user_id,email,email_normalized,display_name,role,status) values($1,$2,$3,$3,$4,$5,'active')",
        [id, providerUserId, email, `Authoring ${role}`, role],
      );
      const token = await encode({
        secret: authKey,
        salt: "authjs.session-token",
        maxAge: 3600,
        token: {
          sub: providerUserId,
          providerUserId,
          email,
          name: `Authoring ${role}`,
          googleEmailVerified: true,
          authenticatedAt: Date.now(),
        },
      });
      storage[role] = {
        cookies: [
          {
            name: "authjs.session-token",
            value: token,
            domain: "localhost",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      };
    }
  } finally {
    await client.end();
  }
  const storagePath = join(temporary, "storage.json");
  await writeFile(storagePath, JSON.stringify(storage), { mode: 0o600 });
  const courseEnv = {
    ...common,
    NODE_ENV: "test",
    DATABASE_TARGET: "test",
    TEST_DATABASE_URL: courseUrl,
    PORT: String(coursePort),
    HTTP_BIND_ADDRESS: "127.0.0.1",
    COURSE_ADMIN_JWT_CURRENT_SECRET: signingKey,
  };
  children.push(
    start(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      courseExport,
      courseEnv,
      "course.log",
    ),
  );
  await ready(`${apiOrigin}/health`);
  const frontendEnv = {
    ...common,
    NODE_ENV: "development",
    DATABASE_URL: frontendUrl,
    FRONTEND_WRITER_ADMISSION_MODE: "off",
    AUTH_SECRET: authKey,
    AUTH_TRUST_HOST: "true",
    AUTH_URL: origin,
    AUTH_GOOGLE_ID: "authoring-fixture-client",
    AUTH_GOOGLE_SECRET: randomBytes(32).toString("hex"),
    COURSE_ADMIN_JWT_CURRENT_SECRET: signingKey,
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_TARGET_ENV: "preview",
    APP_ENV: "staging",
    APP_VERCEL_TEAM_ID: "team_2Hrn5eMZyZxfAWdmYvyKi9t3",
    VERCEL_PROJECT_ID: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
    VERCEL_OIDC_TOKEN: workload,
    NEXT_PUBLIC_SANITY_PROJECT_ID: "7o23yrvk",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    NEXT_PUBLIC_SANITY_API_VERSION: "2026-03-24",
    NEXT_PUBLIC_SITE_URL: origin,
    API_GATEWAY_STAGING_ORIGIN: "https://authoring-gateway.invalid",
    INTEGRATION_COURSE_READS_ENABLED: "true",
    COURSE_AUTHORING_BROWSER_FIXTURE: "1",
    COURSE_AUTHORING_API_ORIGIN: apiOrigin,
    NODE_OPTIONS: `--require=${join(root, "tests/course-authoring-browser/gateway-fixture.cjs")}`,
  };
  children.push(
    start(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(frontendPort),
      ],
      root,
      frontendEnv,
      "frontend.log",
    ),
  );
  await ready(`${origin}/admin/sign-in`, 180_000);
  const testEnvironment = {
    ...common,
    COURSE_AUTHORING_BROWSER_FIXTURE: "1",
    COURSE_AUTHORING_BROWSER_ORIGIN: origin,
    COURSE_AUTHORING_STORAGE_PATH: storagePath,
  };
  process.stdout.write(
    `Authoring browser source frontend=${frontendSha} course=${courseSha}\n`,
  );
  await run(
    "npx",
    ["playwright", "test", "--config=playwright.course-authoring.config.ts"],
    root,
    testEnvironment,
    true,
  );
  await mkdir(join(root, "test-results/course-authoring-browser"), {
    recursive: true,
  });
  await writeFile(
    join(root, "test-results/course-authoring-browser/evidence.json"),
    JSON.stringify(
      {
        frontendSource: frontendSha,
        courseSource: courseSha,
        courseArtifactSha256: candidateHash,
        postgresMajor: 16,
        migrationsApplied,
        gatewayWorkloadVerification: "fixture",
        frontendAdmission: "off-in-owned-local-only",
        liveProvidersCertified: false,
        stagingCertified: false,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    "Owned Next/Course/PostgreSQL16 authoring browser checks passed; gateway workload verification and live providers remain outside this fixture\n",
  );
} catch (error) {
  for (const name of ["course.log", "frontend.log"]) {
    const log = await readFile(join(temporary, name), "utf8").catch(() => "");
    if (log) process.stderr.write(`${name}:\n${log.slice(-18000)}\n`);
  }
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      await new Promise((resolveDone) => {
        child.once("close", resolveDone);
        setTimeout(resolveDone, 3000);
      });
      if (child.exitCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }
  }
  if (started)
    await run(join(pgBin, "pg_ctl"), [
      "-D",
      cluster,
      "-m",
      "immediate",
      "-w",
      "stop",
    ]);
  await rm(temporary, { recursive: true, force: true });
}
function start(command, args, cwd, env, log) {
  const stream = createWriteStream(join(temporary, log), { mode: 0o600 });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  return child;
}
function run(command, args, cwd = root, env = common, forward = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (forward) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      if (forward) process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveResult(output)
        : reject(
            new Error(
              `Owned browser command failed (${code}): ${forward ? command : output}`,
            ),
          ),
    );
  });
}
function exportSource() {
  return new Promise((resolveExport, reject) => {
    const archive = spawn("git", ["archive", courseSha], {
        cwd: courseSource,
        env: common,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      extract = spawn("tar", ["-xf", "-", "-C", courseExport], {
        env: common,
        stdio: ["pipe", "ignore", "pipe"],
      });
    archive.stdout.pipe(extract.stdin);
    let statuses = 0;
    for (const child of [archive, extract]) {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0)
          reject(new Error("Could not export exact Course candidate"));
        else if (++statuses === 2) resolveExport();
      });
    }
  });
}
async function ready(url, budget = 60_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error("Owned server exited before readiness");
    try {
      if (
        (
          await fetch(url, {
            signal: AbortSignal.timeout(2000),
            redirect: "manual",
          })
        ).status < 500
      )
        return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Owned server readiness timed out");
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No owned port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

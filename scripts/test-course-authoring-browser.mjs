// Owns both disposable PostgreSQL16 databases, an exact Course source export and
// loopback Next/Course servers. Accepts no database URL or live provider config.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
const requestedCourseSource = process.env.COURSE_AUTHORING_API_SOURCE;
const courseSha = process.env.COURSE_AUTHORING_API_REVISION;
if (!requestedCourseSource || !/^[a-f0-9]{40}$/u.test(courseSha ?? ""))
  throw new Error(
    "Select COURSE_AUTHORING_API_SOURCE and a full lowercase COURSE_AUTHORING_API_REVISION commit SHA",
  );
const courseSource = await realpath(resolve(requestedCourseSource));
const pgBin = process.env.PG16_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";
const temporary = await mkdtemp(join(tmpdir(), "lash-authoring-browser-"));
const cluster = join(temporary, "postgres"),
  courseExport = join(temporary, "course");
const signingKey = randomBytes(32).toString("hex"),
  authKey = randomBytes(32).toString("hex"),
  learnerKey = randomBytes(32).toString("hex");
const muxKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
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
let resultDirectory;
let sourceEvidence;
let outcome = "failed";
try {
  if ((await run("git", ["status", "--porcelain"], root)).trim())
    throw new Error(
      "Commit the exact frontend source before browser qualification",
    );
  const frontendSha = (await run("git", ["rev-parse", "HEAD"], root)).trim();
  if (
    (await realpath(
      (await run("git", ["rev-parse", "--show-toplevel"], courseSource)).trim(),
    )) !== courseSource ||
    (await run("git", ["status", "--porcelain"], courseSource)).trim() ||
    (await run("git", ["rev-parse", "HEAD"], courseSource)).trim() !== courseSha
  )
    throw new Error(
      "Select a clean Course repository at the exact requested commit",
    );
  const databasePort = await freePort(),
    coursePort = await freePort(),
    frontendPort = await freePort();
  const origin = `http://localhost:${frontendPort}`,
    apiOrigin = `http://127.0.0.1:${coursePort}`;
  const frontendUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_authoring_frontend_integration?sslmode=disable`;
  const courseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_authoring_course_integration?sslmode=disable`;
  const resultsRoot = join(root, "test-results/course-authoring-browser");
  await mkdir(resultsRoot, { recursive: true });
  resultDirectory = await mkdtemp(join(resultsRoot, "run-"));
  sourceEvidence = {
    frontendSource: frontendSha,
    frontendSourceDirectory: root,
    courseSource: courseSha,
    courseSourceDirectory: courseSource,
  };
  process.stdout.write(`Owned authoring evidence: ${resultDirectory}\n`);
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
  started = true;
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
          adminAuthenticatedAt: Math.floor(Date.now() / 1000),
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
  // Source-owned synthetic customers exist only in this disposable local DB.
  const customerIds = [randomUUID(), randomUUID()];
  const learnerToken = randomUUID();
  const supportDb = new pg.Client({ connectionString: frontendUrl });
  await supportDb.connect();
  try {
    for (const id of customerIds) await supportDb.query(
      "insert into customer_users(id,email,status) values($1,$2,'active')",
      [id, `manual-grant-${id}@example.test`],
    );
    await supportDb.query(
      "insert into customer_sessions(token_hash,user_id,expires) values($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(learnerToken).digest("hex"), customerIds[0]],
    );
  } finally { await supportDb.end(); }
  storage.manualGrantCustomerIds = customerIds;
  storage.manualGrantLearner = {
    cookies: [{
      name: "lash-customer.session-token",
      value: learnerToken,
      domain: "localhost",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [],
  };
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
    COURSE_LEARNER_JWT_CURRENT_SECRET: learnerKey,
    MUX_ENVIRONMENT_ID: "authoring-owned-fixture",
    MUX_TOKEN_ID: "authoring-owned-token-id",
    MUX_TOKEN_SECRET: "authoring-owned-token-secret",
    MUX_WEBHOOK_SECRET: "authoring-owned-webhook-secret",
    MUX_SIGNING_KEY_ID: "authoring-owned-signing-key",
    MUX_SIGNING_PRIVATE_KEY: Buffer.from(muxKeys.privateKey).toString("base64"),
    MUX_CORS_ORIGIN: origin,
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
    COURSE_LEARNER_JWT_CURRENT_SECRET: learnerKey,
    CUSTOMER_AUTH_ENABLED: "true",
    INTEGRATION_CUSTOMER_ACCESS_ENABLED: "true",
    CUSTOMER_AUTH_URL: origin,
    CUSTOMER_AUTH_SECRET: randomBytes(32).toString("hex"),
    CUSTOMER_AUTH_GOOGLE_ID: "authoring-owned-customer-client",
    CUSTOMER_AUTH_GOOGLE_SECRET: randomBytes(32).toString("hex"),
    CUSTOMER_AUTH_RESEND_KEY: "re_owned_authoring_fixture",
    CUSTOMER_AUTH_EMAIL_FROM: "Owned authoring <test@example.invalid>",
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
    INTEGRATION_LEARNING_ROUTES_ENABLED: "true",
    COURSE_AUTHORING_BROWSER_FIXTURE: "1",
    COURSE_AUTHORING_API_ORIGIN: apiOrigin,
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(
      root,
      "tests/course-authoring-browser/font-fixture.cjs",
    ),
    NODE_OPTIONS: `--require=${join(root, "tests/course-authoring-browser/gateway-fixture.cjs")}`,
  };
  children.push(
    start(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "dev",
        "--webpack",
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
    COURSE_AUTHORING_GRANT_DATABASE_URL: courseUrl,
    COURSE_AUTHORING_MUX_PUBLIC_KEY: muxKeys.publicKey,
  };
  process.stdout.write(
    `Authoring browser source frontend=${frontendSha} course=${courseSha}\n`,
  );
  await run(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config=playwright.course-authoring.config.ts",
      `--output=${join(resultDirectory, "browser")}`,
    ],
    root,
    testEnvironment,
    true,
  );
  outcome = "passed";
  await writeFile(
    join(resultDirectory, "evidence.json"),
    JSON.stringify(
      {
        ...sourceEvidence,
        courseArtifactSha256: candidateHash,
        postgresMajor: 16,
        migrationsApplied,
        gatewayWorkloadVerification: "fixture",
        frontendAdmission: "off-in-owned-local-only",
        liveProvidersCertified: false,
        stagingCertified: false,
        externalFonts: "bundled-local-fixture",
        nextBundler: "webpack-development",
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
  for (const record of children.reverse()) {
    const { child, closed } = record;
    if (!record.done && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      let deadline;
      await Promise.race([
        closed,
        new Promise((resolveDone) => {
          deadline = setTimeout(resolveDone, 3000);
        }),
      ]);
      clearTimeout(deadline);
      if (!record.done)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    }
    await closed;
  }
  let postgresStopped = !started;
  let cleanupError;
  if (started) {
    try {
      await run(join(pgBin, "pg_ctl"), [
        "-D",
        cluster,
        "-m",
        "immediate",
        "-w",
        "stop",
      ]);
      postgresStopped = true;
    } catch (error) {
      cleanupError = error;
    }
  }
  if (resultDirectory) {
    for (const name of ["course.log", "frontend.log", "postgres.log"]) {
      const log = await readFile(join(temporary, name)).catch(() => null);
      if (log)
        await writeFile(join(resultDirectory, name), log, { mode: 0o600 });
    }
    await writeFile(
      join(resultDirectory, "outcome.json"),
      JSON.stringify(
        {
          ...sourceEvidence,
          outcome: cleanupError ? "failed" : outcome,
          ownedServersStopped: true,
          ownedPostgresStopped: postgresStopped,
        },
        null,
        2,
      ) + "\n",
    );
  }
  if (postgresStopped) await rm(temporary, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}
function start(command, args, cwd, env, log) {
  const stream = createWriteStream(join(temporary, log), { mode: 0o600 });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, done: false, error: null, closed: null };
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  child.once("error", (error) => {
    record.error = error;
  });
  record.closed = new Promise((resolveClosed) =>
    child.once("close", () => {
      record.done = true;
      stream.end(resolveClosed);
    }),
  );
  return record;
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
async function exportSource() {
  const archive = join(temporary, "course-source.tar");
  await run(
    "git",
    ["archive", "--format=tar", `--output=${archive}`, courseSha],
    courseSource,
  );
  await run("tar", ["-xf", archive, "-C", courseExport]);
}
async function ready(url, budget = 60_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (
      children.some(
        ({ child, done, error }) => done || error || child.exitCode !== null,
      )
    )
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

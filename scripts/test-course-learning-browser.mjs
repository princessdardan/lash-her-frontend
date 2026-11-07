// Owns both disposable PostgreSQL16 databases, an exact Course source export and
// loopback Next/Course servers. Accepts no database URL or live provider config.
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
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
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.env.COURSE_LEARNING_BROWSER_MODE ?? "development";
const production = mode === "production";
const requestedFrontendSource = process.env.COURSE_LEARNING_FRONTEND_SOURCE;
const requestedFrontendSha = process.env.COURSE_LEARNING_FRONTEND_REVISION;
if (
  (mode !== "development" && !production) ||
  (production
    ? !requestedFrontendSource || !/^[a-f0-9]{40}$/u.test(requestedFrontendSha ?? "")
    : requestedFrontendSource !== undefined || requestedFrontendSha !== undefined)
)
  throw new Error(
    "Production mode requires COURSE_LEARNING_FRONTEND_SOURCE and full COURSE_LEARNING_FRONTEND_REVISION; development uses this checkout",
  );
const requestedCourseSource = process.env.COURSE_LEARNING_API_SOURCE;
const courseSha = process.env.COURSE_LEARNING_API_REVISION;
if (!requestedCourseSource || !/^[a-f0-9]{40}$/u.test(courseSha ?? ""))
  throw new Error(
    "Select COURSE_LEARNING_API_SOURCE and a full lowercase COURSE_LEARNING_API_REVISION commit SHA",
  );
const courseSource = await realpath(resolve(requestedCourseSource));
const pgBin = process.env.PG16_BIN_DIR ?? "/opt/homebrew/opt/postgresql@16/bin";
const temporary = await mkdtemp(join(tmpdir(), "lash-learning-browser-"));
const cluster = join(temporary, "postgres"),
  courseExport = join(temporary, "course");
const frontendApp = production ? join(temporary, "frontend") : root;
const scenarios = production ? ["flight", "assessment"] : ["journey", "conflict", "boundaries"];
const signingKey = randomBytes(32).toString("hex"),
  learnerKey = randomBytes(32).toString("hex"),
  authKey = randomBytes(32).toString("hex");
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
let frontendTls;
let outcome = "failed";
try {
  const frontendSource = production ? await realpath(resolve(requestedFrontendSource)) : root;
  const frontendSha = await checkedRevision(frontendSource, requestedFrontendSha, "frontend");
  await checkedRevision(courseSource, courseSha, "Course");
  const databasePort = await freePort(), coursePort = await freePort();
  if (production) frontendTls = await loopbackTlsProxy();
  const frontendPort = frontendTls?.server.address().port ?? await freePort();
  const origin = frontendTls?.origin ?? `http://localhost:${frontendPort}`,
    apiOrigin = `http://127.0.0.1:${coursePort}`;
  const frontendUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_learning_frontend_integration?sslmode=disable`;
  const courseUrl = `postgresql://postgres@127.0.0.1:${databasePort}/lash_learning_course_integration?sslmode=disable`;
  const resultsRoot = join(root, "test-results/course-learning-browser");
  await mkdir(resultsRoot, { recursive: true });
  resultDirectory = await mkdtemp(join(resultsRoot, "run-"));
  sourceEvidence = {
    frontendSource: frontendSha,
    frontendSourceDirectory: frontendSource,
    courseSource: courseSha,
    courseSourceDirectory: courseSource,
  };
  process.stdout.write(`Owned actual learner evidence: ${resultDirectory}\n`);
  await exportSource(courseSource, courseSha, courseExport);
  if (production) await exportSource(frontendSource, frontendSha, frontendApp);
  const candidateHash = createHash("sha256")
    .update(
      await readFile(
        join(frontendApp, "contracts/api-integration/p2-candidate/course-api.json"),
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
    await admin.query("create database lash_learning_frontend_integration");
    await admin.query("create database lash_learning_course_integration");
  } finally {
    await admin.end();
  }
  for (const [url, migrationsFolder] of [
    [frontendUrl, join(frontendApp, "drizzle")],
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
  const fixture = {
    origin,
    apiOrigin,
    adminKey: signingKey,
    frontendDatabaseUrl: frontendUrl,
    courseDatabaseUrl: courseUrl,
    muxPublicKey: muxKeys.publicKey,
    ...(frontendTls ? { browserCertificateSpki: frontendTls.spki } : {}),
    scenarios: {},
  };
  const client = new pg.Client({ connectionString: frontendUrl });
  await client.connect();
  try {
    for (const project of ["chromium", "mobile"]) {
      fixture.scenarios[project] = {};
      for (const scenario of scenarios) {
        const users = {};
        for (const name of ["learner", "other"]) {
          const id = randomUUID(),
            token = randomUUID();
          await client.query(
            "insert into customer_users(id,email,email_verified) values($1,$2,now())",
            [id, `owned-${id}@example.invalid`],
          );
          await client.query(
            "insert into customer_sessions(token_hash,user_id,expires) values($1,$2,now()+interval '1 hour')",
            [createHash("sha256").update(token).digest("hex"), id],
          );
          users[name] = {
            id,
            storage: {
              cookies: [
                {
                  name: `${production ? "__Host-" : ""}lash-customer.session-token`,
                  value: token,
                  domain: "localhost",
                  path: "/",
                  expires: Math.floor(Date.now() / 1000) + 3600,
                  httpOnly: true,
                  secure: production,
                  sameSite: "Lax",
                },
              ],
              origins: [],
            },
          };
        }
        fixture.scenarios[project][scenario] = { users };
      }
    }
  } finally {
    await client.end();
  }
  const courseEnv = {
    ...common,
    NODE_ENV: "test",
    DATABASE_TARGET: "test",
    TEST_DATABASE_URL: courseUrl,
    PORT: String(coursePort),
    HTTP_BIND_ADDRESS: "127.0.0.1",
    COURSE_ADMIN_JWT_CURRENT_SECRET: signingKey,
    COURSE_LEARNER_JWT_CURRENT_SECRET: learnerKey,
    COURSE_ACCOUNT_LIFECYCLE_ENABLED: "true",
    COURSE_ACCOUNT_LIFECYCLE_JWT_CURRENT_SECRET:
      randomBytes(32).toString("hex"),
    MUX_ENVIRONMENT_ID: "learning-owned-fixture",
    MUX_TOKEN_ID: "learning-owned-token-id",
    MUX_TOKEN_SECRET: "learning-owned-token-secret",
    MUX_WEBHOOK_SECRET: "learning-owned-webhook-secret",
    MUX_SIGNING_KEY_ID: "learning-owned-signing-key",
    MUX_SIGNING_PRIVATE_KEY: Buffer.from(muxKeys.privateKey).toString("base64"),
    MUX_CORS_ORIGIN: origin,
    COURSE_LEARNING_BROWSER_FIXTURE: "1",
    NODE_OPTIONS: `--require=${join(root, "tests/course-learning-browser/course-provider-guard.cjs")}`,
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
  const courseRequest = async (method, path, body, { audience, subject, secret, capabilities }) => {
    const now = Math.floor(Date.now() / 1000),
      header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        iss: "lash-her-frontend",
        aud: audience,
        sub: subject,
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
        ...(capabilities ? { capabilities } : {}),
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const response = await fetch(new URL(path, apiOrigin), {
      method,
      headers: {
        authorization: `Bearer ${header}.${payload}.${signature}`,
        "content-type": "application/json",
        ...(body?.idempotencyKey ? { "x-idempotency-key": body.idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw new Error(
        `Owned Course seed request failed: ${method} ${path} ${response.status}`,
      );
    return response.json();
  };
  const courseAdmin = (method, path, body) => courseRequest(method, path, body, {
    audience: "lash-her-course-api:admin",
    subject: "11111111-1111-4111-8111-111111111111",
    secret: signingKey,
    capabilities: ["course-editor", "course-support"],
  });
  const mediaClient = new pg.Client({ connectionString: courseUrl });
  await mediaClient.connect();
  try {
    for (const project of ["chromium", "mobile"])
      for (const scenario of scenarios) {
        const slug = `actual-learning-${project}-${scenario}`;
        const { course } = await courseAdmin("POST", "/v1/admin/courses", {
          slug,
          title: "Actual learning foundations",
          priceCents: 0,
          currency: "CAD",
          accessMode: "free",
          taxClassification: "owned-reviewed-fixture",
        });
        let revision = 1;
        const { module } = await courseAdmin(
          "POST",
          `/v1/admin/courses/${course.id}/modules`,
          {
            expectedCourseRevision: revision++,
            title: "Foundations",
            slug: "foundations",
            position: 1,
          },
        );
        const lessonIds = {};
        for (const [index, mode] of ["practice", "graded"].entries()) {
          const denialFixture = production && mode === "practice";
          const { lesson } = await courseAdmin(
            "POST",
            `/v1/admin/modules/${module.id}/lessons`,
            {
              expectedCourseRevision: revision++,
              title: mode === "practice" ? "Practice lesson" : "Graded lesson",
              slug: mode,
              position: index + 1,
              transcript: "A gentle approach protects the natural lash." +
                (denialFixture ? " p2q-s07-private-transcript" : ""),
              contentDocument: {
                version: 1,
                blocks: [
                  {
                    _type: "block",
                    _key: `${mode}-block`,
                    children: [
                      {
                        _type: "span",
                        _key: `${mode}-text`,
                        text: `Private actual ${mode} lesson content.`,
                      },
                    ],
                  },
                  ...(denialFixture ? [{
                    _type: "block",
                    _key: "lesson-denial-canary",
                    children: [{ _type: "span", _key: "lesson-denial-canary-text", text: "p2q-s07-private-content" }],
                  }] : []),
                ],
              },
              captions: [
                {
                  language: "en",
                  label: "English",
                  url: "https://learning-media.example.invalid/actual.vtt",
                },
              ],
            },
          );
          lessonIds[mode] = lesson.id;
          await courseAdmin("PUT", `/v1/admin/lessons/${lesson.id}/quiz`, {
            expectedCourseRevision: revision++,
            document: {
              version: 1,
              mode,
              passingPercent: 80,
              questions: [
                {
                  id: "q1",
                  prompt: "Which approach protects the natural lash?" +
                    (denialFixture ? " p2q-s07-private-quiz" : ""),
                  options: [
                    { id: "gentle", text: "Use gentle care" },
                    { id: "pull", text: "Pull the extensions" },
                  ],
                  correctOptionId: "gentle",
                  feedback: "Careful practice supports healthy lashes.",
                },
                {
                  id: "q2",
                  prompt: "When can you revisit the lesson?",
                  options: [
                    { id: "anytime", text: "At your own pace" },
                    { id: "never", text: "Only once" },
                  ],
                  correctOptionId: "anytime",
                  feedback: "Return to the reviewed technique.",
                },
              ],
            },
          });
          if (scenario !== "assessment") await mediaClient.query(
            "insert into video_assets(lesson_id,generation,is_current,managed_by_course,provider_environment_id,status,mux_asset_id,mux_playback_id,caption_tracks) values($1,1,true,true,'learning-owned-fixture','ready',$2,$3,'[]'::jsonb)",
            [
              lesson.id,
              `owned-asset-${randomUUID()}`,
              `ownedPlayback${randomUUID().replaceAll("-", "")}`,
            ],
          );
        }
        const published = await courseAdmin("PATCH", `/v1/admin/courses/${course.id}`, {
          expectedRevision: revision,
          status: "published",
        });
        const selected = fixture.scenarios[project][scenario];
        if (scenario === "assessment") await courseRequest(
          "POST", `/v1/student/courses/${course.id}/enrollments`, { idempotencyKey: randomUUID() },
          { audience: "lash-her-course-api:learner", subject: selected.users.learner.id, secret: learnerKey },
        );
        Object.assign(selected, {
          courseId: course.id,
          courseRevision: published.course.revision,
          slug,
          lessonIds,
        });
      }
  } finally {
    await mediaClient.end();
  }
  const storagePath = join(temporary, "fixture.json");
  const gatewayJournal = join(temporary, "gateway-requests.jsonl");
  await writeFile(gatewayJournal, "", { mode: 0o600 });
  fixture.gatewayJournal = gatewayJournal;
  await writeFile(storagePath, JSON.stringify(fixture), { mode: 0o600 });
  const frontendEnv = {
    ...common,
    ...(production ? {
      // Run the real prebuild validator with owned inputs. External bindings
      // point at test-only placeholders and the preload refuses provider I/O.
      SANITY_API_READ_TOKEN: randomBytes(32).toString("hex"),
      SANITY_WRITE_TOKEN: randomBytes(32).toString("hex"),
      SANITY_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
      ADMIN_OWNER_EMAILS: "owner@example.invalid",
      RESEND_API_KEY: "re_owned_learning_fixture",
      RESEND_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
      RESEND_SEGMENT_MARKETING_ID: randomUUID(),
      FROM_EMAIL: "from@example.invalid",
      ADMIN_EMAIL: "owner@example.invalid",
      GOOGLE_CLIENT_ID: "owned-learning-calendar-client",
      GOOGLE_CLIENT_SECRET: randomBytes(32).toString("hex"),
      GOOGLE_REDIRECT_URI: `${origin}/api/auth/callback/google`,
      BOOKING_ADMIN_SETUP_SECRET: randomBytes(32).toString("hex"),
      KV_REST_API_URL: "https://learning-kv.invalid",
      KV_REST_API_TOKEN: randomBytes(32).toString("hex"),
      CHECKOUT_SECRET_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      BOOKING_CALENDAR_CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      SERVICE_BOOKING_MODEL_MODE: "dual",
      PAYMENT_RECONCILIATION_CRON_SECRET: randomBytes(32).toString("hex"),
      CRON_SECRET: randomBytes(32).toString("hex"),
      BACKUP_RETENTION_DAYS: "0",
      NODE_EXTRA_CA_CERTS: frontendTls.certPath,
    } : {}),
    NODE_ENV: mode,
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
    CUSTOMER_AUTH_GOOGLE_ID: "owned-learning-customer-client",
    CUSTOMER_AUTH_GOOGLE_SECRET: randomBytes(32).toString("hex"),
    CUSTOMER_AUTH_RESEND_KEY: "re_owned_learning_fixture",
    CUSTOMER_AUTH_EMAIL_FROM: "Owned learning <test@example.invalid>",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_TARGET_ENV: "production",
    APP_ENV: "staging",
    APP_VERCEL_TEAM_ID: "team_2Hrn5eMZyZxfAWdmYvyKi9t3",
    VERCEL_PROJECT_ID: "prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM",
    VERCEL_OIDC_TOKEN: workload,
    NEXT_PUBLIC_SANITY_PROJECT_ID: "7o23yrvk",
    NEXT_PUBLIC_SANITY_DATASET: "staging-2026-05-10",
    NEXT_PUBLIC_SANITY_API_VERSION: "2026-03-24",
    NEXT_PUBLIC_SITE_URL: production ? "https://staging.lashher.com" : origin,
    API_GATEWAY_STAGING_ORIGIN: "https://learning-gateway.invalid",
    INTEGRATION_COURSE_READS_ENABLED: "true",
    INTEGRATION_LEARNING_ROUTES_ENABLED: "true",
    COURSE_LEARNING_BROWSER_FIXTURE: "1",
    COURSE_LEARNING_BROWSER_MODE: mode,
    COURSE_LEARNING_API_ORIGIN: apiOrigin,
    COURSE_LEARNING_GATEWAY_JOURNAL: gatewayJournal,
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(
      root,
      "tests/course-learning-browser/font-fixture.cjs",
    ),
    NODE_OPTIONS: `${production ? "--dns-result-order=ipv6first " : ""}--require=${JSON.stringify(join(root, "tests/course-learning-browser/gateway-fixture.cjs"))}`,
  };
  if (production) {
    await run(process.execPath, ["scripts/validate-sanity-env.mjs"], frontendApp, frontendEnv);
    const build = start(
      process.execPath,
      ["node_modules/next/dist/bin/next", "build", "--webpack"],
      frontendApp,
      frontendEnv,
      "frontend-build.log",
    );
    children.push(build);
    await build.closed;
    if (build.error || build.child.exitCode !== 0)
      throw new Error("Owned Next production build failed", { cause: build.error });
    children.pop();
  }
  children.push(
    start(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        ...(production ? ["start"] : ["dev", "--webpack"]),
        "--hostname",
        production ? "localhost" : "127.0.0.1",
        "--port",
        String(frontendPort),
      ],
      frontendApp,
      frontendEnv,
      "frontend.log",
    ),
  );
  await ready(`http://${production ? "[::1]" : "localhost"}:${frontendPort}/courses`, 180_000);
  const testEnvironment = {
    ...common,
    COURSE_LEARNING_BROWSER_FIXTURE: "1",
    COURSE_LEARNING_BROWSER_MODE: mode,
    COURSE_LEARNING_BROWSER_ORIGIN: origin,
    COURSE_LEARNING_STORAGE_PATH: storagePath,
  };
  process.stdout.write(
    `Actual learner browser source frontend=${frontendSha} course=${courseSha}\n`,
  );
  await run(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config=playwright.course-learning.config.ts",
      production ? "--grep" : "--grep-invert",
      "production Academy",
      `--output=${join(resultDirectory, "browser")}`,
    ],
    root,
    testEnvironment,
    true,
  );
  const stored = new pg.Client({ connectionString: courseUrl });
  let persisted;
  await stored.connect();
  try {
    persisted = {
      grants: (
        await stored.query(
          "select grant_reason,status,count(*)::int count from entitlement_grants group by grant_reason,status order by grant_reason,status",
        )
      ).rows,
      progress: (
        await stored.query(
          "select count(*)::int rows,count(*) filter(where completed_at is not null)::int completed from lesson_progress",
        )
      ).rows[0],
      attempts: (
        await stored.query(
          "select qr.document->>'mode' mode,count(*)::int attempts,count(*) filter(where qa.completed)::int completed from quiz_attempts qa join quiz_revisions qr on qr.id=qa.quiz_revision_id group by qr.document->>'mode' order by mode",
        )
      ).rows,
    };
  } finally {
    await stored.end();
  }
  await writeFile(
    join(resultDirectory, "persistence.json"),
    JSON.stringify(persisted, null, 2) + "\n",
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
        nextBundler: production ? "webpack-production" : "webpack-development",
        ...(frontendTls ? { loopbackTlsSpkiSha256: frontendTls.spki } : {}),
        customerSessions:
          "owned synthetic SQL sessions, actual frontend validation and fenced signer",
        courseBackend:
          "actual selected server, JWT verifier, routes and PostgreSQL",
        muxSigning: "actual SDK with generated owned RSA key; no provider HTTP",
        mediaAssets: "synthetic ready rows and local intercepted HLS/captions",
        muxPublicKeySha256: createHash("sha256")
          .update(muxKeys.publicKey)
          .digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    "Owned Next/Course/PostgreSQL16 actual learner browser checks passed; gateway workload verification and live providers remain outside this fixture\n",
  );
} catch (error) {
  for (const name of ["course.log", "frontend-build.log", "frontend.log"]) {
    const log = await readFile(join(temporary, name), "utf8").catch(() => "");
    if (log) process.stderr.write(`${name}:\n${log.slice(-18000)}\n`);
  }
  throw error;
} finally {
  if (frontendTls) {
    const closed = new Promise(resolveClose => frontendTls.server.close(resolveClose));
    frontendTls.server.closeAllConnections();
    await closed;
  }
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
    for (const name of ["course.log", "frontend-build.log", "frontend.log", "postgres.log"]) {
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
async function checkedRevision(source, expected, name) {
  const revision = (await run("git", ["rev-parse", "HEAD"], source)).trim();
  if (
    (await realpath((await run("git", ["rev-parse", "--show-toplevel"], source)).trim())) !== source ||
    (await run("git", ["status", "--porcelain"], source)).trim() ||
    (expected !== undefined && revision !== expected)
  )
    throw new Error(`Select a clean ${name} repository at the exact requested commit`);
  return revision;
}
async function exportSource(source, revision, destination) {
  const archive = `${destination}.tar`;
  await mkdir(destination);
  await run(
    "git",
    ["archive", "--format=tar", `--output=${archive}`, revision],
    source,
  );
  await run("tar", ["-xf", archive, "-C", destination]);
  if (
    (await readFile(join(destination, "package-lock.json"), "utf8")) !==
    (await readFile(join(source, "package-lock.json"), "utf8"))
  )
    throw new Error("Owned dependency tree must match the exported lockfile");
  await symlink(await realpath(join(source, "node_modules")), join(destination, "node_modules"));
}
async function loopbackTlsProxy() {
  // Production customer auth requires HTTPS. Keep Next's real production config
  // and terminate TLS on IPv4 in front of next start on IPv6. Sharing the port
  // preserves the exact origin that Next uses to construct Request.url.
  const keyPath = join(temporary, "frontend-tls.key");
  const certPath = join(temporary, "frontend-tls.crt");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    "-keyout", keyPath, "-out", certPath]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const spki = createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" }))
    .digest("base64");
  const server = createHttpsServer({ key, cert }, (request, response) => {
    const port = server.address().port;
    const host = `localhost:${port}`;
    if (request.headers.host !== host || !request.url?.startsWith("/") || request.url.startsWith("//")) {
      response.writeHead(400).end();
      return;
    }
    const upstream = httpRequest({
      hostname: "::1",
      port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, "x-forwarded-for": "127.0.0.1", "x-forwarded-host": host, "x-forwarded-proto": "https", "x-forwarded-port": String(port) },
    }, reply => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.on("error", () => response.destroy());
      reply.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return { server, origin: `https://localhost:${server.address().port}`, certPath, spki };
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

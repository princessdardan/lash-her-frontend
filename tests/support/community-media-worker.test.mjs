import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import sharp from "sharp";
import { createMediaBindingFixture } from "./community-media-bindings.mjs";

const bucket = "community-media-fixture";
const signedOrigin = "http://127.0.0.1:4110";
const memberKey = "synthetic-isolated-community-workload-member-key";
const dbName = "community_media_worker_test";
const dbPassword = "isolated-workload-postgres";
const memoryLimit = 384 * 1024 * 1024;
const authority = `
  import { createServer } from "node:http";
  createServer(async (request, response) => {
    if (request.url !== "/v1/internal/community/entitlements/check" ||
        request.method !== "POST" || !request.headers.authorization?.startsWith("Bearer ")) {
      return response.writeHead(404).end();
    }
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    const {userId, courseId} = JSON.parse(Buffer.concat(parts));
    response.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({
      userId, courseId, hasAccess:courseId === process.env.FIXTURE_COURSE_ID,
      expiresAt:null, evaluatedAt:new Date().toISOString(),
    }));
  }).listen(4109, "127.0.0.1");
`;

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 240_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requirePublishedRuntime(reference) {
  assert.match(
    reference,
    /^ghcr\.io\/princessdardan\/lash-her-platform-community-runtime@sha256:[a-f0-9]{64}$/u,
  );
  const digests = JSON.parse(
    docker("image", "inspect", "--format", "{{json .RepoDigests}}", reference),
  );
  assert.ok(digests.includes(reference));
}

async function until(label, check, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(75);
  } while (performance.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

function jwt(userId) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    version: 1,
    iss: "lash-her-frontend",
    aud: "lash-her-community-api:member",
    sub: userId,
    iat,
    exp: iat + 300,
    jti: randomUUID(),
  };
  const unsigned = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return (
    unsigned +
    "." +
    createHmac("sha256", memberKey).update(unsigned).digest("base64url")
  );
}

function upload(ticket, body, store) {
  const signed = new URL(ticket.url);
  assert.equal(signed.origin, signedOrigin);
  assert.match(
    signed.pathname,
    new RegExp(`^/${bucket}/quarantine/[a-f0-9-]{36}$`),
  );
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest(
      store + signed.pathname + signed.search,
      {
        method: "PUT",
        headers: {
          ...ticket.headers,
          host: signed.host,
          "content-length": body.length,
        },
        signal: AbortSignal.timeout(15_000),
      },
      (response) => {
        response.resume();
        response.once("end", () => resolveStatus(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function fetchSignedView(url, store) {
  const signed = new URL(url);
  assert.equal(signed.origin, signedOrigin);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      store + signed.pathname + signed.search,
      { headers: { host: signed.host }, signal: AbortSignal.timeout(4_000) },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolveResponse({
            status: response.statusCode,
            type: response.headers["content-type"],
          }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test(
  "Community media worker readiness, workload, retry and restart recovery",
  { timeout: 360_000 },
  async (t) => {
    const checkout = process.env.COMMUNITY_E2E_COMMUNITY_ROOT;
    assert.ok(
      checkout?.startsWith("/"),
      "Set COMMUNITY_E2E_COMMUNITY_ROOT to the absolute Community checkout",
    );
    const postgresImage =
      process.env.COMMUNITY_MEDIA_WORKER_POSTGRES_IMAGE ??
      "postgres:16.16-bookworm";
    assert.match(
      postgresImage,
      /^(?:docker\.io\/library\/)?postgres(?::[\w.-]+|@sha256:[a-f0-9]{64})$/u,
      "Use a local official PostgreSQL image tag or pinned digest",
    );
    const name = "lash-media-workload-" + randomUUID().slice(0, 8);
    const publishedImage = process.env.COMMUNITY_MEDIA_CURRENT_RUNTIME;
    const image = publishedImage ?? name + ":local";
    const previousImage = process.env.COMMUNITY_MEDIA_PREVIOUS_RUNTIME;
    const composeFixture =
      process.env.COMMUNITY_MEDIA_WORKER_USE_COMPOSE === "1";
    if (publishedImage || previousImage)
      assert.ok(
        composeFixture,
        "Published runtimes require the Compose fixture",
      );
    if (publishedImage) requirePublishedRuntime(publishedImage);
    if (previousImage) requirePublishedRuntime(previousImage);
    assert.notEqual(image, previousImage);
    const pgContainer = name + "-postgres";
    const storeContainer = name + "-storage";
    const apiContainer = name + "-api";
    const workers = [name + "-worker-a", name + "-worker-b"];
    const containers = [];
    const course = randomUUID();
    const learners = Array.from({ length: 10 }, () => randomUUID());
    let pool;
    let bindings;
    let networkCreated = false;
    let imageBuilt = false;

    const start = (container, ...args) => {
      containers.push(container);
      return docker("run", "-d", "--pull=never", "--name", container, ...args);
    };
    const startBound = (container, service, mediaEnabled = true) => {
      containers.push(container);
      return bindings.start(container, service, mediaEnabled);
    };
    const port = (container, internal) => {
      const address = docker("port", container, `${internal}/tcp`);
      assert.match(address, /^127\.0\.0\.1:\d+$/u);
      return address;
    };
    const connectDatabase = () => {
      const client = new pg.Pool({
        connectionString: `postgresql://postgres:${dbPassword}@${port(pgContainer, 5432)}/${dbName}`,
        connectionTimeoutMillis: 1000,
        max: 4,
      });
      client.on("error", () => {}); // The test intentionally stops PostgreSQL.
      return client;
    };
    const runtime = [
      "--init",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--tmpfs=/tmp:size=32m",
    ];
    const storage = [
      "-e",
      `COMMUNITY_MEDIA_BUCKET=${bucket}`,
      "-e",
      "COMMUNITY_MEDIA_REGION=us-east-1",
      "-e",
      `COMMUNITY_MEDIA_TEST_ENDPOINT=${signedOrigin}`,
      "-e",
      "AWS_EC2_METADATA_DISABLED=true",
      "-e",
      "AWS_ACCESS_KEY_ID=community-media-test",
      "-e",
      "AWS_SECRET_ACCESS_KEY=synthetic-private-media-object-storage-key",
    ];
    const databaseUrl = `postgresql://postgres:${dbPassword}@postgres:5432/${dbName}?sslmode=disable`;
    const db = [
      "-e",
      "NODE_ENV=test",
      "-e",
      "DATABASE_TARGET=test",
      "-e",
      "DOTENV_CONFIG_PATH=/dev/null",
      "-e",
      `TEST_DATABASE_URL=${databaseUrl}`,
    ];
    let api;
    let store;
    let worker;
    const request = async (url, expected, options = {}) => {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(4_000),
      });
      assert.equal(
        response.status,
        expected,
        `${options.method ?? "GET"} ${new URL(url).pathname}`,
      );
      return response;
    };
    const call = async (user, path, status, method = "GET", body) => {
      const headers = { authorization: `Bearer ${jwt(user)}` };
      if (body !== undefined) headers["content-type"] = "application/json";
      return (
        await request(api + path, status, {
          method,
          headers,
          body: JSON.stringify(body),
        })
      ).json();
    };
    const fixture = async (path) => {
      await request(store + "/fixture/" + path, 204, { method: "PUT" });
    };
    const objects = async () =>
      (await request(store + "/fixture/objects", 200)).json();
    const asset = async (id) =>
      (
        await pool.query(
          `select *, extract(epoch from available_at-now()) as retry_seconds
     from community_discussion_media where id=$1`,
          [id],
        )
      ).rows[0];
    const workerStatus = async (path) => {
      if (bindings) {
        const code =
          "fetch('http://127.0.0.1:4111'+process.argv[1],{signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status),()=>console.log(0))";
        return Number(docker("exec", storeContainer, "node", "-e", code, path));
      }
      return (
        await fetch(worker + path, {
          signal: AbortSignal.timeout(3_000),
        }).catch(() => null)
      )?.status;
    };
    const ready = (status = 200) =>
      until(
        `worker readiness ${status}`,
        async () => (await workerStatus("/ready")) === status,
      );
    const startWorker = (container) =>
      bindings
        ? startBound(container, "community-media-worker")
        : start(
            container,
            "--network",
            `container:${storeContainer}`,
            ...runtime,
            "--memory=384m",
            "--cpus=0.4",
            ...db,
            ...storage,
            "-e",
            "WORKER_PORT=4111",
            "-e",
            "WORKER_POLL_INTERVAL_MS=500",
            "-e",
            "NODE_OPTIONS=--max-old-space-size=256",
            image,
            "node",
            "dist/media/run-worker.js",
          );
    const sampleWorker = (container) => {
      const sample = JSON.parse(
        docker(
          "exec",
          container,
          "node",
          "-e",
          `
      const {readFileSync}=require("node:fs");
      const read=(name)=>readFileSync("/sys/fs/cgroup/"+name,"utf8").trim();
      const events=Object.fromEntries(read("memory.events").split("\\n").map(line=>line.split(" ")));
      console.log(JSON.stringify({arch:process.arch,peak:Number(read("memory.peak")),
        limit:Number(read("memory.max")),cpu:read("cpu.max"),pids:read("pids.max"),oom:Number(events.oom)}));
    `,
        ),
      );
      assert.equal(sample.limit, memoryLimit);
      assert.equal(sample.cpu, "40000 100000");
      assert.equal(sample.pids, "128");
      assert.ok(sample.peak > 0 && sample.peak < memoryLimit);
      assert.equal(sample.oom, 0);
      return sample;
    };

    try {
      if (!publishedImage) {
        docker(
          "build",
          "--quiet",
          "--target",
          "worker",
          "--tag",
          image,
          checkout,
        );
        imageBuilt = true;
      }
      if (composeFixture) {
        bindings = createMediaBindingFixture({
          name,
          image,
          previousImage,
          storeContainer,
          databaseUrl,
          workerDatabaseUrl: `postgresql://lash_her_community_media_worker:synthetic-worker-db-password@postgres:5432/${dbName}?sslmode=verify-full`,
          bucket,
          memberKey,
          signedOrigin,
        });
        t.diagnostic(
          "Compose model verified with separate API and worker AWS session bindings.",
        );
      }
      docker("network", "create", name);
      networkCreated = true;
      start(
        pgContainer,
        "--network",
        name,
        "--network-alias",
        "postgres",
        "-p",
        "127.0.0.1::5432",
        "-e",
        `POSTGRES_PASSWORD=${dbPassword}`,
        "-e",
        `POSTGRES_DB=${dbName}`,
        ...(bindings ? bindings.postgresArgs(postgresImage) : [postgresImage]),
      );
      start(
        storeContainer,
        "--network",
        name,
        "-p",
        "127.0.0.1::4108",
        "-p",
        "127.0.0.1::4110",
        ...(bindings ? [] : ["-p", "127.0.0.1::4111"]),
        "--mount",
        `type=bind,source=${resolve("tests/support/community-media-s3.mjs")},target=/fixture.mjs,readonly`,
        "-e",
        "COMMUNITY_MEDIA_E2E=1",
        "-e",
        "COMMUNITY_MEDIA_FIXTURE_BIND=0.0.0.0",
        ...(bindings
          ? [
              "-e",
              `COMMUNITY_MEDIA_FIXTURE_SESSIONS=${bindings.fixtureSessions}`,
            ]
          : []),
        image,
        "node",
        "/fixture.mjs",
      );
      start(
        name + "-authority",
        "--network",
        `container:${storeContainer}`,
        "-e",
        `FIXTURE_COURSE_ID=${course}`,
        image,
        "node",
        "--input-type=module",
        "-e",
        authority,
      );
      pool = connectDatabase();
      await until("the disposable database", () =>
        pool.query("select 1").catch(() => false),
      );
      const { rows: databaseVersion } = await pool.query("show server_version");
      t.diagnostic(
        `Disposable database: PostgreSQL ${databaseVersion[0].server_version}`,
      );
      docker(
        "run",
        "--rm",
        "--pull=never",
        "--network",
        name,
        ...db,
        "--mount",
        `type=bind,source=${checkout}/drizzle,target=/migrations,readonly`,
        image,
        "node",
        "--input-type=module",
        "-e",
        `
        import pg from "pg";
        import {drizzle} from "drizzle-orm/node-postgres";
        import {migrate} from "drizzle-orm/node-postgres/migrator";
        const pool = new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
        try { await migrate(drizzle(pool),{migrationsFolder:"/migrations"}); } finally { await pool.end(); }
      `,
      );
      await pool.query(
        "insert into community_spaces (course_id,title) values ($1,'Media workload fixture')",
        [course],
      );
      if (bindings) {
        await pool.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`);
        await pool.query(`CREATE ROLE lash_her_community_media_worker
          LOGIN PASSWORD 'synthetic-worker-db-password' NOSUPERUSER NOCREATEDB
          NOCREATEROLE NOINHERIT NOBYPASSRLS`);
        await pool.query(
          readFileSync(
            "ops/platform/community-media-worker-grants.sql",
            "utf8",
          ),
        );
        const {
          rows: [scope],
        } = await pool.query(`
          SELECT
            has_column_privilege('lash_her_community_media_worker', 'community_content', 'id', 'SELECT') as can_read_post_id,
            has_column_privilege('lash_her_community_media_worker', 'community_content', 'body', 'SELECT') as can_read_body,
            has_column_privilege('lash_her_community_media_worker', 'community_discussion_media', 'owner_id', 'UPDATE') as can_update_owner
        `);
        assert.deepEqual(scope, {
          can_read_post_id: true,
          can_read_body: false,
          can_update_owner: false,
        });
      }
      if (bindings) startBound(apiContainer, "community-api");
      else
        start(
          apiContainer,
          "--network",
          `container:${storeContainer}`,
          ...runtime,
          "--memory=512m",
          "--cpus=0.6",
          ...db,
          ...storage,
          "-e",
          "PORT=4108",
          "-e",
          "COURSE_API_BASE_URL=http://127.0.0.1:4109",
          "-e",
          "COMMUNITY_READER_JWT_CURRENT_SECRET=synthetic-isolated-community-workload-reader-key",
          "-e",
          `COMMUNITY_MEMBER_JWT_CURRENT_SECRET=${memberKey}`,
          image,
          "node",
          "dist/server.js",
        );
      api = "http://" + port(storeContainer, 4108);
      store = "http://" + port(storeContainer, 4110);
      if (!bindings) worker = "http://" + port(storeContainer, 4111);
      await until(
        "the API",
        async () => (await fetch(api + "/ready").catch(() => null))?.ok,
      );
      await until(
        "the object fixture",
        async () =>
          (await fetch(store + "/fixture/objects").catch(() => null))?.ok,
      );
      startWorker(workers[0]);
      await ready();
      assert.equal(await workerStatus("/health"), 200);
      if (bindings) {
        const {
          rows: [session],
        } = await pool.query(`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity AS a JOIN pg_stat_ssl AS s USING (pid)
            WHERE a.usename = 'lash_her_community_media_worker' AND s.ssl
          ) AS tls
        `);
        assert.equal(session.tls, true);
        t.diagnostic(
          "Restricted worker database login connected over verified TLS.",
        );
      }

      const width = 4096;
      const height = 2929;
      const original = await sharp(randomBytes(width * height * 3), {
        raw: { width, height, channels: 3 },
      })
        .jpeg({ quality: 89 })
        .toBuffer();
      assert.ok(
        original.length >= 8 * 1024 * 1024 &&
          original.length <= 10 * 1024 * 1024,
        `Expected a near-limit original, saw ${original.length} bytes`,
      );
      const small = await sharp({
        create: { width: 96, height: 64, channels: 3, background: "#78694e" },
      })
        .jpeg()
        .toBuffer();
      const feed = `/v1/spaces/${course}/posts`;
      const postIds = await Promise.all(
        learners.slice(0, 3).map(
          async (owner) =>
            (
              await call(owner, feed, 201, "POST", {
                body: "Synthetic worker workload",
              })
            ).id,
        ),
      );
      const queue = async (owner, post, bytes, id = randomUUID()) => {
        const ticket = await call(
          owner,
          `/v1/discussions/${post}/media`,
          201,
          "POST",
          {
            id,
            type: "image/jpeg",
            bytes: bytes.length,
            checksum: createHash("sha256").update(bytes).digest("base64"),
          },
        );
        assert.equal(ticket.id, id);
        assert.equal(await upload(ticket, bytes, store), 200);
        await call(owner, `/v1/media/${id}/complete`, 202, "POST", {});
        return id;
      };

      let reading = true;
      let requests = 0;
      const reads = (async () => {
        while (reading) {
          await Promise.all(learners.map((user) => call(user, feed, 200)));
          requests += learners.length;
          await delay(750);
        }
      })();
      // Hold a reference to the rejection while the upload assertions are in flight.
      reads.catch(() => {});
      const started = performance.now();
      let controlAsset;
      let renewed;
      try {
        const batches = await Promise.all(
          postIds.map(async (post, index) => {
            const ids = [];
            for (let count = 0; count < 3; count++)
              ids.push(await queue(learners[index], post, original));
            return ids;
          }),
        );
        const ids = batches.flat();
        await until(
          "all nine near-limit derivatives",
          async () => {
            const { rows } = await pool.query(
              "select status,width,height,attempts from community_discussion_media where id=any($1::uuid[])",
              [ids],
            );
            if (rows.length !== 9 || rows.some((row) => row.status !== "ready"))
              return false;
            for (const row of rows)
              assert.deepEqual(row, {
                status: "ready",
                width: 1600,
                height: 1144,
                attempts: 1,
              });
            return true;
          },
          90_000,
        );
        await ready();
        if (bindings) {
          controlAsset = ids[0];
          const ticket = await call(
            learners[0],
            `/v1/media/${ids[0]}/view`,
            200,
          );
          assert.deepEqual(await fetchSignedView(ticket.url, store), {
            status: 200,
            type: "image/webp",
          });
          t.diagnostic(
            "API session signed an upload and authorized a processed view. The worker session wrote and cleaned media.",
          );
          renewed = { api: bindings.renew("api") };
          // A desktop VM may take a moment to observe the host rename.
          await until(
            "renewed API session visible in the container",
            () =>
              docker(
                "exec",
                apiContainer,
                "node",
                "--input-type=module",
                "-e",
                'try { const {readMediaSession}=await import("./dist/media/session.js"); console.log((await readMediaSession()).accessKeyId === process.argv[1]); } catch { console.log(false); }',
                renewed.api,
              ) === "true",
          );
          const renewedView = await call(
            learners[0],
            `/v1/media/${controlAsset}/view`,
            200,
          );
          assert.equal(
            new URL(renewedView.url).searchParams
              .get("X-Amz-Credential")
              .split("/")[0],
            renewed.api,
          );
          assert.deepEqual(await fetchSignedView(renewedView.url, store), {
            status: 200,
            type: "image/webp",
          });
        }
      } finally {
        reading = false;
        await reads;
      }
      assert.ok(requests >= 20);
      const workloadSample = sampleWorker(workers[0]);
      t.diagnostic(
        `9 images at ${width}x${height} and ${original.length} bytes each, 3 writers, ${requests} feed reads from 10 learners, ${((performance.now() - started) / 1000).toFixed(1)}s, peak ${(workloadSample.peak / 1024 ** 2).toFixed(1)} MiB (${workloadSample.arch})`,
      );

      const owner = learners[0];
      const recoveryPost = (
        await call(owner, feed, 201, "POST", {
          body: "Synthetic recovery cases",
        })
      ).id;
      if (bindings) {
        bindings.expireWorkerSession();
        await ready(503);
        assert.equal(await workerStatus("/health"), 200);
        const waiting = await queue(owner, recoveryPost, small);
        await delay(1250);
        const pending = await asset(waiting);
        assert.equal(pending.status, "queued");
        assert.equal(pending.attempts, 0);
        renewed.worker = bindings.renew("worker");
        await ready();
        await until(
          "queued image after session renewal",
          async () => (await asset(waiting)).status === "ready",
        );
        assert.equal((await asset(waiting)).attempts, 1);
        t.diagnostic(
          "Expired credentials paused claims and renewal resumed the queued image.",
        );
      }
      await fixture("fail-read");
      const transient = await queue(owner, recoveryPost, small);
      const backedOff = await until("one durable retry", async () => {
        const row = await asset(transient);
        return row.status === "queued" && row.attempts === 1 && row;
      });
      assert.ok(
        Number(backedOff.retry_seconds) > 7 &&
          Number(backedOff.retry_seconds) <= 10,
      );
      await delay(1250);
      assert.equal((await asset(transient)).attempts, 1);
      await until(
        "successful retry after the natural backoff",
        async () => (await asset(transient)).status === "ready",
      );
      assert.equal((await asset(transient)).attempts, 2);
      if (bindings) {
        const uses = await (
          await request(store + "/fixture/session-uses", 200)
        ).json();
        assert.ok(uses[renewed.api] > 0 && uses[renewed.worker] > 0);
        t.diagnostic(
          "Both running services used the renewed sessions without container replacement.",
        );
      }

      await fixture("fail-read?count=4");
      const exhausted = await queue(owner, recoveryPost, small);
      for (let attempt = 1; attempt <= 4; attempt++) {
        const state = await until(
          `stored retry outcome ${attempt}`,
          async () => {
            const row = await asset(exhausted);
            return (
              row.attempts === attempt &&
              row.status === (attempt < 4 ? "queued" : "rejected") &&
              row
            );
          },
        );
        const scheduled = 5 * 2 ** attempt;
        assert.ok(
          Number(state.retry_seconds) > scheduled - 3 &&
            Number(state.retry_seconds) <= scheduled,
        );
        if (attempt < 4) {
          // Only this fixture row's clock is advanced to avoid a 70-second wait.
          await pool.query(
            "update community_discussion_media set available_at=now() where id=$1",
            [exhausted],
          );
        }
      }
      const exhaustedView = await request(
        api + `/v1/media/${exhausted}/view`,
        404,
        { headers: { authorization: `Bearer ${jwt(owner)}` } },
      );
      await exhaustedView.body?.cancel();
      await until("a rejection rather than a fifth retry", () =>
        docker("logs", "--tail", "8", workers[0]).includes(
          '"rejected":1,"retried":0',
        ),
      );
      t.diagnostic(
        "Storage read failure retried after 10s; repeated failures stopped at attempt four.",
      );

      const interrupted = randomUUID();
      const derivative = `processed/${interrupted}.webp`;
      await fixture(`hold-write?key=${derivative}`);
      await queue(owner, recoveryPost, small, interrupted);
      await until("stored derivative before acknowledgement", async () =>
        (await objects()).some((object) => object.key === derivative),
      );
      const claimed = await asset(interrupted);
      assert.equal(claimed.status, "processing");
      assert.equal(claimed.attempts, 1);
      assert.ok(claimed.lease_until.getTime() > Date.now());
      docker("kill", "--signal=KILL", workers[0]);
      startWorker(workers[1]);
      await ready();
      assert.equal((await asset(interrupted)).attempts, 1);
      await until(
        "replacement reclaim after natural lease expiry",
        async () => (await asset(interrupted)).status === "ready",
        45_000,
      );
      const recovered = await asset(interrupted);
      assert.equal(recovered.attempts, 2);
      assert.equal(recovered.lease_id, null);
      assert.equal(
        (await objects()).filter((object) => object.key === derivative).length,
        1,
      );
      t.diagnostic(
        "Killed the worker after the derivative write. Its replacement waited for the 30s lease and recovered the same object key.",
      );

      await fixture(`fail-delete?key=${derivative}`);
      await call(owner, `/v1/media/${interrupted}`, 200, "DELETE");
      const scheduledCleanup = await until(
        "durable cleanup retry",
        async () => {
          const row = await asset(interrupted);
          return (
            row.status === "removed" &&
            !row.derivative_removed_at &&
            row.cleanup_at.getTime() > Date.now() + 5_000 &&
            row
          );
        },
      );
      assert.ok(scheduledCleanup.cleanup_at.getTime() <= Date.now() + 30_000);
      await pool.query(
        "update community_discussion_media set cleanup_at=now(),clean_original_after=now() where id=$1",
        [interrupted],
      );
      await until("successful cleanup", async () => {
        const row = await asset(interrupted);
        return row.original_removed_at && row.derivative_removed_at;
      });
      assert.ok(
        !(await objects()).some(
          (object) =>
            object.key === derivative ||
            object.key === `quarantine/${interrupted}`,
        ),
      );
      assert.equal((await asset(exhausted)).attempts, 4);

      docker("stop", apiContainer);
      docker("kill", "--signal=INT", pgContainer);
      assert.equal(docker("wait", pgContainer), "0");
      await ready(503);
      assert.equal(await workerStatus("/health"), 200);
      await pool.end();
      pool = undefined;
      docker("start", pgContainer);
      await ready();
      pool = connectDatabase();
      assert.equal((await asset(interrupted)).status, "removed");
      const recoveredSample = sampleWorker(workers[1]);
      docker("stop", "--time", "30", workers[1]);
      assert.equal(
        docker(
          "inspect",
          "--format",
          "{{.State.ExitCode}} {{.State.OOMKilled}}",
          workers[1],
        ),
        "0 false",
      );
      t.diagnostic(
        `Worker stayed live during PostgreSQL outage, regained readiness in the same process, and exited cleanly on SIGTERM. Replacement peak ${(recoveredSample.peak / 1024 ** 2).toFixed(1)} MiB.`,
      );
      if (bindings) {
        for (const retired of [apiContainer, ...workers]) {
          assert.equal(
            docker("inspect", "--format", "{{.State.Running}}", retired),
            "false",
          );
        }
        const previous = apiContainer + "-media-off";
        startBound(previous, "community-api", false);
        const apiReady = () =>
          until(
            "API ready after switching runtime",
            async () =>
              (
                await fetch(api + "/ready", {
                  signal: AbortSignal.timeout(3000),
                }).catch(() => null)
              )?.ok,
          );
        await apiReady();
        if (previousImage) {
          assert.equal(
            docker("inspect", "--format", "{{.Image}}", previous),
            docker("image", "inspect", "--format", "{{.Id}}", previousImage),
          );
          t.diagnostic(
            "Rollback API used the published immutable image " + previousImage,
          );
        }
        await call(learners[0], `/v1/media/${controlAsset}/view`, 404);
        docker("stop", previous);
        assert.equal(
          docker("inspect", "--format", "{{.State.Running}}", previous),
          "false",
        );

        // Re-create the media row's stale pre-delete metadata independently
        // of S3, then replay the authoritative deletion before restarting.
        const restore = await pool.connect();
        try {
          await restore.query("begin");
          await restore.query(
            `UPDATE community_discussion_media SET status='ready', checksum=$2,
                 etag=$3, width=$4, height=$5, derivative_bytes=$6,
                 original_removed_at=$7, derivative_removed_at=NULL
               WHERE id=$1`,
            [
              interrupted,
              recovered.checksum,
              recovered.etag,
              recovered.width,
              recovered.height,
              recovered.derivative_bytes,
              recovered.original_removed_at,
            ],
          );
          await restore.query(
            "CREATE TEMP TABLE community_media_deleted_assets (id uuid PRIMARY KEY) ON COMMIT DROP",
          );
          await restore.query(
            "INSERT INTO community_media_deleted_assets VALUES ($1)",
            [interrupted],
          );
          const fence = readFileSync(
            "ops/platform/community-media-restore-fence.sql",
            "utf8",
          );
          assert.equal((await restore.query(fence)).rowCount, 1);
          assert.equal((await restore.query(fence)).rowCount, 0);
          await restore.query("commit");
        } catch (error) {
          await restore.query("rollback");
          throw error;
        } finally {
          restore.release();
        }

        startBound(apiContainer + "-returned", "community-api");
        startBound(name + "-worker-returned", "community-media-worker");
        await apiReady();
        await ready();
        await call(owner, `/v1/media/${interrupted}/view`, 404);
        assert.ok(
          !(await objects()).some((object) => object.key === derivative),
        );
        const returned = await call(
          learners[0],
          `/v1/media/${controlAsset}/view`,
          200,
        );
        assert.equal(
          new URL(returned.url).searchParams
            .get("X-Amz-Credential")
            .split("/")[0],
          renewed.api,
        );
        t.diagnostic(
          "Media-off rollback and return used non-overlapping services, current sessions, and preserved permanent deletion after stale metadata replay.",
        );
      }
    } catch (error) {
      for (const container of containers.filter(
        (name) => name.includes("-worker-") || name.endsWith("-api"),
      )) {
        try {
          t.diagnostic(docker("logs", "--tail", "8", container));
        } catch {
          /* Failed startup. */
        }
      }
      throw error;
    } finally {
      await pool?.end();
      for (const container of containers.reverse()) {
        try {
          docker("rm", "-fv", container);
        } catch {
          /* The container may have failed to start. */
        }
      }
      try {
        bindings?.close();
      } finally {
        if (networkCreated) docker("network", "rm", name);
        if (imageBuilt) docker("image", "rm", image);
      }
    }
  },
);

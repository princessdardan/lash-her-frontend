import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runQualification } from "./run-course-purchase-qualification.mjs";

const origin = "http://127.0.0.1:48120";
const cursor = "20000000-0000-0000-0000-000000000000";
const env = {
  COURSE_PURCHASE_RECOVERY_SECRET:
    "synthetic-course-purchase-recovery-fixture-key",
};
const noop = () => {};
const report = (nextCursor) =>
  Response.json({
    checkpoint: "2026-11-17T12:00:00Z",
    checkedOrders: nextCursor ? 100 : 1,
    nextCursor,
    mismatchCount: 0,
    adminOverrideCount: 0,
    mismatches: [],
  });

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "course-qualification-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("retries the same cursor, persists each page, and resumes a completed prefix", async (t) => {
  const path = await directory(t);
  const args = ["reconcile", "--origin", origin, "--checkpoint", path];
  const calls = [];
  const delays = [];
  const wait = async (length) => {
    delays.push(length);
  };
  const fetch = async (url, request) => {
    assert.equal(request.method, "POST");
    assert.equal(
      request.headers.authorization,
      `Bearer ${env.COURSE_PURCHASE_RECOVERY_SECRET}`,
    );
    assert.equal(request.redirect, "manual");
    calls.push(url.searchParams.get("after"));
    if (calls.length === 1) return new Response(null, { status: 429 });
    if (calls.length === 2) throw new Error("Synthetic connection loss");
    if (calls.length === 3) return report(cursor);
    return report(null);
  };

  assert.equal(
    await runQualification([...args, "--pages", "1"], {
      env,
      fetch,
      wait,
      log: noop,
    }),
    2,
  );
  assert.deepEqual(calls, [null, null, null]);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(
    JSON.parse(await readFile(join(path, "page-1.json"), "utf8")).report
      .nextCursor,
    cursor,
  );
  assert.equal(
    await runQualification(args, { env, fetch, wait, log: noop }),
    0,
  );
  assert.deepEqual(calls, [null, null, null, cursor]);
  assert.equal(
    JSON.parse(await readFile(join(path, "page-2.json"), "utf8")).after,
    cursor,
  );
  assert.equal(
    await runQualification(args, { env, fetch, wait, log: noop }),
    0,
  );
  assert.equal(calls.length, 4);
});

test("unavailable or interrupted middle pages keep the committed cursor", async (t) => {
  const path = await directory(t);
  const args = ["reconcile", "--origin", origin, "--checkpoint", path];
  let calls = 0;
  await assert.rejects(
    runQualification(args, {
      env,
      fetch: async (url) => {
        calls++;
        if (calls === 1) return report(cursor);
        assert.equal(url.searchParams.get("after"), cursor);
        return new Response(null, { status: 503 });
      },
      wait: noop,
      log: noop,
    }),
    /HTTP 503/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(await readdir(path), ["page-1.json"]);

  const controller = new AbortController();
  await assert.rejects(
    runQualification(args, {
      env,
      signal: controller.signal,
      log: noop,
      fetch: async (url) => {
        assert.equal(url.searchParams.get("after"), cursor);
        controller.abort();
        throw new Error("Synthetic interruption");
      },
    }),
    /outcome is unknown/,
  );
  assert.deepEqual(await readdir(path), ["page-1.json"]);
  await writeFile(join(path, ".running"), "fixture\n");
  await assert.rejects(
    runQualification(args, {
      env,
      log: noop,
      fetch: async () => assert.fail("A second runner must not start"),
    }),
    /Checkpoint is locked/,
  );
  await rm(join(path, ".running"));
  assert.equal(
    await runQualification(args, {
      env,
      log: noop,
      fetch: async (url) => {
        assert.equal(url.searchParams.get("after"), cursor);
        return report(null);
      },
    }),
    0,
  );
});

test("paces recovery ticks and surfaces failed batches without immediate replay", async () => {
  const args = ["recover", "--origin", origin, "--ticks", "2"];
  const logs = [];
  let calls = 0;
  assert.equal(
    await runQualification(args, {
      env,
      log: (result) => logs.push(result),
      wait: async (delay) => assert.ok(delay > 59_000 && delay <= 60_000),
      fetch: async (url) => {
        assert.equal(url.search, "");
        calls++;
        return Response.json({ completed: 1, failed: calls === 1 ? 1 : 0 });
      },
    }),
    1,
  );
  assert.deepEqual(logs, [
    { mode: "recover", tick: 1, completed: 1, failed: 1 },
    { mode: "recover", tick: 2, completed: 1, failed: 0 },
  ]);
  calls = 0;
  await assert.rejects(
    runQualification(args, {
      env,
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
      wait: () => assert.fail("Uncertain recovery must stop"),
    }),
    /HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("declines production origins and refuses to advance a malformed response", async (t) => {
  const path = await directory(t);
  await assert.rejects(
    runQualification(["recover", "--origin", "https://lashher.com"], {
      env,
      fetch: async () => assert.fail("Unexpected request"),
    }),
    /staging origin/,
  );
  await assert.rejects(
    runQualification(["reconcile", "--origin", origin, "--checkpoint", path], {
      env,
      fetch: async () => Response.json({ checkedOrders: 101 }),
    }),
    /cursor was not advanced/,
  );
  assert.deepEqual(await readdir(path), []);
});

test("protects requests to an isolated staging deployment without forwarding protection to other hosts", async () => {
  const target =
    "https://lash-her-frontend-staging-abcdef123-dardan-demiris-projects.vercel.app";
  const protection = "synthetic-qualification-protection";
  const protectedEnv = { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: protection };
  for (const endpoint of [target, origin, "https://staging.lashher.com"]) {
    assert.equal(
      await runQualification(["recover", "--origin", endpoint], {
        env: protectedEnv,
        log: noop,
        fetch: async (url, request) => {
          assert.equal(url.origin, endpoint);
          assert.equal(request.redirect, "manual");
          assert.equal(
            request.headers["x-vercel-protection-bypass"],
            endpoint === target ? protection : undefined,
          );
          return Response.json({ completed: 0, failed: 0 });
        },
      }),
      0,
    );
  }
  await assert.rejects(
    runQualification(
      [
        "recover",
        "--origin",
        "https://lash-her-frontend-abcdef123-dardan-demiris-projects.vercel.app",
      ],
      {
        env: protectedEnv,
        fetch: async () => assert.fail("Unexpected request"),
      },
    ),
    /dedicated staging deployment/,
  );
});

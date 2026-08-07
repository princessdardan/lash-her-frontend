import { execFileSync } from "node:child_process";
import test from "node:test";

const helper = String.raw`
  import assert from "node:assert/strict";
  import {
    createCourseEntitlementCronHandler,
    getCourseEntitlementCronConfig,
  } from "./src/app/api/cron/course-entitlements/handler.ts";

  const summary = { claimed: 2, completed: 1, failed: 0, released: 0, retried: 1, stale: 0 };
  function setup(config = { enabled: true, primarySecret: "route-secret", secondarySecret: "shared-secret" }) {
    const calls = [];
    const logs = [];
    const handler = createCourseEntitlementCronHandler({
      getConfig: () => config,
      log: (level, message, meta) => logs.push({ level, message, meta }),
      runBatch: async () => { calls.push("run"); return summary; },
    });
    return { calls, handler, logs };
  }
  function request(secret) {
    return new Request("https://lash.test/api/cron/course-entitlements", {
      headers: secret === undefined ? undefined : { authorization: "Bearer " + secret },
    });
  }
`;

test("course entitlement cron is hidden when disabled or route secret is absent", () => {
  scenario(String.raw`
    for (const config of [
      { enabled: false, primarySecret: "route-secret", secondarySecret: null },
      { enabled: true, primarySecret: null, secondarySecret: "shared-secret" },
    ]) {
      const { calls, handler } = setup(config);
      const response = await handler(request("route-secret"));
      assert.equal(response.status, 404);
      assert.deepEqual(calls, []);
    }
  `);
});

test("course entitlement cron requires a configured bearer secret", () => {
  scenario(String.raw`
    for (const secret of [undefined, "wrong-secret"]) {
      const { calls, handler } = setup();
      const response = await handler(request(secret));
      assert.equal(response.status, 401);
      assert.deepEqual(calls, []);
    }
  `);
});

test("course entitlement cron accepts route and secondary cron secrets", () => {
  scenario(String.raw`
    for (const secret of ["route-secret", "shared-secret"]) {
      const { calls, handler, logs } = setup();
      const response = await handler(request(secret));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), summary);
      assert.deepEqual(calls, ["run"]);
      assert.equal(logs[0].message, "Course entitlement cron completed");
      assert.equal(JSON.stringify(logs).includes(secret), false);
    }
  `);
});

test("course entitlement cron runtime rejects weak or reused route secrets", () => {
  scenario(String.raw`
    Object.assign(process.env, {
      ACADEMY_ENABLED: "true",
      COURSE_ENTITLEMENT_WORKER_ENABLED: "true",
      COURSE_API_BASE_URL: "https://course.example.test",
      COURSE_API_USER_JWT_SECRET: "u".repeat(32),
      COURSE_API_USER_JWT_ISSUER: "lash-her-frontend",
      COURSE_API_USER_JWT_AUDIENCE: "lash-her-course-api",
      COURSE_API_SERVICE_JWT_SECRET: "s".repeat(32),
      COURSE_API_SERVICE_JWT_ISSUER: "lash-her-frontend-service",
      COURSE_API_SERVICE_JWT_AUDIENCE: "lash-her-course-api-internal",
      COURSE_API_SERVICE_JWT_SUBJECT: "lash-her-frontend",
      AUTH_SECRET: "a".repeat(32),
      CRON_SECRET: "c".repeat(32),
    });

    for (const secret of ["short", "a".repeat(32), "u".repeat(32), "c".repeat(32)]) {
      process.env.COURSE_ENTITLEMENT_CRON_SECRET = secret;
      assert.deepEqual(getCourseEntitlementCronConfig(), {
        enabled: false,
        primarySecret: null,
        secondarySecret: null,
      });
    }

    process.env.COURSE_ENTITLEMENT_CRON_SECRET = "e".repeat(32);
    assert.deepEqual(getCourseEntitlementCronConfig(), {
      enabled: true,
      primarySecret: "e".repeat(32),
      secondarySecret: "c".repeat(32),
    });
  `);
});

function scenario(assertions: string): void {
  const env = { ...process.env };
  env.NEXT_PUBLIC_SANITY_DATASET = "test";
  env.NEXT_PUBLIC_SANITY_PROJECT_ID = "test-project";

  execFileSync(
    "./node_modules/.bin/tsx",
    [
      "--conditions=react-server",
      "--eval",
      `${helper}\nvoid (async () => {${assertions}})()`,
    ],
    { cwd: process.cwd(), env, stdio: "pipe" },
  );
}

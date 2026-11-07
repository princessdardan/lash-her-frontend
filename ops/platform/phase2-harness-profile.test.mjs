import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { courseHarnessAuth, disabledCourseWorkerEnvironment, phase2Workers } from "./phase2-harness-profile.mjs";

test("P2 harness removes retired aliases and keeps three authentication profiles separate", () => {
  const values = { frontendSecret: randomBytes(32).toString("hex"), adminSecret: randomBytes(32).toString("hex"), learnerSecret: randomBytes(32).toString("hex") };
  const actual = courseHarnessAuth("p2", values);
  assert.equal(actual.INTERNAL_SERVICE_JWT_ALLOWED_SUBJECTS, "frontend");
  assert.equal(actual.COURSE_ADMIN_JWT_CURRENT_SECRET, values.adminSecret);
  assert.equal(actual.COURSE_LEARNER_JWT_CURRENT_SECRET, values.learnerSecret);
  assert.equal(actual.INTERNAL_SERVICE_JWT_SECRET, values.frontendSecret);
  assert.equal(Object.hasOwn(actual, "FIRST_PARTY_AUTH_SECRET"), false);
  assert.equal(courseHarnessAuth("p1", values).INTERNAL_SERVICE_JWT_ALLOWED_SUBJECTS, "lash-her-frontend");
  assert.throws(() => courseHarnessAuth("other", values));
});

test("disabled P2 workers receive only their named database and exact false flags", () => {
  for (const worker of phase2Workers) {
    const actual = disabledCourseWorkerEnvironment("postgresql://owned@127.0.0.1/owned_test", worker);
    assert.equal(actual.DATABASE_TARGET, "staging");
    assert.ok(Object.keys(actual).every(name => /^(?:DATABASE_TARGET|STAGING_DATABASE_URL|MUX_MEDIA_RECOVERY_ENABLED|MUX_MEDIA_CLEANUP_ENABLED|COURSE_ACCOUNT_EXPORT_CLEANUP_ENABLED)$/u.test(name)));
    assert.ok(Object.entries(actual).filter(([key]) => key.endsWith("ENABLED")).every(([, value]) => value === "false"));
  }
  assert.throws(() => disabledCourseWorkerEnvironment("unused", "course-api"));
});

test("current Course process parsers accept the actual P2 API and minimal worker fixture inputs", { skip: !process.env.COURSE_WORKER_RUNTIME_DIR }, () => {
  const directory = process.env.COURSE_WORKER_RUNTIME_DIR;
  const base = { NODE_ENV: "test", DATABASE_TARGET: "test", TEST_DATABASE_URL: "postgresql://owned@127.0.0.1/owned_test" };
  const auth = courseHarnessAuth("p2", { frontendSecret: "synthetic-frontend-".repeat(4), adminSecret: "synthetic-admin-".repeat(4), learnerSecret: "synthetic-learner-".repeat(4) });
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(`${directory}/dist/config/env.js`)}); console.log("P2_CONFIG_PASS")`], { env: { ...base, ...auth }, encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  for (const [worker, module, parser] of [["course-media", "mux-media-process-env", "parseMuxMediaProcessEnv"], ["course-export-cleanup", "account-export-process-env", "parseAccountExportProcessEnv"]]) {
    const configuration = { NODE_ENV: "production", ...disabledCourseWorkerEnvironment(base.TEST_DATABASE_URL, worker) };
    const output = spawnSync(process.execPath, ["--input-type=module", "--eval", `const {${parser}: parse}=await import(${JSON.stringify(`${directory}/dist/config/${module}.js`)}); if(parse(${JSON.stringify(configuration)}).enabled!==false) throw new Error("Disabled worker required")`], { env: {}, encoding: "utf8", timeout: 10000 });
    assert.equal(output.status, 0, output.stderr);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import routes from "./routes.json" with { type: "json" };
import { admissionClass } from "./admission.mjs";
import { matchRoute, MinuteBudget, validateConfig } from "./policy.mjs";

export const config = {
  issuer: "https://oidc.vercel.com/test-team",
  audience: "https://vercel.com/test-team",
  subject: "owner:test-team:project:test-project:environment:production",
  ownerId: "team_test", projectId: "prj_test", environment: "production", appEnv: "staging",
  publicHost: "gateway.test", courseOrigin: "https://course.test:9443",
  tlsKeyFile: "/fixture/key", tlsCertFile: "/fixture/cert", upstreamCaFile: "/fixture/ca",
};

test("gateway exposes exact reviewed service methods; enrollment/authority traffic stays private", () => {
  const documents = Object.fromEntries(["course", "community"].map(service => [service,
    JSON.parse(readFileSync(new URL(`../../contracts/api-integration/p2-candidate/${service}-api.json`, import.meta.url)))]));
  for (const route of routes) {
    const service = route.service ?? "course";
    // Course11 reserves these exact aliases against the published lifecycle
    // boundary; it is not enabled by reserving gateway transport here.
    const reservedCourseLifecycle = service === "course" && ["POST /v1/internal/accounts/commands", "GET /v1/internal/accounts/exports/{commandId}"].includes(`${route.method} ${route.path}`);
    assert.ok(documents[service].paths[route.path]?.[route.method.toLowerCase()] || reservedCourseLifecycle);
    const application = route.communityApplication === true;
    assert.equal(matchRoute(route.method, `/${service}${route.path.replace(/\{[^}]+\}/gu, "valid-id")}`, application), route);
    if (application) {
      assert.equal(service, "community");
      assert.equal(route.auth, "application");
      assert.equal(admissionClass(route), "newWork");
      assert.ok(!route.path.startsWith("/v1/internal/"));
    }
  }
  for (const path of [
    "/metrics", "/ready", "/health", "/course/health", "/course/metrics", "/course/ready",
    "/community/v1/internal/course/enrollment-events",
    "/community/v1/courses", "/community/v1/admin/courses", "/community/v1/webhooks/mux",
    "/course/v1/internal/community/entitlements/check",
    "/course/v1/internal/community/enrollment-snapshots",
    "/course/v1/internal/entitlements/unknown", "/course/v1/courses/../admin/courses",
    "/course/v1/courses/%2e%2e/admin/courses", "/course/v1/courses%2fsecret",
    "/course/v1//courses", "/course/v1/courses/", "https://gateway.test/course/v1/courses",
    "//gateway.test/course/v1/courses", "/course/v1/courses\\anything", "/course/v1/courses#fragment",
  ]) assert.equal(matchRoute("GET", path), null, path);
  assert.equal(matchRoute("POST", "/course/v1/student/courses/a/legacy-progress")?.auth, "application");
  assert.equal(matchRoute("GET", "/course/v1/student/courses/a/legacy-progress"), null);
  assert.equal(matchRoute("HEAD", "/course/v1/courses"), null);
  assert.equal(matchRoute("OPTIONS", "/course/v1/courses"), null);
  assert.ok(matchRoute("GET", "/course/v1/courses?cursor=abc%2Fdef"));
  assert.equal(routes.filter((route) => route.auth === "webhook").length, 1);
});

test("ordinary Community matching separates overlapping review routes and denies private aliases", () => {
  const profile = "/community/v1/profile";
  assert.equal(matchRoute("GET", profile)?.stagingReviewDiscussions, true);
  assert.equal(matchRoute("GET", profile, true)?.communityApplication, true);
  assert.equal(matchRoute("GET", profile, true)?.stagingReviewDiscussions, undefined);
  assert.equal(matchRoute("GET", "/community/v1/moderation/reports"), null);
  for (const [method, path] of [
    ["GET", "/course/v1/courses"],
    ["POST", "/community/v1/internal/accounts/commands"],
    ["GET", "/community/v1/internal/accounts/exports/command"],
    ["POST", "/community/v1/internal/course/enrollment-events"],
    ["HEAD", profile],
    ["POST", profile],
    ["GET", "/community/v1/discussions/post%2Fmedia"],
  ]) assert.equal(matchRoute(method, path, true), null);
});

test("configuration pins Vercel identity, production target and TLS upstream", () => {
  assert.equal(validateConfig(config).appEnv, "staging");
  for (const override of [
    { issuer: "https://attacker.test" }, { environment: "preview" }, { appEnv: "local" },
    { projectId: "" }, { ownerId: "" }, { subject: "*" }, { audience: "*" },
    { publicHost: "gateway.test/path" }, { courseOrigin: "http://course.test" },
    { courseOrigin: "https://user:secret@course.test" }, { courseOrigin: "https://course.test/path" },
    { upstreamCaFile: "relative" },
    { communityOrigin: "http://community.test" }, { communityOrigin: "https://user:secret@community.test" },
    { communityOrigin: "https://community.test/path" },
  ]) assert.throws(() => validateConfig({ ...config, ...override }));
});

test("aggregate, verified workload, service and webhook windows remain independent", () => {
  let now = 0;
  const budget = new MinuteBudget({ preauth: 1, workload: 1, webhook: 1, service: 1 }, () => now);
  for (const key of ["preauth", "workload", "webhook", "service"]) {
    assert.equal(budget.consume(key), 0);
    assert.equal(budget.consume(key), 60);
  }
  now = 59_001;
  assert.equal(budget.consume("workload"), 1);
  now = 60_000;
  assert.equal(budget.consume("workload"), 0);
  assert.throws(() => budget.consume("unverified-caller-id"));
});

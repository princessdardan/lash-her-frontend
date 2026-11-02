import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createCourseReadHttp } from "/app/dist/integrations/course/shared/http.js";
import { createCommunityCourseJwtMinter } from "/app/dist/integrations/course/shared/service-jwt.js";

const { z } = createRequire("/app/package.json")("zod");
const fixture = JSON.parse(readFileSync("/test/out/grant.json", "utf8"));
const minter = createCommunityCourseJwtMinter({ currentSecret: process.env.COMMUNITY_READER_JWT_CURRENT_SECRET });
const http = createCourseReadHttp({ baseUrl: "https://course-tls:8443", jwtMinter: minter, requireHttps: true });
const result = await http.request({ method: "POST", path: "/v1/internal/community/entitlements/check", body: fixture, timeoutMs: 1500 },
  z.object({ hasAccess: z.boolean() }).passthrough());
assert.equal(result.hasAccess, true);
const denied = await fetch("https://course-tls:8443/v1/internal/community/enrollment-streams/resolve", {
  method: "POST", headers: { authorization: `Bearer ${minter.mint()}`, "x-forwarded-for": "172.29.10.32" }, signal: AbortSignal.timeout(3000),
});
assert.equal(denied.status, 403);
writeFileSync("/test/out/authority.json", JSON.stringify({ hasAccess: true, wrongRouteDenied: true }));

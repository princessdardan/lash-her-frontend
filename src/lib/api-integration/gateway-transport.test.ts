import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { INTERACTIVE_COOKIE, INTERACTIVE_GATEWAY_PROOF_HEADER, INTERACTIVE_HEADER, INTERACTIVE_ORIGIN } from "@/lib/writer-admission/interactive-proof";
import { createGatewayTransport, GatewayTransportError } from "./gateway-transport";

test("transport obtains workload proof per call, preserves application JWT and safe 429 envelope", async () => {
  let tokens = 0;
  const transport = createGatewayTransport({
    origin: "https://gateway.example.test",
    getWorkloadToken: async () => `proof-${++tokens}`,
    fetch: async (url, options) => {
      assert.equal(String(url), "https://gateway.example.test/course/v1/student/courses?cursor=x");
      assert.equal(options?.cache, "no-store"); assert.equal(options?.redirect, "manual");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("x-lash-workload-token"), `proof-${tokens}`);
      assert.equal(headers.get("authorization"), "Bearer application.jwt");
      assert.equal(headers.get("cookie"), null);
      return Response.json({ error: { code: "TOO_MANY_REQUESTS", message: "Retry later" } }, {
        status: 429, headers: { "retry-after": "15", "set-cookie": "private=secret" },
      });
    },
  });
  for (let i = 0; i < 2; i++) {
    const response = await transport({ method: "GET", path: "/v1/student/courses?cursor=x", applicationToken: "application.jwt" });
    assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "15");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).error.code, "TOO_MANY_REQUESTS");
  }
  assert.equal(tokens, 2);
});

test("invalid routes and missing application authorization refuse before obtaining workload proof", async () => {
  let proofs = 0;
  const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => { proofs++; return "proof"; } });
  for (const path of ["//attacker.test", "/v1/courses/../admin/courses", "/v1/courses/%2e%2e", "/metrics", "/v1/internal/community/entitlements/check", "/v1/webhooks/mux"]) {
    await assert.rejects(transport({ method: "GET", path }), GatewayTransportError);
  }
  await assert.rejects(transport({ method: "GET", path: "/v1/student/courses" }), GatewayTransportError);
  assert.equal(proofs, 0);
  for (const origin of ["http://gateway.test", "https://user:secret@gateway.test", "https://gateway.test/path", "https://gateway.test?secret=x"]) assert.throws(() => createGatewayTransport({ origin }), GatewayTransportError);
});

test("transport refuses redirects, cancels oversized responses and sanitizes SDK/network failures", async () => {
  for (const fetch of [
    async () => new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
    async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
    async () => { throw new Error("private-credential"); },
  ]) {
    const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => "proof", fetch });
    await assert.rejects(transport({ method: "GET", path: "/v1/courses" }), (error: unknown) => error instanceof GatewayTransportError && !error.message.includes("private-credential"));
  }
  const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => { throw new Error("private-credential"); } });
  await assert.rejects(transport({ method: "GET", path: "/v1/courses" }), { message: "Gateway transport unavailable" });
});

test("transport selects only declared service aliases and sanitizes correlation headers", async () => {
  const transport = createGatewayTransport({ origin: "https://gateway.example.test", getWorkloadToken: async () => "proof", fetch: async (url) => {
    assert.equal(String(url), "https://gateway.example.test/community/v1/internal/accounts/commands");
    return Response.json({}, { headers: { "x-request-id": "private-token-like-value", "retry-after": "private-provider-message" } });
  } });
  const response = await transport({ service: "community", method: "POST", path: "/v1/internal/accounts/commands", applicationToken: "dedicated.lifecycle.jwt", body: "{}" });
  assert.equal(response.headers.get("x-request-id"), null); assert.equal(response.headers.get("retry-after"), null);
  await assert.rejects(transport({ service: "community", method: "GET", path: "/v1/courses" }), { code: "route" });
  await assert.rejects(transport({ service: "community", method: "POST", path: "/v1/internal/course/enrollment-events", applicationToken: "wrong" }), { code: "route" });
});

test("the ordinary transport signs exact staging Course bytes only with a verified browser permit and proxy proof", async (t) => {
  Object.assign(globalThis, { AsyncLocalStorage });
  const { NextRequest } = await import("next/server");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store.js");
  const { createWorkStore } = await import("next/dist/server/async-storage/work-store.js");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const issued = 1790000000;
  t.mock.timers.enable({ apis: ["Date"], now: issued * 1000 });
  const gatewayOrigin = "https://api-staging.lashher.com";
  const deployment = "owned-staging-build.vercel.app";
  const source = "a".repeat(40), frontendTarget = "b".repeat(64), nonce = "c".repeat(32), epoch = "42";
  const secret = "owned-test-cron-key-no-live-credentials";
  const environment = {
    APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_URL: deployment, VERCEL_GIT_COMMIT_SHA: source, FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ targetSha256: frontendTarget }), CRON_SECRET: secret,
    API_GATEWAY_STAGING_ORIGIN: gatewayOrigin, ADMIN_DEVELOPER_MODE: "false",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function evidence(stage: string, route: string, timestamp = issued) {
    const selector = stage === "identity" ? createHash("sha256").update(JSON.stringify(["identity", "customer"])).digest("hex") : undefined;
    const body = [selector ? "v2" : "v1", epoch, stage, issued - 90, issued + 90, nonce, ...(selector ? [selector] : [])].join(".");
    const browserMac = createHmac("sha256", secret)
      .update(["lash-her:p2q:interactive:browser:v1", deployment, source, frontendTarget, body].join("\n")).digest("hex");
    const cookie = `${body}.${browserMac}`;
    const routeValue = `${timestamp}.${Buffer.from(route).toString("base64url")}`;
    const requestMac = createHmac("sha256", secret)
      .update(["lash-her:p2q:interactive:request:v1", deployment, source, frontendTarget, cookie, routeValue].join("\n")).digest("hex");
    return { cookie, proxyProof: `${routeValue}.${requestMac}` };
  }

  function inBrowser<T>(cookies: string, proxyProof: string | undefined, run: () => Promise<T>,
    route = "GET /api/academy/courses"): Promise<T> {
    const [method, path] = route.split(" ");
    const request = new NextRequest(INTERACTIVE_ORIGIN + path, { method, headers: {
      cookie: `${INTERACTIVE_COOKIE}=${cookies}`, ...(proxyProof ? { [INTERACTIVE_HEADER]: proxyProof } : {}),
    } });
    const store = createRequestStoreForAPI(request, new URL(request.url), { tags: [], expirationsByCacheKind: new Map() },
      undefined, undefined, undefined);
    const work = createWorkStore({
      page: request.nextUrl.pathname + "/route", deploymentId: "owned", buildId: "owned", previouslyRevalidatedTags: [],
      renderOpts: {
        cacheLifeProfiles: { default: { stale: 0, revalidate: 0, expire: 1 } }, staticPageGenerationTimeout: 60,
        cacheComponents: false, validationLevel: "warning",
        experimental: { isRoutePPREnabled: false, authInterrupts: false, useCacheTimeout: 60, durableUseCacheEntries: false },
        waitUntil: undefined, onClose() {}, onAfterTaskError: undefined,
      },
    });
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, run));
  }

  const captured: { url: string; headers: Headers }[] = [];
  const transport = (origin = gatewayOrigin) => createGatewayTransport({
    origin, getWorkloadToken: async () => "owned-workload-proof", fetch: async (url, options) => {
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.redirect, "manual");
      captured.push({ url: String(url), headers: new Headers(options?.headers) });
      return Response.json({}, { headers: { [INTERACTIVE_GATEWAY_PROOF_HEADER]: "unexpected-echo" } });
    },
  });
  const send = transport();
  const learning = evidence("learning", "GET /api/academy/courses");
  const query = "/v1/student/courses?cursor=café&kind='";
  const applicationToken = "owned.learner.jwt";
  const response = await inBrowser(learning.cookie, learning.proxyProof, () => send({ method: "GET", path: query, applicationToken }));
  assert.equal(response.headers.get(INTERACTIVE_GATEWAY_PROOF_HEADER), null);
  const grantRoute = "POST /api/admin/courses/12345678-1234-4123-8123-123456789abc/manual-grants";
  const grant = evidence("paid-grant", grantRoute);
  const body = '{"label":"café"}\n', idempotencyKey = "owned:grant.1";
  await inBrowser(grant.cookie, grant.proxyProof, () => send({
    method: "POST", path: "/v1/admin/entitlements/grants", body, idempotencyKey, applicationToken: "owned.admin.jwt",
  }), grantRoute);
  const expected = [
    { stage: "learning", method: "GET", target: "/course/v1/student/courses?cursor=caf%C3%A9&kind=%27", bytes: ["", applicationToken, ""] },
    { stage: "paid-grant", method: "POST", target: "/course/v1/admin/entitlements/grants", bytes: [body, "owned.admin.jwt", idempotencyKey] },
  ];
  for (const [index, { stage, method, target, bytes }] of expected.entries()) {
    const { url, headers } = captured[index];
    assert.equal(url, gatewayOrigin + target);
    const requestId = headers.get("x-request-id");
    assert.match(requestId ?? "", /^[0-9a-f-]{36}$/u);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get(INTERACTIVE_HEADER), null);
    const windowKey = createHmac("sha256", secret)
      .update(["lash-her:p2q:interactive:gateway-key:v1", deployment, source, frontendTarget, epoch, stage, nonce].join("\n"))
      .digest();
    const digests = bytes.map(value => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex"));
    const mac = createHmac("sha256", windowKey)
      .update(["lash-her:p2q:interactive:gateway-request:v1", issued, requestId, method, target, ...digests].join("\n")).digest("hex");
    assert.equal(headers.get(INTERACTIVE_GATEWAY_PROOF_HEADER), `v1.${issued}.${requestId}.${mac}`);
  }
  assert.notEqual(captured[0].headers.get("x-request-id"), captured[1].headers.get("x-request-id"));

  const request = () => send({ method: "GET", path: "/v1/courses" });
  const identity = evidence("identity", "GET /api/customer-auth/session");
  const stale = evidence("learning", "GET /api/academy/courses", issued - 30);
  await request();
  await inBrowser(learning.cookie, undefined, request);
  await inBrowser(learning.cookie, `${learning.proxyProof}x`, request);
  await inBrowser(stale.cookie, stale.proxyProof, request);
  await inBrowser(learning.cookie, identity.proxyProof, request);
  await inBrowser(identity.cookie, identity.proxyProof, request);
  await inBrowser(learning.cookie, learning.proxyProof, () => transport("https://foreign.example.test")({ method: "GET", path: "/v1/courses" }));
  await inBrowser(learning.cookie, learning.proxyProof, () => send({ service: "community", method: "POST",
    path: "/v1/internal/accounts/commands", applicationToken: "owned.lifecycle.jwt", body: "{}" }));
  await inBrowser(learning.cookie, learning.proxyProof, () => send({ method: "POST",
    path: "/v1/internal/entitlements/grants", applicationToken: "owned.service.jwt", body: "{}" }));
  process.env.VERCEL_URL = "different-staging-build.vercel.app";
  await inBrowser(learning.cookie, learning.proxyProof, request);
  process.env.VERCEL_URL = deployment;
  process.env.API_GATEWAY_STAGING_ORIGIN = "https://different.example.test";
  await inBrowser(learning.cookie, learning.proxyProof, request);
  assert.equal(captured.length, 13);
  assert.ok(captured.slice(2).every(({ headers }) => !headers.has(INTERACTIVE_GATEWAY_PROOF_HEADER)));
});

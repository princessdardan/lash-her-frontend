import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { after, beforeEach, mock, test } from "node:test";
import {
  AdminAuthError,
  type AdminAuthErrorCode,
  type AdminRole,
  type AdminUserStatus,
} from "@/lib/admin/types";
import * as writerContext from "@/lib/writer-admission/context";

const origin = "https://frontend.example.test";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const memberKey = "synthetic-community-adapter-member-signing-key-only";
const adminKey = "synthetic-community-adapter-admin-signing-key-only";
// Native ESM module mocks exercise real route exports without production test seams.
// Auth/session/admission decisions and upstream I/O are synthetic; signing,
// validation, transport, CSRF, error mapping and writer uncertainty execute normally.
// Run through scripts/run-source-unit-tests.mjs or use --experimental-test-module-mocks.
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Json = null | string | number | boolean | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };
interface Schema {
  $ref?: string;
  enum?: Json[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  type?: string;
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  format?: string;
  pattern?: string;
}
interface ContractOperation {
  responses: Record<
    string,
    { content: { "application/json": { schema: Schema } } }
  >;
  requestBody?: { content: { "application/json": { schema: Schema } } };
}
interface ContractDocument {
  paths: Record<
    string,
    Partial<Record<Lowercase<HttpMethod>, ContractOperation>>
  >;
}
interface FetchCall {
  url: string;
  options: RequestInit;
}
interface State {
  cookies: number;
  auth: number;
  issued: number;
  admissions: number;
  uncertain: number;
  proofs: number;
  sessions: string[];
  calls: FetchCall[];
  cookieNames: string[];
  cookie: string;
  memberId: string;
  adminId: string;
  adminRole: AdminRole;
  adminStatus: AdminUserStatus;
  active: boolean;
  admitted: boolean;
  flags: Record<string, boolean>;
  response: () => Response;
  onAdmission: null | (() => void);
  adminError: AdminAuthErrorCode | null;
  developer: boolean;
}
interface Operation {
  path: string;
  contract: string;
  method: HttpMethod;
  execute: (
    request: Request,
    context: { params: Promise<Record<string, string>> },
  ) => Promise<Response>;
  success: number;
  payload?: JsonObject;
  response: JsonObject;
  admin: boolean;
}
interface RequestOverrides {
  headers?: Record<string, string>;
  query?: string;
  rawBody?: string;
  body?: JsonObject;
}
const projectRoot = new URL("../../../", import.meta.url);
const document: ContractDocument = JSON.parse(
  readFileSync(
    new URL(
      "contracts/api-integration/p2-candidate/community-api.json",
      projectRoot,
    ),
    "utf8",
  ),
);
let state: State;
const originalFetch = globalThis.fetch;
const environment = new Map(
  [
    "COMMUNITY_MEMBER_JWT_CURRENT_SECRET",
    "COMMUNITY_ADMIN_JWT_CURRENT_SECRET",
    "API_GATEWAY_STAGING_ORIGIN",
    "AUTH_URL",
    "NEXTAUTH_URL",
    "CUSTOMER_AUTH_ENABLED",
  ].map((name) => [name, process.env[name]]),
);
after(() => {
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  for (const [name, value] of environment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function replace(name: string, exports: Record<string, unknown>) {
  // Node's module mock resolver does not apply tsx's TypeScript path aliases.
  const target = name.startsWith("@/")
    ? new URL(`src/${name.slice(2)}.ts`, projectRoot)
    : import.meta.resolve(name);
  mock.module(target, { cache: true, namedExports: exports });
}
replace("next/headers", {
  cookies: async () => {
    state.cookies++;
    return {
      get(name: string) {
        state.cookieNames.push(name);
        return state.cookie ? { value: state.cookie } : undefined;
      },
    };
  },
});
replace("@/lib/admin/auth", {
  requirePermission: async (permission: string) => {
    state.auth++;
    assert.equal(permission, "community:moderate");
    if (state.adminError) throw new AdminAuthError(state.adminError);
    return {
      user: { id: state.adminId, role: state.adminRole, status: state.adminStatus },
      ...(state.developer ? { developerMode: {} } : {}),
    };
  },
});
replace("@/lib/customer-auth/policy", {
  customerSessionCookieName: (secure: boolean) =>
    (secure ? "__Host-" : "") + "lash-customer.session-token",
  resolveCustomerAuthConfiguration: () => ({ origin, secure: true }),
});
replace("@/lib/customer-auth/session-issuance", {
  issueLockedCustomerToken: async (
    session: string,
    issue: (id: string) => string,
  ) => {
    state.issued++;
    state.sessions.push(session);
    if (!state.active) return null;
    return { customerId: state.memberId, token: issue(state.memberId) };
  },
});
replace("@/lib/writer-admission/runtime", {
  runWriterAdmission: async (
    kind: string,
    execute: () => Promise<Response>,
  ) => {
    state.admissions++;
    assert.equal(kind, "new-work");
    if (!state.admitted) throw new Error("Synthetic admission closed");
    state.onAdmission?.();
    try {
      return await writerContext.withWriterOperationContext(execute);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "WRITER_OPERATION_REQUIRES_REVIEW"
      )
        state.uncertain++;
      throw error;
    }
  },
});
replace("@/lib/api-integration/rollout-flags", {
  isIntegrationFeatureEnabled: (name: string) => state.flags[name] === true,
});
replace("@/lib/env/application-environment.server", {
  getApplicationEnvironment: () => "staging",
});
replace("@vercel/oidc", {
  getVercelOidcToken: async () => {
    state.proofs++;
    return "synthetic.workload.proof";
  },
});
globalThis.fetch = async (url, options = {}) => {
  state.calls.push({ url: String(url), options });
  return state.response();
};

const spaces = await import("@/app/api/community/spaces/route");
beforeEach(() => {
  process.env.COMMUNITY_MEMBER_JWT_CURRENT_SECRET = memberKey;
  process.env.COMMUNITY_ADMIN_JWT_CURRENT_SECRET = adminKey;
  process.env.API_GATEWAY_STAGING_ORIGIN =
    "https://community-gateway.example.test";
  process.env.AUTH_URL = origin;
  delete process.env.NEXTAUTH_URL;
  state = {
    cookies: 0,
    auth: 0,
    issued: 0,
    admissions: 0,
    uncertain: 0,
    proofs: 0,
    sessions: [],
    calls: [],
    cookieNames: [],
    cookie: "synthetic-first-session",
    memberId: first,
    adminId: second,
    adminRole: "owner",
    adminStatus: "active",
    active: true,
    admitted: true,
    flags: {
      customerAccess: true,
      communityReads: true,
      communityWrites: true,
      communityMedia: true,
    },
    response: () => Response.json({ spaces: [], next: null }),
    onAdmission: null,
    adminError: null,
    developer: false,
  };
  // This flag is scoped to the synthetic test process.
  process.env.CUSTOMER_AUTH_ENABLED = "true";
});

const { createGatewayTransport, GatewayTransportError } =
  await import("@/lib/api-integration/gateway-transport");

function sample(schema: Schema): Json {
  if (schema.$ref) {
    let resolved: unknown = document;
    for (const key of schema.$ref.slice(2).split("/")) {
      assert(resolved && typeof resolved === "object");
      resolved = (resolved as Record<string, unknown>)[key];
    }
    assert(resolved && typeof resolved === "object");
    return sample(resolved as Schema);
  }
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf)
    return sample((schema.anyOf ?? schema.oneOf ?? [])[0]);
  if (schema.type === "null") return null;
  if (schema.type === "boolean") return true;
  if (schema.type === "number" || schema.type === "integer")
    return schema.minimum ?? 0;
  if (schema.type === "array") return [];
  if (schema.type === "object") {
    return Object.fromEntries(
      (schema.required ?? []).map((key) => [
        key,
        sample(schema.properties![key]),
      ]),
    );
  }
  if (schema.format === "uuid") return first;
  if (schema.format === "date-time") return "2026-11-18T12:00:00.000Z";
  if (schema.format === "uri") return "https://storage.example.test/synthetic";
  if (schema.pattern?.includes("A-Za-z0-9+/"))
    return Buffer.alloc(32).toString("base64");
  return "Synthetic community fixture";
}

function sampleObject(schema: Schema): JsonObject {
  const value = sample(schema);
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function routes(folder: string): string[] {
  return readdirSync(new URL(folder, projectRoot), {
    withFileTypes: true,
  }).flatMap((entry) =>
    entry.isDirectory()
      ? routes(folder + "/" + entry.name)
      : entry.name === "route.ts"
        ? [folder + "/route.ts"]
        : [],
  );
}
const operations: Operation[] = [];
for (const filename of [
  ...routes("src/app/api/community"),
  ...routes("src/app/api/admin/community"),
]) {
  const exported = await import(new URL(filename, projectRoot).href);
  const path =
    "/" +
    filename
      .slice("src/app/".length)
      .replace(/\/route\.ts$/u, "")
      .replace(/\[([^\]]+)\]/gu, "{$1}");
  const contract = path
    .replace("/api/admin/community", "/v1/moderation")
    .replace("/api/community", "/v1");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    if (!exported[method]) continue;
    const specification =
      document.paths[contract][method.toLowerCase() as Lowercase<HttpMethod>];
    assert(specification, method + " " + path + " has a pinned contract");
    const success = Number(
      Object.keys(specification.responses).find((code) =>
        /^2\d\d$/u.test(code),
      ),
    );
    operations.push({
      path,
      contract,
      method,
      execute: exported[method],
      success,
      payload:
        method === "DELETE"
          ? {}
          : specification.requestBody
            ? sampleObject(
                specification.requestBody.content["application/json"].schema,
              )
            : undefined,
      response: sampleObject(
        specification.responses[success].content["application/json"].schema,
      ),
      admin: path.startsWith("/api/admin/"),
    });
  }
}
const operation = (path: string, method: HttpMethod) => {
  const op = operations.find(
    (candidate) => candidate.path === path && candidate.method === method,
  );
  assert(op, method + " " + path + " is a real route export");
  return op;
};
const feed = operation("/api/community/spaces/{courseId}/posts", "GET");
const post = operation(feed.path, "POST");
const reports = operation("/api/admin/community/reports", "GET");
const moderate = operation("/api/admin/community/actions", "POST");
const remove = operation("/api/community/content/{contentId}", "DELETE");
const reserveImage = operation("/api/community/discussions/{postId}/media", "POST");
function request(op: Operation, extra: RequestOverrides = {}) {
  const path = materialize(op.path);
  const headers = {
    host: new URL(origin).host,
    ...(op.method === "GET"
      ? {}
      : {
          origin,
          "x-lash-csrf": "1",
          "content-type": "application/json",
        }),
    ...extra.headers,
  };
  return new Request(origin + path + (extra.query ?? ""), {
    method: op.method,
    headers,
    ...(op.method === "GET"
      ? {}
      : {
          body: extra.rawBody ?? JSON.stringify(extra.body ?? op.payload),
        }),
  });
}
function resourceId(name: string) {
  return name === "memberId" ? second : first;
}
function materialize(path: string) {
  return path.replace(/\{([^}]+)\}/gu, (_match, name: string) => resourceId(name));
}
function invoke(op: Operation, extra?: RequestOverrides) {
  const params = Object.fromEntries(
    [...op.path.matchAll(/\{([^}]+)\}/gu)].map((match) => [match[1], resourceId(match[1])]),
  );
  return op.execute(request(op, extra), { params: Promise.resolve(params) });
}
function incoming(
  code: string,
  status: number,
  overrides: Record<string, string> = {},
) {
  return Response.json(
    {
      error: { code, message: "Synthetic upstream detail" },
      requestId,
    },
    {
      status,
      headers: {
        "x-request-id": requestId,
        "set-cookie": "provider-private=value",
        "cache-control": "public, max-age=999",
        ...overrides,
      },
    },
  );
}
async function failure(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("location"), null);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.match(
    body.requestId,
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
  );
  assert.equal(response.headers.get("x-request-id"), body.requestId);
  assert(!JSON.stringify(body).includes("Synthetic upstream detail"));
  assert(!JSON.stringify(body).includes("provider-private"));
  return body;
}
function signedClaims(call: FetchCall, secret: string) {
  const authorization = new Headers(call.options.headers).get("authorization");
  assert(authorization && authorization.startsWith("Bearer "));
  const [header, payload, signature] = authorization.slice(7).split(".");
  assert.equal(
    signature,
    createHmac("sha256", secret)
      .update(header + "." + payload)
      .digest("base64url"),
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}

test("every explicit Community route forwards its contract and correct actor profile", async (t) => {
  assert.equal(operations.length, 26);
  for (const op of operations) {
    await t.test(op.method + " " + op.path, async () => {
      state.calls.length = 0;
      const proofs = state.proofs;
      state.response = () =>
        Response.json(op.response, {
          status: op.success,
          headers: {
            "cache-control": "public, max-age=900",
            "set-cookie": "upstream-private=value",
            location: "https://private-upstream.example.test",
          },
        });
      const response = await invoke(op, {
        headers: {
          authorization: "Bearer synthetic.untrusted.token",
          cookie: "untrusted=value",
          "x-user-id": requestId,
          "x-lash-community-application": "0",
          "x-lash-staging-review-discussions": "synthetic-untrusted-proof",
          "x-lash-staging-review-media": "synthetic-untrusted-proof",
          "x-lash-staging-review-notifications": "synthetic-untrusted-proof",
          "x-lash-workload-token": "synthetic.untrusted.proof",
        },
      });
      assert.equal(response.status, op.success);
      assert.deepEqual(await response.json(), op.response);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("location"), null);
      assert.equal(state.calls.length, 1);
      assert.equal(state.proofs, proofs + 1);
      const call = state.calls[0];
      assert.equal(
        call.url,
        "https://community-gateway.example.test/community" +
          materialize(op.contract),
      );
      assert.equal(call.options.method, op.method);
      assert.equal(call.options.cache, "no-store");
      assert.equal(call.options.redirect, "manual");
      const headers = new Headers(call.options.headers);
      assert.equal(headers.get("x-lash-workload-token"), "synthetic.workload.proof");
      assert.equal(headers.get("x-lash-community-application"), "1");
      for (const name of [
        "cookie",
        "x-user-id",
        "x-lash-staging-review-discussions",
        "x-lash-staging-review-media",
        "x-lash-staging-review-notifications",
      ]) assert.equal(headers.get(name), null);
      const claims = signedClaims(call, op.admin ? adminKey : memberKey);
      assert.equal(claims.iss, "lash-her-frontend");
      assert.equal(
        claims.aud,
        "lash-her-community-api:" + (op.admin ? "admin" : "member"),
      );
      assert.equal(claims.sub, op.admin ? state.adminId : state.memberId);
      assert.equal(claims.exp - claims.iat, 300);
      if (op.admin)
        assert.deepEqual(claims.capabilities, ["community-moderator"]);
      else assert.equal(claims.capabilities, undefined);
      if (op.method === "DELETE") assert.equal(call.options.body, undefined);
      else if (op.payload)
        assert.deepEqual(JSON.parse(String(call.options.body)), op.payload);
    });
  }
});

test("read rollout closure stops every route before auth, token issuance and transport", async () => {
  state.flags.communityReads = false;
  for (const op of operations)
    await failure(await invoke(op), 404, "feature_disabled");
  assert.deepEqual(
    [
      state.auth,
      state.cookies,
      state.issued,
      state.proofs,
      state.admissions,
      state.calls.length,
    ],
    [0, 0, 0, 0, 0, 0],
  );
});

test("write rollout closure stops mutations while reads remain available", async () => {
  state.flags.communityWrites = false;
  for (const op of operations.filter((op) => op.method !== "GET"))
    await failure(await invoke(op), 404, "feature_disabled");
  assert.equal(state.issued, 0);
  assert.equal(state.admissions, 0);
  assert.equal(
    (await spaces.GET(new Request(origin + "/api/community/spaces"))).status,
    200,
  );
});

test("member access and media flags remain independent of moderator authorization", async () => {
  state.flags.customerAccess = false;
  await failure(await invoke(feed), 404, "feature_disabled");
  state.response = () => Response.json(reports.response);
  assert.equal((await invoke(reports)).status, 200);
  assert.equal(state.auth, 1);
  state.flags.customerAccess = true;
  state.flags.communityMedia = false;
  for (const op of operations.filter((op) =>
    op.contract.split("/").includes("media"),
  ))
    await failure(await invoke(op), 404, "feature_disabled");
  state.response = () => Response.json(feed.response);
  assert.equal((await invoke(feed)).status, 200);
});

test("missing, expired and suspended member sessions stop before gateway proof", async () => {
  state.cookie = "";
  await failure(await invoke(feed), 401, "sign_in_required");
  assert.equal(state.issued, 0);
  state.cookie = "synthetic-expired-session";
  state.active = false;
  await failure(await invoke(feed), 401, "sign_in_required");
  assert.equal(state.issued, 1);
  assert.equal(state.proofs, 0);
  assert.equal(state.calls.length, 0);
});

test("moderation requires an owner session with permission and no developer mode", async () => {
  for (const [adminError, status] of [
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["disabled", 403],
  ] as const) {
    state.adminError = adminError;
    await failure(
      await invoke(reports),
      status,
      status === 401 ? "sign_in_required" : "forbidden",
    );
  }
  state.adminError = null;
  state.adminRole = "admin";
  await failure(await invoke(reports), 403, "forbidden");
  await failure(await invoke(moderate), 403, "forbidden");
  state.adminRole = "owner";
  state.adminStatus = "disabled";
  await failure(await invoke(reports), 403, "forbidden");
  state.adminStatus = "active";
  state.developer = true;
  await failure(await invoke(reports), 403, "forbidden");
  assert.equal(state.admissions, 0);
  assert.equal(state.proofs, 0);
  assert.equal(state.calls.length, 0);
});

test("foreign IDs, extra filters, duplicate filters and malformed queries refuse forwarding", async () => {
  for (const query of [
    "?userId=" + second,
    "?after=invalid",
    "?search=",
    "?search=%00",
    "?search=" + "a".repeat(101),
    "?search=a&search=b",
    "?after=" + first + "&after=" + second,
    "?status=open",
  ])
    await failure(await invoke(feed, { query }), 400, "invalid_request");
  for (const query of ["?status=invalid", "?status=open&status=resolved"])
    await failure(await invoke(reports, { query }), 400, "invalid_request");
  const context = { params: Promise.resolve({ courseId: "../internal" }) };
  await failure(await post.execute(request(post), context), 404, "not_found");
  assert.equal(state.issued, 0);
  assert.equal(state.calls.length, 0);
});

test("allowed course search and moderator query values are encoded exactly once", async () => {
  state.response = () => Response.json(feed.response);
  assert.equal(
    (await invoke(feed, { query: "?search=lash%20%26%20curl&after=" + first }))
      .status,
    200,
  );
  assert(
    state.calls.at(-1)!.url.endsWith("?search=lash+%26+curl&after=" + first),
  );
  state.response = () => Response.json(reports.response);
  assert.equal(
    (await invoke(reports, { query: "?status=resolved&after=" + first }))
      .status,
    200,
  );
  assert(state.calls.at(-1)!.url.endsWith("?status=resolved&after=" + first));
});

test("member and moderator mutations enforce origin, host, CSRF, content type and bounded JSON", async () => {
  for (const op of [post, moderate]) {
    for (const headers of [
      { origin: "https://foreign.invalid" },
      { "x-lash-csrf": "" },
      { "sec-fetch-site": "cross-site" },
      { host: "foreign.invalid" },
    ] as Record<string, string>[]) {
      const authChecks = state.auth;
      await failure(await invoke(op, { headers }), 403, "forbidden");
      assert.equal(state.auth, authChecks);
    }
    await failure(
      await invoke(op, { headers: { "content-type": "text/plain" } }),
      415,
      "invalid_request",
    );
    await failure(
      await invoke(op, { headers: { "content-length": "25000" } }),
      413,
      "invalid_request",
    );
    await failure(await invoke(op, { rawBody: "{" }), 400, "invalid_request");
    await failure(
      await invoke(op, {
        rawBody: JSON.stringify({ body: "x".repeat(25000) }),
      }),
      413,
      "invalid_request",
    );
  }
  assert.equal(state.admissions, 0);
  assert.equal(state.issued, 0);
  assert.equal(state.calls.length, 0);
});

test("moderator writes accept the configured admin origin with or without the Auth.js base path", async () => {
  state.response = () => Response.json(moderate.response);
  for (const name of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    for (const path of ["", "/api/auth"]) {
      process.env[name] = origin + path;
      const response = await invoke(moderate);
      assert.equal(response.status, 200, `${name}${path}`);
      assert.deepEqual(await response.json(), moderate.response);
    }
    delete process.env[name];
  }
  assert.equal(state.auth, 4);
  assert.equal(state.calls.length, 4);
});

test("moderator writes reject unsafe configured admin auth URLs before actor lookup", async () => {
  const urls = [
    `https://fixture:synthetic@${new URL(origin).host}/api/auth`,
    `${origin}/api/auth?unexpected=1`,
    `${origin}/api/auth#unexpected`,
    `${origin}/admin`,
  ];
  delete process.env.AUTH_URL;
  for (const name of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    for (const url of urls) {
      process.env[name] = url;
      await failure(await invoke(moderate), 403, "forbidden");
    }
    delete process.env[name];
  }
  assert.equal(state.auth, 0);
  assert.equal(state.admissions, 0);
  assert.equal(state.calls.length, 0);
});

test("schemas reject caller identity and deletion bodies before admission", async () => {
  for (const op of operations.filter((op) => op.method !== "GET")) {
    await failure(
      await invoke(op, { body: { ...op.payload, userId: second } }),
      400,
      "invalid_request",
    );
  }
  for (const rawBody of [
    "null",
    "[]",
    "1",
    JSON.stringify({ body: "not empty" }),
  ])
    await failure(await invoke(remove, { rawBody }), 400, "invalid_request");
  assert.equal(state.admissions, 0);
  assert.equal(state.issued, 0);
  assert.equal(state.calls.length, 0);
});

test("closed admission stops every mutation before signing or forwarding", async () => {
  state.admitted = false;
  for (const op of operations.filter((op) => op.method !== "GET"))
    await failure(await invoke(op), 503, "service_unavailable");
  assert.equal(state.issued, 0);
  assert.equal(state.proofs, 0);
  assert.equal(state.calls.length, 0);
});

test("flags are checked again after writer admission before token issuance", async () => {
  state.onAdmission = () => {
    state.flags.communityWrites = false;
  };
  await failure(await invoke(post), 404, "feature_disabled");
  assert.equal(state.admissions, 1);
  assert.equal(state.issued, 0);
  assert.equal(state.proofs, 0);
});

test("two member requests use separate fresh credentials and private responses", async () => {
  state.response = () =>
    Response.json({
      ...feed.response,
      space: { courseId: first, title: state.memberId },
    });
  const one = await invoke(feed);
  state.memberId = second;
  state.cookie = "synthetic-second-session";
  const two = await invoke(feed);
  assert.equal((await one.json()).space.title, first);
  assert.equal((await two.json()).space.title, second);
  const claims = state.calls.map((call) => signedClaims(call, memberKey));
  assert.deepEqual(
    claims.map((value) => value.sub),
    [first, second],
  );
  assert.notEqual(claims[0].jti, claims[1].jti);
  assert.deepEqual(state.sessions, [
    "synthetic-first-session",
    "synthetic-second-session",
  ]);
  assert(
    state.cookieNames.every(
      (name) => name === "__Host-lash-customer.session-token",
    ),
  );
  assert.equal(one.headers.get("cache-control"), "private, no-store");
  assert.equal(two.headers.get("cache-control"), "private, no-store");
});

test("Community errors become stable safe UI errors and preserve bounded Retry-After", async () => {
  for (const [status, upstream, code, expected] of [
    [401, "unauthorized", "service_unavailable", 503],
    [403, "ACTIVE_ENROLLMENT_REQUIRED", "access_required", 403],
    [403, "ENTITLEMENT_REVOKED", "access_revoked", 403],
    [403, "participation_suspended", "participation_suspended", 403],
    [404, "not_found", "not_found", 404],
    [409, "conflict", "conflict", 409],
    [422, "validation_failed", "invalid_request", 400],
    [429, "rate_limit_exceeded", "rate_limited", 429],
    [500, "internal_error", "service_unavailable", 503],
    [503, "course_authority_unavailable", "service_unavailable", 503],
  ] as const) {
    state.response = () => incoming(upstream, status, { "retry-after": "17" });
    const response = await invoke(feed);
    const result = await failure(response, expected, code);
    assert.equal(result.requestId, requestId);
    if (status === 429 || expected === 503)
      assert.equal(
        response.headers.get("retry-after"),
        status === 401 ? "30" : "17",
      );
  }
  state.response = () =>
    incoming("rate_limit_exceeded", 429, { "retry-after": "not-a-delay" });
  assert.equal((await invoke(feed)).headers.get("retry-after"), null);
});

test("malformed success, error, non-JSON, unexpected status, and redirects fail safely", async () => {
  for (const response of [
    () =>
      Response.json({ ...feed.response, private: "Synthetic upstream detail" }),
    () => Response.json({ ...feed.response, posts: "invalid" }),
    () => Response.json({ spaces: [], next: null }, { status: 201 }),
    () => Response.json({ error: { code: "private" } }, { status: 403 }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response("Synthetic upstream detail", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://private-upstream.example.test" },
      }),
    () => {
      throw new Error("Synthetic upstream detail");
    },
  ]) {
    state.response = response;
    await failure(await invoke(feed), 503, "service_unavailable");
  }
});

test("invalid keys fail before upstream transport and profiles cannot share signing keys", async () => {
  delete process.env.COMMUNITY_MEMBER_JWT_CURRENT_SECRET;
  await failure(await invoke(feed), 503, "service_unavailable");
  assert.equal(state.calls.length, 0);
  process.env.COMMUNITY_MEMBER_JWT_CURRENT_SECRET = memberKey;
  process.env.COMMUNITY_ADMIN_JWT_CURRENT_SECRET = memberKey;
  await failure(await invoke(feed), 503, "service_unavailable");
  await failure(await invoke(moderate), 503, "service_unavailable");
  assert.equal(state.proofs, 0);
  assert.equal(state.calls.length, 0);
});

test("gateway failures preserve maintenance and quota responses and uncertain writes require review", async () => {
  for (const [code, status, expected, uncertain] of [
    ["release_maintenance", 503, "service_unavailable", 0],
    ["rate_limit_exceeded", 429, "rate_limited", 0],
    ["invalid_workload", 401, "service_unavailable", 0],
    ["upstream_unavailable", 502, "service_unavailable", 1],
  ] as const) {
    state.response = () =>
      Response.json(
        {
          requestId,
          error: { code, message: code.replaceAll("_", " ") },
        },
        { status, headers: { "x-request-id": requestId, "retry-after": "12" } },
      );
    const response = await invoke(post);
    await failure(response, status === 429 ? 429 : 503, expected);
    assert.equal(state.uncertain, uncertain);
  }
});

test("write transport failures and malformed replies mark the actual writer context uncertain", async () => {
  for (const response of [
    () => incoming("internal_error", 500),
    () =>
      Response.json({ private: "Synthetic upstream detail" }, { status: 201 }),
    () => {
      throw new Error("Synthetic upstream detail");
    },
  ]) {
    const before = state.uncertain;
    state.response = response;
    await failure(await invoke(post), 503, "service_unavailable");
    assert.equal(state.uncertain, before + 1);
  }
});

test("media reservation marks receiver failures uncertain when an upload may already be reserved", async () => {
  for (const [code, uncertain] of [
    ["media_unavailable", 1],
    ["course_authority_unavailable", 1],
    ["media_capacity", 0],
  ] as const) {
    const before = state.uncertain;
    state.response = () => incoming(code, 503);
    await failure(await invoke(reserveImage), 503, "service_unavailable");
    assert.equal(state.uncertain, before + uncertain, code);
  }
  assert.equal(state.calls.length, 3);
});

test("Community transport refuses internal, arbitrary and webhook routes before workload proof", async () => {
  let proofs = 0;
  const transport = createGatewayTransport({
    origin: "https://community-gateway.example.test",
    getWorkloadToken: async () => {
      proofs++;
      return "synthetic.workload.proof";
    },
  });
  for (const [method, path] of [
    ["GET", "/metrics"],
    ["POST", "/v1/internal/course/enrollment-events"],
    ["POST", "/v1/internal/accounts/commands"],
    ["GET", "/v1/internal/accounts/exports/" + first],
    ["POST", "/v1/webhooks/square"],
    ["GET", "/v1/spaces/../moderation/reports"],
    ["GET", "//invalid.example.test"],
    ["GET", "/v1/unknown"],
  ] as const)
    await assert.rejects(
      transport({
        service: "community",
        communityApplication: true,
        method,
        path,
        applicationToken: "synthetic.application.jwt",
      }),
      GatewayTransportError,
    );
  assert.equal(proofs, 0);
});

test("every Community operation rejects unexpected success fields without disclosing them", async (t) => {
  for (const op of operations) {
    await t.test(op.method + " " + op.path, async () => {
      state.response = () =>
        Response.json(
          { ...op.response, private: "Synthetic upstream detail" },
          { status: op.success },
        );
      await failure(await invoke(op), 503, "service_unavailable");
    });
  }
});

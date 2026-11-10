import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createHmac, randomUUID } from "node:crypto";
import test, { before } from "node:test";
import { AdminAuthenticationFreshnessError, type AdminActor } from "@/lib/admin/types";
import { VERCEL_PROJECT_BINDINGS } from "@/lib/env/application-environment.mjs";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import { attestInteractiveRequest, INTERACTIVE_COOKIE, INTERACTIVE_HEADER, INTERACTIVE_ORIGIN } from "@/lib/writer-admission/interactive-proof";
import type { AccountLifecycleStore } from "./store";

let createAccountHandler: typeof import("./handler").createAccountHandler;
let requestAdminAccountAction: typeof import("./handler").requestAdminAccountAction;
before(async () => {
  Object.assign(globalThis, { AsyncLocalStorage });
  ({ createAccountHandler, requestAdminAccountAction } = await import("./handler"));
});

const origin = "https://customer.example.com";
const session = { userId: randomUUID(), tokenHash: "synthetic-session-hash" };
function selection(actorKind: string, actorId: string, userId: string, operation: string) {
  return createHash("sha256").update(JSON.stringify([actorKind, actorId, userId, operation])).digest("hex");
}
function fixture(selectionSha256?: string, fixtureOrigin = origin) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const store = {
    async request(input: unknown) { calls.push({ operation: "command", input }); return { commandId: randomUUID(), userId: session.userId, accountVersion: 1, action: "export" }; },
    async updatePreferences(...input: unknown[]) { calls.push({ operation: "preferences", input }); },
    async overview(input: unknown) { calls.push({ operation: "overview", input }); return { commands: [] }; },
    async getExport(...input: unknown[]) { calls.push({ operation: "export", input }); return { private: true }; },
  } as unknown as AccountLifecycleStore;
  const handler = createAccountHandler({ enabled: () => true, origin: () => fixtureOrigin, session: async () => session, store: () => store,
    run: async (_kind, task) => { calls.push({ operation: "admission", input: null }); return withWriterOperationContext(task, undefined, selectionSha256); } });
  return { handler, calls, store };
}
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("customer account commands derive identity from the server session and enter admission before writing", async () => {
  const { handler, calls } = fixture();
  const idempotencyKey = randomUUID();
  const response = await handler(post("/api/account/commands", { action: "export", idempotencyKey }));
  assert.equal(response.status, 202); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls.map(row => row.operation), ["admission", "command"]);
  assert.deepEqual(calls[1].input, { userId: session.userId, action: "export", idempotencyKey, requester: { kind: "customer", session } });
  assert.equal(JSON.stringify(await response.json()).includes(session.tokenHash), false);
});

test("scoped customer mutations deny a different actor, target, action, or preference value", async () => {
  const foreign = randomUUID();
  const target = session.userId;
  for (const [digest, path, body, status, operation] of [
    [selection("customer", foreign, target, "export"), "/api/account/commands", { action: "export", idempotencyKey: randomUUID() }, 403, undefined],
    [selection("customer", target, foreign, "export"), "/api/account/commands", { action: "export", idempotencyKey: randomUUID() }, 403, undefined],
    [selection("admin", target, target, "export"), "/api/account/commands", { action: "export", idempotencyKey: randomUUID() }, 403, undefined],
    [selection("customer", target, target, "export"), "/api/account/commands", { action: "delete", idempotencyKey: randomUUID() }, 403, undefined],
    [selection("customer", target, target, "export"), "/api/account/commands", { action: "export", idempotencyKey: randomUUID() }, 202, "command"],
    [selection("customer", target, target, "preferences-on"), "/api/account/preferences", { learningUpdates: false }, 403, undefined],
    [selection("customer", target, target, "preferences-off"), "/api/account/preferences", { learningUpdates: false }, 200, "preferences"],
  ] as const) {
    const { handler, calls } = fixture(digest);
    const response = await handler(post(path, body));
    assert.equal(response.status, status);
    assert.deepEqual(calls.map(row => row.operation), operation ? ["admission", operation] : ["admission"]);
    assert.equal((await response.text()).includes(digest), false);
  }
});

test("scoped administrator commands check the already-bound actor and resource before identity refresh or command creation", async () => {
  const ownerId = randomUUID(), foreign = randomUUID(), userId = randomUUID();
  const actor: AdminActor = {
    bookingProviderResourceIds: [], bookingResourceIds: [],
    user: { id: ownerId, role: "owner", status: "active", displayName: null, email: "owned@example.test",
      emailNormalized: "owned@example.test", providerUserId: "synthetic-provider" },
  };
  const input = { userId, action: "suspend", idempotencyKey: randomUUID() } as const;
  for (const [digest, owner, fresh, expected, command] of [
    [selection("admin", ownerId, userId, "suspend"), null, true, ["admission", "owner-read"], false],
    [selection("admin", ownerId, userId, "suspend"), foreign, true, ["admission", "owner-read"], false],
    [selection("admin", ownerId, foreign, "suspend"), ownerId, true, ["admission", "owner-read"], false],
    [selection("admin", ownerId, userId, "restore"), ownerId, true, ["admission", "owner-read"], false],
    [selection("admin", ownerId, userId, "suspend"), ownerId, false, ["admission", "owner-read", "actor", "fresh"], false],
    [selection("admin", ownerId, userId, "suspend"), ownerId, true, ["admission", "owner-read", "actor", "fresh"], true],
    [undefined, null, true, ["admission", "actor", "fresh"], true],
  ] as const) {
    const calls: string[] = [];
    const { store, calls: storeCalls } = fixture();
    const result = requestAdminAccountAction(input, {
      enabled: () => true, store: () => store,
      authorization: async () => ({
        async readActiveOwnerId() { calls.push("owner-read"); return owner; },
        async requireAdminActor() { calls.push("actor"); return actor; },
        async requireFreshAdminGoogleAuthentication() {
          calls.push("fresh");
          if (!fresh) throw new AdminAuthenticationFreshnessError("expired");
          return new Date();
        },
      }),
      async run(_kind, task) { calls.push("admission"); return withWriterOperationContext(task, undefined, digest); },
    });
    if (command) {
      await result;
      assert.deepEqual(storeCalls, [{ operation: "command", input: { ...input, requester: { kind: "admin", adminId: ownerId } } }]);
    } else {
      await assert.rejects(result, { status: 403, code: fresh ? "account_action_denied" : "fresh_sign_in_required" });
      assert.deepEqual(storeCalls, []);
    }
    assert.deepEqual(calls, expected);
  }
});
test("CSRF, unexpected bodies, privileged actions and oversized input refuse before admission or data access", async () => {
  const { handler, calls } = fixture();
  for (const request of [
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID() }, { origin: "https://attacker.example" }),
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID() }, { "sec-fetch-site": "cross-site" }),
    post("/api/account/commands", { action: "delete", idempotencyKey: randomUUID(), userId: randomUUID() }),
    post("/api/account/commands", { action: "restore", idempotencyKey: randomUUID() }),
    post("/api/account/commands", { action: "suspend", idempotencyKey: randomUUID() }),
    post("/api/account/commands", { value: "x".repeat(5_000) }),
    post("/api/account/preferences", { learningUpdates: true, marketing: true }),
  ]) assert.ok((await handler(request)).status >= 400);
  assert.equal(calls.length, 0);
});
test("private download is bound to the authenticated UUID, uses attachment/no-store and refuses malformed paths", async () => {
  const { handler, calls } = fixture();
  const commandId = randomUUID();
  const response = await handler(new Request(`${origin}/api/account/exports/${commandId}`));
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.deepEqual(calls[0], { operation: "export", input: [session.userId, commandId] });
  for (const path of ["/api/account/exports/not-a-uuid", `/api/account/exports/${commandId}?userId=${randomUUID()}`, "/api/account/other"]) assert.ok((await handler(new Request(`${origin}${path}`))).status >= 400);
  assert.equal(calls.length, 1);
});

test("real Next request context restricts a scoped overview to the selected customer and supplies no export download authority", async (t) => {
  const { NextRequest } = await import("next/server");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store.js");
  const { createWorkStore } = await import("next/dist/server/async-storage/work-store.js");
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
  const environment = {
    APP_ENV: "staging", VERCEL_ENV: "production", VERCEL_TARGET_ENV: "production",
    APP_VERCEL_TEAM_ID: VERCEL_PROJECT_BINDINGS.teamId, VERCEL_PROJECT_ID: VERCEL_PROJECT_BINDINGS.stagingProjectId,
    VERCEL_URL: "owned-staging-build.vercel.app", VERCEL_GIT_COMMIT_SHA: "a".repeat(40), FRONTEND_WRITER_ADMISSION_MODE: "enforce",
    FRONTEND_WRITER_ADMISSION_TARGET_JSON: JSON.stringify({ targetSha256: "b".repeat(64) }), CRON_SECRET: "owned-test-cron-key-no-live-credentials",
    ADMIN_DEVELOPER_MODE: "false",
  };
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const now = Math.floor(Date.now() / 1000);
  const { handler, calls } = fixture(undefined, INTERACTIVE_ORIGIN);
  async function call(path: string, digest: string) {
    const body = `v2.12.lifecycle.${now}.${now + 120}.${"c".repeat(32)}.${digest}`;
    const mac = createHmac("sha256", environment.CRON_SECRET)
      .update(`lash-her:p2q:interactive:browser:v1\n${environment.VERCEL_URL}\n${environment.VERCEL_GIT_COMMIT_SHA}\n${"b".repeat(64)}\n${body}`).digest("hex");
    const cookie = `${body}.${mac}`;
    const proof = attestInteractiveRequest({ origin: INTERACTIVE_ORIGIN, method: "GET", path, cookie }, environment, now);
    assert.ok(proof);
    const request = new NextRequest(INTERACTIVE_ORIGIN + path, { headers: {
      cookie: `${INTERACTIVE_COOKIE}=${cookie}`, [INTERACTIVE_HEADER]: proof,
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
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, () => handler(request)));
  }
  const foreign = randomUUID();
  const approved = selection("customer", session.userId, session.userId, "export");
  assert.equal((await call("/api/account", selection("customer", foreign, foreign, "export"))).status, 403);
  assert.equal((await call(`/api/account/exports/${randomUUID()}`, approved)).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await call("/api/account", approved)).status, 200);
  assert.deepEqual(calls, [{ operation: "overview", input: session.userId }]);
});
test("disabled and unauthenticated routes make no store or admission calls; unexpected failures expose no private details", async () => {
  const { store } = fixture();
  for (const sessionResolver of [async () => null, async () => { throw new Error("secret-provider-body"); }]) {
    const handler = createAccountHandler({ enabled: () => true, origin: () => origin, session: sessionResolver, store: () => { throw new Error("must-not-access-store"); } });
    const response = await handler(new Request(`${origin}/api/account`));
    assert.ok(response.status >= 400); assert.equal((await response.text()).includes("secret-provider-body"), false);
  }
  const disabled = createAccountHandler({ enabled: () => false, session: async () => { throw new Error(); }, store: () => store });
  assert.equal((await disabled(new Request(`${origin}/api/account`))).status, 404);
});

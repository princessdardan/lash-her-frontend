import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Real exported authorization, Auth.js JWT decoding, permission/account policy,
// Next request storage and after scheduling. The user repository and admission
// protocol peer are controlled; no configured DB or provider is contacted.
const scenario = String.raw`
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { interactiveAdmissionFixture } from "./src/lib/writer-admission/interactive-fixture.ts";
import { AdminAuthError } from "./src/lib/admin/types.ts";
globalThis.AsyncLocalStorage ??= AsyncLocalStorage;
const { NextRequest } = await import("next/server.js");
const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store.js");
const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
const { AfterContext } = await import("next/dist/server/after/after-context.js");
const { encode } = await import("next-auth/jwt");
const requestContext = new AsyncLocalStorage(), requests = [], rows = new Map();
const secret = "owned-admin-actor-isolation-distinct-secret-32", origin = "https://owned.example.invalid";
Object.assign(process.env, { AUTH_SECRET: secret, AUTH_URL: origin, AUTH_TRUST_HOST: "true",
  AUTH_GOOGLE_ID: "owned-admin-google", AUTH_GOOGLE_SECRET: "owned-admin-google-secret" });
globalThis.fetch = async () => { throw new Error("unexpected provider request"); };
const current = () => { const state = requestContext.getStore(); assert.ok(state); return state; };
const active = () => assert.ok(current().admissions.some(fixture => fixture.events.includes("admitted") && !fixture.state.finished));
const store = {
  async findByProviderUserId(id) { active(); current().reads++; const row = [...rows.values()].find(row => row.providerUserId === id); return row ? { ...row } : null; },
  async findByEmailNormalized(email) { active(); current().reads++; const row = [...rows.values()].find(row => row.emailNormalized === email); return row ? { ...row } : null; },
  async recordSignIn(input) { active(); current().refreshes++; if (current().gate) { current().gate.enter(); await current().gate.held; } return { ...rows.get(input.adminUserId) }; },
  async listBookingProviderResourceIds() { active(); return []; },
  async listBookingResourceIds() { active(); return []; },
  async bindIdentity() { throw new Error("unexpected identity binding"); },
  async createBootstrapOwner() { throw new Error("unexpected bootstrap"); },
};
globalThis.__adminActorIsolation = { store, current,
  async run(kind, work) { const state = current(), fixture = interactiveAdmissionFixture(); fixture.state.open = state.open;
    state.admissions.push(fixture); return fixture.run(kind, work); } };
const directory = mkdtempSync(join(tmpdir(), "admin-actor-isolation-")), stubs = new Map();
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
function stub(source) {
  const path = join(directory, "stub_" + stubs.size + ".cjs"), url = pathToFileURL(path).href;
  stubs.set(url, source); writeFileSync(path, source); return { url, format: "commonjs", shortCircuit: true };
}
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/lib/writer-admission/runtime") return stub("exports.runWriterAdmission = (...args) => globalThis.__adminActorIsolation.run(...args);");
  if (specifier === "./admin-user-store" && context.parentURL.endsWith("/admin/auth.ts")) return stub("exports.getAdminUserStore = () => globalThis.__adminActorIsolation.store;");
  if (specifier === "./developer-mode" && context.parentURL.endsWith("/admin/auth.ts")) return stub("exports.getAdminDeveloperActor = async () => null;");
  if (specifier === "./audit-log" && context.parentURL.endsWith("/admin/auth.ts")) return stub("exports.recordAdminAuditBestEffort = async () => { globalThis.__adminActorIsolation.current().audits++; };");
  return next(specifier, context);
}, load(url, context, next) {
  if (stubs.has(url)) return { format: "commonjs", source: stubs.get(url), shortCircuit: true };
  return next(url, context);
} });
const { requireAdminActor, requirePermission } = await import("./src/lib/admin/auth.ts");
const { runAdminAuthorizationOperation } = await import("./src/lib/admin/authorization-operation.ts");
const row = (id, role = "owner", status = "active") => ({ id, providerUserId: "google-" + id, email: id + "@example.invalid",
  emailNormalized: id + "@example.invalid", displayName: id, role, status });
rows.set("owner-a", row("owner-a")); rows.set("employee-b", row("employee-b", "employee")); rows.set("disabled-c", row("disabled-c", "owner", "disabled"));
const cookies = new Map();
for (const user of rows.values()) cookies.set(user.id, "__Secure-authjs.session-token=" + await encode({ secret, salt: "__Secure-authjs.session-token", maxAge: 3600,
  token: { sub: user.providerUserId, providerUserId: user.providerUserId, email: user.email, name: user.displayName,
    googleEmailVerified: true, adminAuthenticatedAt: Math.floor(Date.now() / 1000) } }));
function hold() { let enter, release; const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; }); return { entered, enter, held, release }; }
function request(userId, header, work, { gate, open = true } = {}) {
  const closes = [], waits = [], errors = [], state = { admissions: [], reads: 0, refreshes: 0, audits: 0, gate, open };
  const afterContext = new AfterContext({ waitUntil: pending => waits.push(pending), onClose: callback => closes.push(callback), onTaskError: error => errors.push(error) });
  const req = new NextRequest(origin + "/api/admin/customer-accounts/owned/commands", { headers: {
    host: new URL(origin).host, cookie: cookies.get(userId), ...(header ? { "x-lash-admin-request-id": header } : {}),
  } });
  const store = createRequestStoreForAPI(req, new URL(req.url));
  const promise = requestContext.run(state, () => workAsyncStorage.run({ route: new URL(req.url).pathname, isStaticGeneration: false, afterContext }, () =>
    workUnitAsyncStorage.run(store, () => Promise.resolve().then(work))));
  const result = { state, promise, async close() { closes.forEach(close => close()); await Promise.all(waits); assert.deepEqual(errors, []); } };
  promise.catch(() => {}); requests.push(result); return result;
}
const outcome = pending => pending.then(actor => ({ id: actor.user.id }), error => ({ error: error.code ?? error.name }));
const observations = {};
try {
  for (const [name, other] of [["differentActive", "employee-b"], ["disabledAccount", "disabled-c"]]) {
    const gate = hold(), header = "caller-selected-" + name;
    const first = request("owner-a", header, requireAdminActor, { gate }); await gate.entered;
    const second = request(other, header, requireAdminActor); const secondOutcome = outcome(second.promise);
    await new Promise(resolve => setImmediate(resolve)); gate.release();
    observations[name] = { first: await outcome(first.promise), second: await secondOutcome, secondReads: second.state.reads,
      admissions: [first.state.admissions.length, second.state.admissions.length] };
    await first.close(); await second.close();
  }
  const lifetime = hold(), header = "caller-selected-status-change";
  const first = request("owner-a", header, async () => { const actor = await requireAdminActor(); lifetime.enter(); await lifetime.held; return actor; });
  await lifetime.entered; rows.get("owner-a").status = "disabled";
  const second = request("owner-a", header, requireAdminActor), control = request("owner-a", header + "-control", requireAdminActor);
  observations.statusChange = { second: await outcome(second.promise), control: await outcome(control.promise), secondReads: second.state.reads };
  lifetime.release(); await first.promise; await first.close(); await second.close(); await control.close(); rows.get("owner-a").status = "active";
  for (const key of ["caller-selected-nested", undefined]) {
    const nested = request("owner-a", key, () => runAdminAuthorizationOperation(async () => {
      const actors = await Promise.all([requireAdminActor(), requirePermission("admin:view"), requireAdminActor()]);
      return { user: { id: actors.map(actor => actor.user.id).join(",") } };
    }));
    observations[key ? "nestedWithHeader" : "nestedWithoutHeader"] = { result: await outcome(nested.promise), reads: nested.state.reads,
      refreshes: nested.state.refreshes, admissions: nested.state.admissions.length };
    await nested.close();
  }
  const sequential = request("owner-a", "caller-selected-independent-operations", async () => {
    await requireAdminActor(); rows.get("owner-a").status = "disabled";
    try { return await requireAdminActor(); } finally { rows.get("owner-a").status = "active"; }
  });
  observations.independentOperations = { result: await outcome(sequential.promise), reads: sequential.state.reads,
    refreshes: sequential.state.refreshes, admissions: sequential.state.admissions.length };
  await sequential.close();
  const denied = request("disabled-c", "caller-selected-denied", () => runAdminAuthorizationOperation(async () => {
    const results = await Promise.allSettled([requireAdminActor(), requireAdminActor(), requireAdminActor()]);
    assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof AdminAuthError && result.reason.code === "disabled"));
    return { user: { id: "three-known-denials" } };
  }));
  observations.nestedDenial = { result: await outcome(denied.promise), reads: denied.state.reads, refreshes: denied.state.refreshes,
    admissions: denied.state.admissions.length, uncertain: denied.state.admissions.some(fixture => fixture.state.uncertain) };
  await denied.close();
  const closed = request("owner-a", "caller-selected-closed", requireAdminActor, { open: false });
  observations.closed = { result: await outcome(closed.promise), reads: closed.state.reads, refreshes: closed.state.refreshes };
  await closed.close();
  console.log(JSON.stringify(observations));
} finally {
  for (const request of requests) await request.close();
}
`;

test("real Auth.js administrator actors stay within their authorization operation despite repeated inbound request IDs", () => {
  const result = spawnSync(process.execPath, ["--import", "./scripts/register-server-only-test.mjs", "--import", "tsx",
    "--input-type=module", "--eval", scenario], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", APP_ENV: "local", NODE_NO_WARNINGS: "1" },
  });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const observations = JSON.parse(result.stdout.trim());
  assert.deepEqual(observations, {
    differentActive: { first: { id: "owner-a" }, second: { id: "employee-b" }, secondReads: 2, admissions: [1, 1] },
    disabledAccount: { first: { id: "owner-a" }, second: { error: "disabled" }, secondReads: 2, admissions: [1, 1] },
    statusChange: { second: { error: "disabled" }, control: { error: "disabled" }, secondReads: 2 },
    nestedWithHeader: { result: { id: "owner-a,owner-a,owner-a" }, reads: 2, refreshes: 1, admissions: 1 },
    nestedWithoutHeader: { result: { id: "owner-a,owner-a,owner-a" }, reads: 2, refreshes: 1, admissions: 1 },
    independentOperations: { result: { error: "disabled" }, reads: 4, refreshes: 1, admissions: 2 },
    nestedDenial: { result: { id: "three-known-denials" }, reads: 2, refreshes: 0, admissions: 1, uncertain: false },
    closed: { result: { error: "unavailable" }, reads: 0, refreshes: 0 },
  });
});

test("the actual proxy matcher does not overwrite caller request IDs on administrator API routes", async () => {
  const source = ts.createSourceFile("proxy.ts", readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let matcher: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "config" && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const property = node.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === "matcher");
      assert.ok(property && ts.isPropertyAssignment(property) && ts.isArrayLiteralExpression(property.initializer));
      matcher = property.initializer.elements.map(element => { assert.ok(ts.isStringLiteral(element)); return element.text; });
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(matcher?.length);
  // This installed Next release exposes the proxy matcher utility under its
  // previous middleware name, including in its current TypeScript declaration.
  const { unstable_doesMiddlewareMatch } = await import("next/dist/experimental/testing/server/middleware-testing-utils.js");
  for (const url of ["/admin", "/admin/customer-accounts"]) assert.equal(unstable_doesMiddlewareMatch({ config: { matcher }, nextConfig: {}, url }), true);
  for (const url of ["/api/admin/customer-accounts/owned/commands", "/api/admin/shipping/labels"])
    assert.equal(unstable_doesMiddlewareMatch({ config: { matcher }, nextConfig: {}, url }), false);
});

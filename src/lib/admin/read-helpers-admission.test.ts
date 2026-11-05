import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// Actual exported helpers, admission runner, SQL-building code and Google SDK;
// only auth identity, business query results and provider transport are controlled.
// No configured database, credentials or provider network access is used.
const scenario = String.raw`
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { interactiveAdmissionFixture } from "./src/lib/writer-admission/interactive-fixture.ts";
import { AdminAuthError } from "./src/lib/admin/types.ts";
import { markWriterOperationUncertain } from "./src/lib/writer-admission/context.ts";
import { WriterAdmissionError } from "./src/lib/writer-admission/config.ts";
const actor = { user: { id: "00000000-0000-4000-8000-000000000001", role: "owner" }, bookingResourceIds: [], bookingProviderResourceIds: [] };
let state;
const checks = [];
function reset() {
  const fixture = interactiveAdmissionFixture();
  state = { fixture, actor, queries: [], authError: null, auditUnknown: false, auditCalls: 0, credentialReads: 0, requests: [], dbCalls: 0, fetch: null };
  globalThis.__ownedAdminRead = state;
  return fixture;
}
function active() { assert.equal(state.fixture.events[0], "admitted"); assert.equal(state.fixture.state.finished, false); }
function query() {
  const chain = new Proxy({}, { get(_target, name) {
    if (name === "then") return (resolve, reject) => Promise.resolve().then(async () => {
      active();
      assert.ok(state.queries.length, "unexpected business SQL");
      const next = state.queries.shift();
      return typeof next === "function" ? next() : next;
    }).then(resolve, reject);
    if (name === "as") return () => ({ emailNormalized: "email", createdAt: "created", deadLetteredAt: "dead", lastAttemptedAt: "attempt", status: "status", succeededAt: "success" });
    return () => chain;
  }});
  return chain;
}
const db = { select: query, selectDistinctOn: query };
globalThis.__ownedAdminReadDependencies = {
  requirePermission: async () => { active(); if (state.authError) throw state.authError; return state.actor; },
  getPrivateDb: () => { active(); state.dbCalls++; return db; },
  recordAdminAudit: async () => { active(); state.auditCalls++; if (state.auditUnknown) markWriterOperationUncertain(); return { id: "owned-audit" }; },
  getCredential: async () => { active(); state.credentialReads++; return { refreshToken: "owned-refresh", scopes: [] }; },
};
const stubs = new Map();
const stubDirectory = mkdtempSync(join(tmpdir(), "owned-admin-read-stubs-"));
process.on("exit", () => rmSync(stubDirectory, { recursive: true, force: true }));
const stub = source => {
  const path = join(stubDirectory, "read_" + stubs.size + ".cjs");
  const url = pathToFileURL(path).href;
  stubs.set(url, source.replace(/export const (\w+) =/g, "exports.$1 ="));
  writeFileSync(path, stubs.get(url));
  return { url, format: "commonjs", shortCircuit: true };
};
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/lib/writer-admission/runtime") return stub('export const runWriterAdmission = (kind, work) => globalThis.__ownedAdminRead.fixture.run(kind, work);');
  if (specifier === "@/lib/private-db/client") return stub('export const getPrivateDb = () => globalThis.__ownedAdminReadDependencies.getPrivateDb();');
  if (specifier === "./auth" && context.parentURL.includes("/src/lib/admin/")) return stub('export const requirePermission = (...args) => globalThis.__ownedAdminReadDependencies.requirePermission(...args);');
  if (specifier === "./audit-log" && context.parentURL.includes("/src/lib/admin/")) return stub('export const recordAdminAudit = (...args) => globalThis.__ownedAdminReadDependencies.recordAdminAudit(...args); export const recordAdminAuditBestEffort = (...args) => globalThis.__ownedAdminReadDependencies.recordAdminAudit(...args); export const sanitizeAdminAuditMetadata = value => value;');
  if (specifier === "@/sanity/env") return stub('export const getBookingEnv = () => ({googleClientId:"owned-google-client",googleClientSecret:"owned-google-secret",googleRedirectUri:"https://owned.invalid/callback"});');
  if (specifier === "./operational-store" && context.parentURL.includes("/booking/google-calendar")) return stub('export const getGoogleRefreshToken = async () => { throw new Error("legacy credential forbidden"); };');
  if (specifier === "@/lib/private-db/calendar-connection-repository") return stub('export const createDrizzleCalendarConnectionRepository = () => ({getActiveGoogleCredential: (...args) => globalThis.__ownedAdminReadDependencies.getCredential(...args)});');
  return next(specifier, context);
}, load(url, context, next) {
  if (stubs.has(url)) return { format: "commonjs", source: stubs.get(url), shortCircuit: true };
  return next(url, context);
}});
globalThis.fetch = async (input, options) => {
  active();
  const url = new URL(typeof input === "string" ? input : input.url ?? input);
  state.requests.push({ origin: url.origin, path: url.pathname, method: options?.method ?? "GET" });
  if (state.fetch) return state.fetch(url, options);
  throw new Error("unintercepted provider request refused");
};
const detail = await import("./src/lib/admin/appointment-read.ts");
const operations = await import("./src/lib/admin/operations-read.ts");
const discovery = await import("./src/lib/admin/calendar-discovery.ts");
const calendar = await import("./src/lib/booking/google-calendar.ts");
const employee = await import("./src/lib/admin/employee-calendar.ts");
const { runAdminReadOperation } = await import("./src/lib/admin/read-operation.ts");
const id = "00000000-0000-4000-8000-000000000002";
const exports = [
  ["appointment detail", () => detail.getAdminAppointmentDetail(id)],
  ["legacy appointment detail", () => operations.getAdminAppointmentDetail(id)],
  ["marketing contacts", () => operations.listAdminMarketingContacts()],
  ["owner Calendar discovery", () => discovery.listConnectedGoogleCalendars(id)],
  ["direct Calendar list", () => calendar.listConnectionGoogleCalendars(id)],
  ["employee Calendar discovery", () => employee.listEmployeeGoogleCalendars({connectionId:id,resourceId:id})],
];
for (const [name, load] of exports) {
  const fixture = reset(); fixture.state.open = false;
  await assert.rejects(load(), WriterAdmissionError);
  assert.equal(state.dbCalls, 0); assert.equal(state.credentialReads, 0); assert.equal(state.requests.length, 0);
  checks.push(name + ":closed-before-effects");
}
for (const [name, load] of exports.filter(([name]) => name !== "direct Calendar list")) {
  const fixture = reset(); state.authError = new AdminAuthError("forbidden");
  await assert.rejects(load(), AdminAuthError);
  assert.equal(fixture.state.finished, true); assert.equal(fixture.state.uncertain, false);
  assert.equal(state.dbCalls, 0); assert.equal(state.requests.length, 0);
  checks.push(name + ":known-denial-completes");
}
const row = {
  id, status: "confirmed", calendarSyncStatus: "booked", paymentStatus: "paid", origin: "online",
  customerName: "Owned", customerEmail: "owned@example.invalid", customerPhone: null,
  publicReference: "owned", selectedStart: new Date("2026-11-05T15:00:00Z"), selectedEnd: new Date("2026-11-05T16:00:00Z"),
  createdAt: new Date("2026-11-05T15:00:00Z"), updatedAt: new Date("2026-11-05T15:00:00Z"),
  bookingConfirmationEmailSentAt: new Date(), bookingConfirmationEmailLastError: null,
  offeringSnapshot: null, providerSnapshot: null, intakeSnapshot: null,
};
{
  const fixture = reset(); let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.queries = [[{ timezone: "America/Toronto" }], [row], async () => { assert.equal(state.auditCalls, 1); entered(); await held; return []; }];
  const pending = detail.getAdminAppointmentDetail(id); await started;
  assert.equal(fixture.state.finished, false); release();
  assert.equal((await pending).id, id); assert.equal(fixture.state.uncertain, false);
  assert.deepEqual(fixture.events, ["admitted", "settled"]);
  checks.push("appointment:post-audit-lookup-retains-admission");
}
{
  const fixture = reset(); let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.queries = [async () => { throw new Error("settings query failed"); }, async () => { entered(); await held; return [row]; }];
  const assertion = assert.rejects(detail.getAdminAppointmentDetail(id), WriterAdmissionError); await started;
  assert.equal(fixture.state.finished, false); release(); await assertion;
  assert.equal(fixture.state.uncertain, true); assert.equal(state.auditCalls, 0);
  checks.push("appointment:failed-read-awaits-started-sibling");
}
{
  const fixture = reset(); state.queries = [[row]];
  assert.equal((await operations.getAdminAppointmentDetail(id)).id, id);
  assert.equal(state.auditCalls, 1); assert.equal(fixture.state.uncertain, false);
  checks.push("legacy-appointment:read-and-audit-one-operation");
}
for (const unknown of [false, true]) {
  const fixture = reset(); state.auditUnknown = unknown;
  state.queries = [[{ count: 0 }], [{ currentAudience: 0, deliveryIssues: 0, total: 0, unsubscribed: 0 }], [], []];
  if (unknown) await assert.rejects(operations.listAdminMarketingContacts(), WriterAdmissionError);
  else assert.equal((await operations.listAdminMarketingContacts()).rows.length, 0);
  assert.equal(state.auditCalls, 1); assert.equal(fixture.state.uncertain, unknown);
  checks.push("marketing:read-and-audit-" + (unknown ? "uncertain" : "complete"));
}
{
  const fixture = reset(); let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.queries = [async () => { throw new Error("count failed"); }, async () => { entered(); await held; return []; }, []];
  const assertion = assert.rejects(operations.listAdminMarketingContacts(), WriterAdmissionError); await started;
  assert.equal(fixture.state.finished, false); release(); await assertion;
  assert.equal(fixture.state.uncertain, true); assert.equal(state.queries.length, 0); assert.equal(state.auditCalls, 0);
  checks.push("marketing:failed-count-awaits-all-started-reads");
}
{
  const fixture = reset(); let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.queries = [async () => { throw new Error("workspace connection query failed"); }, async () => { entered(); await held; return []; }, [], []];
  const assertion = assert.rejects(runAdminReadOperation("calendar-discovery", () => operations.listAdminCalendarConnections()), WriterAdmissionError);
  await started; assert.equal(fixture.state.finished, false); release(); await assertion;
  assert.equal(fixture.state.uncertain, true); assert.equal(state.queries.length, 0);
  checks.push("Calendar:failed-workspace-read-awaits-all-started-siblings");
}
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
for (const mode of ["owner", "employee"]) {
  const fixture = reset(); let release, entered;
  if (mode === "employee") {
    state.actor = {...actor,user:{...actor.user,role:"employee"}};
    state.queries = [[{id}], [{id}]];
  }
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  state.fetch = async (url, options) => {
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") {
      assert.equal(options.method, "POST");
      return json({ access_token: "owned-access", token_type: "Bearer", expires_in: 3600 });
    }
    assert.equal(url.origin, "https://www.googleapis.com"); assert.equal(url.pathname, "/calendar/v3/users/me/calendarList");
    if (url.searchParams.get("pageToken") === "owned-page-2") {
      entered(); await held; return json({ items: [{ id: "calendar-b", summary: "B", accessRole: "reader" }] });
    }
    return json({ items: [{ id: "primary", summary: "Alias" }, { id: "calendar-a", summary: "A", primary: true, accessRole: "writer" }], nextPageToken: "owned-page-2" });
  };
  const pending = mode === "owner" ? discovery.listConnectedGoogleCalendars(id) : employee.listEmployeeGoogleCalendars({connectionId:id,resourceId:id}); await started;
  assert.equal(fixture.state.finished, false); assert.equal(state.credentialReads, 1);
  release(); const result = await pending;
  assert.deepEqual(result.map(item => item.id), ["calendar-a", "calendar-b"]);
  assert.equal(state.requests.length, 3); assert.equal(state.requests[0].method, "POST");
  assert.deepEqual(fixture.events, ["admitted", "settled"]); assert.equal(fixture.state.uncertain, false);
  checks.push("Calendar:" + mode + ":actual-sdk-refresh-and-all-pages-before-settlement");
}
{
  const fixture = reset();
  state.fetch = async url => { assert.equal(url.origin, "https://oauth2.googleapis.com"); return new Response(JSON.stringify({error:"invalid_grant"}), {status:400,headers:{"content-type":"application/json"}}); };
  await assert.rejects(calendar.listConnectionGoogleCalendars(id), WriterAdmissionError);
  assert.equal(fixture.state.uncertain, true); assert.equal(state.credentialReads, 1); assert.ok(state.requests.length > 0);
  checks.push("Calendar:actual-sdk-refresh-failure-retains-uncertainty");
}
console.log(JSON.stringify({checks}));
`;

test("actual admin read exports fence SQL, audits, credential access and intercepted Google SDK continuation", () => {
  const result = execFileSync(process.execPath, [
    "--import", "./scripts/register-server-only-test.mjs", "--import", "tsx",
    "--input-type=module", "--eval", scenario,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000, env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "test", NODE_NO_WARNINGS: "1",
    FRONTEND_WRITER_ADMISSION_MODE: "off",
  } });
  const evidence = JSON.parse(result.trim());
  assert.equal(evidence.checks.length, 21);
});

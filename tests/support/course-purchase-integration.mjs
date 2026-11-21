import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createWriterAdmissionRunner } from "../../src/lib/writer-admission/runtime.ts";

const events = [];
let recoveryOpen = true;
let admitted = false;
const client = Object.assign(new EventEmitter(), {
  connection: { stream: { encrypted: true, authorized: true } },
  async connect() {},
  async end() {},
  async query(sql) {
    if (sql.startsWith("SELECT current_user"))
      return { rows: [{ username: "owned_runtime", database: "owned", major: 18 }] };
    if (sql.includes("current_policy"))
      return { rows: [{ epoch: "1", new_work: false, recovery: recoveryOpen }] };
    if (sql.includes("begin_operation")) { admitted = true; events.push("admitted"); }
    if (sql.includes("finish_operation")) { admitted = false; events.push("settled"); }
    return { rows: [] };
  },
});
const run = createWriterAdmissionRunner({
  getConfiguration: () => ({
    target: { environment: "staging", host: "owned.invalid", port: 5432, database: "owned",
      user: "owned_runtime", serverMajor: 18, targetSha256: "a".repeat(64) },
    sourceSha: "b".repeat(40), producerSha256: "c".repeat(64), connection: {},
  }),
  createClient: () => client,
  getInteractiveWriter: async () => null,
});
const orderId = "00000000-0000-4000-8000-000000000001";
const commandId = "course-revoke-" + orderId;
let retry = true;
let available = true;
let claims = 0;
let comparisons = 0;
let rows = [];
let lastComparison;
const state = globalThis.__p405 = {
  run,
  claim: async () => {
    assert.equal(admitted, true);
    claims++;
    if (!available) return;
    available = false;
    return {
      order: { id: orderId },
      job: { id: commandId, kind: "revoke", createdAt: new Date() },
    };
  },
  finish: async (job, result) => {
    assert.equal(job.id, commandId);
    state.results.push(result);
  },
  deliver: async (_order, job) => {
    assert.equal(job.id, commandId);
    if (retry) throw new Error("owned transport interruption");
    return { grantId: "owned-grant", status: "revoked" };
  },
  results: [],
  compare: async (input, signal) => {
    comparisons++;
    lastComparison = { input, signal };
    return { checkpoint: "owned-checkpoint", mismatches: [{
      orderId, expectedStatus: "active", actualStatus: "revoked", mismatchType: "admin_override",
    }] };
  },
  getDb: () => ({
    async transaction(work, options) {
      assert.deepEqual(options, { accessMode: "read only" });
      const tx = {
        async execute() { events.push("bounded-read"); },
        select() {
          const chain = new Proxy({}, {
            get(_target, property) {
              if (property === "then")
                return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
              if (property === "limit") return limit => {
                assert.equal(limit, 101);
                return chain;
              };
              return () => chain;
            },
          });
          return chain;
        },
      };
      return work(tx);
    },
  }),
};
const directory = mkdtempSync(join(tmpdir(), "p405-module-fixtures-"));
const stubs = new Map();
function stub(name, source) {
  const path = join(directory, name + ".cjs");
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}
stubs.set("@/lib/writer-admission/runtime", stub("admission",
  "exports.runWriterAdmission = (...args) => globalThis.__p405.run(...args);"));
stubs.set("@/lib/private-db/client", stub("database",
  "exports.getPrivateDb = () => globalThis.__p405.getDb();"));
const store = stub("store", [
  "exports.claimCourseJob = () => globalThis.__p405.claim();",
  "exports.finishCourseJob = (...args) => globalThis.__p405.finish(...args);",
  "exports.readCourseRefund = () => { throw Error('unexpected refund read'); };",
].join("\n"));
const api = stub("api", [
  "exports.deliverEntitlement = (...args) => globalThis.__p405.deliver(...args);",
  "exports.compareCourseEntitlements = (...args) => globalThis.__p405.compare(...args);",
  "exports.PurchaseDependencyError = class extends Error {};",
].join("\n"));
registerHooks({ resolve(specifier, context, next) {
  if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
  if (context.parentURL?.endsWith("/course-purchases/recovery.ts") && specifier === "./store")
    return { url: store, shortCircuit: true };
  if (context.parentURL?.includes("/course-purchases/") && specifier === "./course-api")
    return { url: api, shortCircuit: true };
  return next(specifier, context);
} });
try {
  process.env.INTEGRATION_ENTITLEMENT_RECOVERY_ENABLED = "true";
  process.env.INTEGRATION_CHECKOUT_ENABLED = "false";
  process.env.COURSE_PURCHASE_RECOVERY_SECRET = "owned-recovery-bearer-with-32-characters";
  const headers = { authorization: "Bearer " + process.env.COURSE_PURCHASE_RECOVERY_SECRET };
  const recovery = await import("../../src/app/api/internal/course-purchases/recover/route.ts");
  const request = () => new Request("https://owned.invalid/api/internal/course-purchases/recover", { method: "POST", headers });
  assert.equal((await recovery.POST(request())).status, 200);
  assert.deepEqual(state.results[0], { failure: "dependency_502", retry: true });
  available = true;
  retry = false;
  assert.equal((await recovery.POST(request())).status, 200);
  assert.deepEqual(state.results[1], { receipt: "owned-grant", access: "revoked" });
  assert.deepEqual(events, ["admitted", "settled", "admitted", "settled"]);
  const previousClaims = claims;
  recoveryOpen = false;
  assert.equal((await recovery.POST(request())).status, 503);
  assert.equal(claims, previousClaims);
  assert.equal((await recovery.POST(new Request(request().url, { method: "POST" }))).status, 401);

  rows = Array.from({ length: 101 }, (_, index) => ({
    orderId: index === 0 ? orderId : "00000000-0000-4000-8000-" + (index + 1).toString().padStart(12, "0"),
    userId: "owned-user", courseId: "owned-course", status: index === 1 ? "refunded" : "paid",
  }));
  const reconciliation = await import("../../src/lib/course-purchases/reconciliation.ts");
  const signal = new AbortController().signal;
  const report = await reconciliation.reconcileCoursePurchasePage(null, signal);
  assert.equal(report.checkedOrders, 100);
  assert.equal(report.nextCursor, rows[99].orderId);
  assert.equal(report.adminOverrideCount, 1);
  assert.equal(report.mismatches[0].mismatchType, "admin_override");
  assert.equal(lastComparison.signal, signal);
  assert.equal(lastComparison.input.grants[0].expectedStatus, "active");
  assert.equal(lastComparison.input.grants[1].expectedStatus, "revoked");
  assert.equal(rows[0].status, "paid");
  rows = [];
  const empty = await reconciliation.reconcileCoursePurchasePage(report.nextCursor);
  assert.equal(empty.nextCursor, null);
  assert.equal(comparisons, 1);
  console.log("Recovery retries, closed new sales, recovery denial, bounded read-only reconciliation and administrator override reporting passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

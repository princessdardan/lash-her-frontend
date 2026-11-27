import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { runFrontendWriterOperation } from "./frontend-admission.mjs";

const target = { environment: "staging", targetSha256: "a".repeat(64) };
const operation = () => ({ id: randomUUID(), epoch: "1", kind: "new-work", producerSha256: "b".repeat(64), sourceSha: "c".repeat(40) });
function fixture() {
  const calls = [];
  return { calls, async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; } };
}

test("operation completion waits for nested deferred work", async () => {
  const client = fixture(); let release, finished = false;
  const held = new Promise(resolve => { release = resolve; });
  const run = runFrontendWriterOperation(client, target, operation(), async ({ defer }) => {
    defer(async () => { await held; defer(async () => { finished = true; }); });
    return "response";
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.calls.length, 1);
  release(); assert.equal(await run, "response"); assert.equal(finished, true);
  assert.equal(client.calls.at(-1).values[1], "completed");
});

test("denied or uncertain admission never starts effects or retries", async () => {
  const client = fixture(); let effects = 0;
  client.query = async () => { client.calls.push("admit"); throw new Error("private-marker"); };
  await assert.rejects(runFrontendWriterOperation(client, target, operation(), () => { effects++; }), /^Error: FRONTEND_ADMISSION_REFUSED$/u);
  assert.equal(effects, 0); assert.equal(client.calls.length, 1);
});

test("an opted-in ordinary admission retries a PostgreSQL lock refusal before running effects once", async () => {
  const client = fixture(), query = client.query.bind(client);
  const input = operation();
  let effects = 0;
  client.query = async (sql, values) => {
    const result = await query(sql, values);
    if (client.calls.length <= 2) throw Object.assign(new Error("lock not available"), { code: "55P03" });
    return result;
  };
  await runFrontendWriterOperation(client, target, input, () => { effects++; }, { retryAdmissionLock: true });
  assert.equal(effects, 1);
  assert.deepEqual(client.calls.slice(0, 3), [client.calls[0], client.calls[0], client.calls[0]]);
  assert.deepEqual(client.calls[3].values, [input.id, "completed"]);
});

test("the admission retry is bounded and excludes the default, P4-07 and ambiguous outcomes", async () => {
  for (const [input, code, retryAdmissionLock, expectedCalls] of [
    [operation(), "55P03", true, 4],
    [operation(), "55P03", false, 1],
    [{ ...operation(), p407CourseOrderId: randomUUID() }, "55P03", true, 1],
    [operation(), "ECONNRESET", true, 1],
    [operation(), "P0001", true, 1],
  ]) {
    const client = fixture(), query = client.query.bind(client);
    client.query = async (sql, values) => {
      await query(sql, values);
      throw Object.assign(new Error("private-marker"), { code });
    };
    await assert.rejects(runFrontendWriterOperation(client, target, input, () => assert.fail("unexpected effect"),
      { retryAdmissionLock }), /^Error: FRONTEND_ADMISSION_REFUSED$/u);
    assert.equal(client.calls.length, expectedCalls);
    assert.ok(client.calls.every(({ sql }) => sql.includes("begin")));
  }
});

test("main and deferred failures persist uncertainty only after all deferred work finishes", async () => {
  for (const mainFailure of [false, true]) {
    const client = fixture(); let release;
    const held = new Promise(resolve => { release = resolve; });
    const run = runFrontendWriterOperation(client, target, operation(), ({ defer }) => {
      defer(async () => { await held; throw new Error("private-marker"); });
      if (mainFailure) throw new Error("private-marker");
    });
    const rejected = assert.rejects(run, /^Error: FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW$/u);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(client.calls.length, 1);
    release(); await rejected;
    assert.equal(client.calls.at(-1).values[1], "uncertain");
  }
});

test("a lost settlement response never retries work or settlement", async () => {
  for (const code of ["ECONNRESET", "55P03"]) {
    const client = fixture(), query = client.query.bind(client); let effects = 0;
    client.query = async (sql, values) => {
      await query(sql, values);
      if (sql.includes("finish_operation")) throw Object.assign(new Error("private-marker"), { code });
    };
    await assert.rejects(runFrontendWriterOperation(client, target, operation(), () => { effects++; },
      { retryAdmissionLock: true }), /^Error: FRONTEND_OPERATION_OUTCOME_REQUIRES_REVIEW$/u);
    assert.equal(effects, 1); assert.equal(client.calls.length, 2);
  }
});

test("late deferrals and malformed bindings refuse", async () => {
  let late;
  await runFrontendWriterOperation(fixture(), target, operation(), ({ defer }) => { late = defer; });
  assert.throws(() => late(() => {}), /FRONTEND_ADMISSION_REFUSED/u);
  const client = fixture();
  await assert.rejects(runFrontendWriterOperation(client, { ...target, environment: "preview" }, operation(), () => {}));
  await assert.rejects(runFrontendWriterOperation(client, target, { ...operation(), epoch: "0" }, () => {}));
  assert.equal(client.calls.length, 0);
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { retainDurableWork, verifyRecoveredWork } from "./host/staging_work.mjs";

function setup() {
  const now = new Date("2026-11-03T00:00:00Z");
  const fixture = { status: "STAGING_FIXTURE_TWO_GRANTS_CREATED", environment: "staging", syntheticIdentitiesOnly: true,
    coursePublished: false, actionId: "recovery-fixture-owned", courseId: randomUUID(), courseSlug: "p1-recovery-" + "1".repeat(32),
    grants: [0, 1].map(() => ({ userId: randomUUID(), grantId: randomUUID(), commandId: randomUUID() })) };
  const rows = fixture.grants.map((grant, index) => ({ eventId: randomUUID(), streamId: randomUUID(), streamVersion: 1,
    canonicalDigest: String(index + 1).repeat(64), userId: grant.userId, courseId: fixture.courseId,
    state: "pending", attemptsInCycle: 0, replayCycle: 0, availableAt: now.toISOString(),
    leaseOwner: null, leaseExpiresAt: null, deliveredAt: null }));
  const calls = [];
  const repository = {
    async inspectEventForOperator(input) { calls.push(["inspect", input]); return { ...rows.find(row => row.eventId === input.eventId) }; },
    async claimBatch(input) {
      calls.push(["claim", input]);
      const eligible = rows.filter(row => Date.parse(row.availableAt) <= input.now.getTime()
        && (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= input.now.getTime()));
      for (const row of eligible) { row.leaseOwner = input.workerId; row.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs); }
      return eligible.map(row => ({ ...row }));
    },
    async recordRetry(input) {
      calls.push(["retry", input]);
      const row = rows.find(row => row.eventId === input.eventId && row.leaseOwner === input.workerId);
      if (!row) return false;
      Object.assign(row, { attemptsInCycle: input.attemptsInCycle, availableAt: input.availableAt.toISOString(), leaseOwner: null, leaseExpiresAt: null });
      return true;
    },
  };
  const execute = (changes = {}) => retainDurableWork(fixture, { readPending: async () => rows.map(row => ({ ...row })), repository,
    now: () => new Date(now), ...changes });
  return { fixture, rows, now, repository, calls, execute };
}

test("retained work uses audited reads and the actual repository claim/retry interfaces", async () => {
  const owned = setup(), result = await owned.execute();
  assert.equal(result.status, "STAGING_DURABLE_WORK_RETAINED");
  assert.equal(result.events.length, 2); assert.equal(result.recovered, false); assert.equal(result.trafficAuthorized, false);
  assert.deepEqual(result.events.map(event => event.kind), ["expired-lease", "scheduled-retry"]);
  assert.deepEqual(result.events.map(event => event.attemptsInCycle), [0, 1]);
  assert.equal(owned.calls.filter(([operation]) => operation === "inspect").length, 4);
  assert.equal(owned.calls.filter(([operation]) => operation === "claim").length, 2);
  assert.equal(owned.calls.filter(([operation]) => operation === "retry").length, 1);
  assert.ok(owned.calls.filter(([operation]) => operation === "inspect").every(([, input]) => input.operatorId === "dardan"));
  assert.ok(!JSON.stringify(result).includes("leaseOwner"));
});

test("unrelated pending work, wrong stream/course, existing lease or previous retry refuses before writes", async () => {
  for (const mutate of [rows => rows.push({ ...rows[0], eventId: randomUUID() }), rows => { rows[0].courseId = randomUUID(); },
    rows => { rows[0].streamVersion = 2; }, rows => { rows[0].leaseOwner = "other"; }, rows => { rows[0].attemptsInCycle = 1; },
    rows => { rows[0].userId = randomUUID(); }, rows => { rows[0].state = "dead_letter"; }]) {
    const owned = setup(); mutate(owned.rows);
    await assert.rejects(owned.execute(), /ONLY_TWO_NEW_FIXTURE_EVENTS/u);
    assert.equal(owned.calls.length, 0);
  }
});

test("wrong audited identity and changed claim set cannot produce retained-work proof", async () => {
  let owned = setup();
  owned.repository.inspectEventForOperator = async () => ({ eventId: randomUUID() });
  await assert.rejects(owned.execute(), /AUDITED_ORIGINAL_STATE/u);
  assert.equal(owned.calls.length, 0);
  owned = setup();
  owned.repository.claimBatch = async () => [{ eventId: randomUUID() }, { eventId: randomUUID() }];
  await assert.rejects(owned.execute(), /EXACT_CLAIMS/u);
  assert.equal(owned.calls.filter(([operation]) => operation === "retry").length, 0);
});

test("failed retry, elapsed eligibility window or an early competing claim prevents success", async () => {
  let owned = setup(); owned.repository.recordRetry = async () => false;
  await assert.rejects(owned.execute(), /RETRY_RETAINED/u);
  owned = setup(); let clockCalls = 0;
  await assert.rejects(owned.execute({ now: () => new Date(owned.now.getTime() + (clockCalls++ ? 45_000 : 0)) }), /ELIGIBILITY_WINDOW/u);
  owned = setup(); const claim = owned.repository.claimBatch; let claims = 0;
  owned.repository.claimBatch = async input => claims++ === 0 ? claim(input) : [{ eventId: randomUUID() }];
  await assert.rejects(owned.execute(), /EARLY_COMPETING_CLAIM/u);
});

test("recovery requires exact actual source/receiver identities, digests and eligibility floors", async () => {
  const owned = setup(), retained = await owned.execute();
  const outbox = retained.events.map(event => ({ eventId: event.eventId, canonicalDigest: event.canonicalDigest,
    state: "delivered", leaseOwner: null, leaseExpiresAt: null, attemptsInCycle: event.attemptsInCycle,
    deliveredAt: new Date(Date.parse(event.notBefore) + 1).toISOString() }));
  const inbox = retained.events.map(event => ({ eventId: event.eventId, canonicalDigest: event.canonicalDigest, status: "applied" }));
  assert.equal(verifyRecoveredWork(retained, outbox, inbox).status, "STAGING_DURABLE_WORK_RECOVERED");
  for (const modify of [rows => { rows[0].canonicalDigest = "0".repeat(64); }, rows => { rows[0].leaseOwner = "still-held"; },
    rows => { rows[0].deliveredAt = new Date(Date.parse(retained.events[0].notBefore) - 1).toISOString(); },
    rows => { rows[1].attemptsInCycle = 0; }]) {
    const changed = structuredClone(outbox); modify(changed);
    assert.throws(() => verifyRecoveredWork(retained, changed, inbox), /ACTUAL_PUBLICATION/u);
  }
  assert.throws(() => verifyRecoveredWork(retained, outbox, [{ ...inbox[0], status: "superseded" }, inbox[1]]), /ACTUAL_PUBLICATION/u);
  assert.throws(() => verifyRecoveredWork(retained, outbox, [inbox[0], inbox[0]]), /EXACT_RECOVERY_ROWS/u);
});

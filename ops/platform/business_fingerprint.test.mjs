import assert from "node:assert/strict";
import test from "node:test";
import { businessFingerprint, businessQueries, verifyBusinessPreserved } from "./host/business_fingerprint.mjs";

const key = "1".repeat(64);
const rows = () => ({ users: [{ id: "owned-user" }], courses: [{ id: "owned-course", slug: "owned-slug", status: "draft" }],
  enrollments: [{ id: "owned-enrollment", user_id: "owned-user" }], grants: [{ id: "owned-grant", privateReason: "must-not-export", createdAt: new Date("2026-11-03T00:00:00Z") }],
  commands: [{ id: "owned-command", actor_user_id: "private-actor", reason: "private-audit-reason" }],
  effects: [{ id: "owned-effect", command_id: "owned-command", resulting_status: "active" }],
  idempotency: [{ idempotency_key: "private-idempotency-key", request_hash: "private-request-hash" }] });

test("business evidence exports private-key HMACs and counts without rows, identities or reasons", () => {
  const result = businessFingerprint("course", rows(), key), serialized = JSON.stringify(result);
  assert.equal(result.status, "STAGING_BUSINESS_FINGERPRINT_READ_ONLY");
  assert.equal(result.tables.users.count, 1);
  for (const value of ["owned-user", "owned-course", "must-not-export", "private-actor", "private-audit-reason", "private-idempotency-key", "private-request-hash", key]) assert.ok(!serialized.includes(value));
  assert.equal(result.rawRowsExported, false); assert.equal(result.privateKeyExported, false);
});

test("canonical key order and PostgreSQL Date serialization produce stable evidence", () => {
  const before = rows(), after = structuredClone(before);
  after.courses[0] = { status: "draft", slug: "owned-slug", id: "owned-course" };
  after.grants[0].createdAt = after.grants[0].createdAt.toISOString();
  assert.deepEqual(businessFingerprint("course", before, key), businessFingerprint("course", after, key));
});

test("new rows are allowed but changed or removed baseline rows and changed keys refuse", () => {
  const before = businessFingerprint("course", rows(), key), added = rows(); added.users.push({ id: "new-owned-user" });
  assert.equal(verifyBusinessPreserved(before, businessFingerprint("course", added, key)).preservedRows, 7);
  for (const mutate of [value => { value.courses[0].status = "published"; }, value => { value.users = []; },
    value => { value.commands[0].reason = "changed-audit-reason"; }, value => { value.effects = []; },
    value => { value.idempotency[0].request_hash = "changed-hash"; }]) {
    const changed = rows(); mutate(changed);
    assert.throws(() => verifyBusinessPreserved(before, businessFingerprint("course", changed, key)), /BUSINESS_ROWS_CHANGED/u);
  }
  assert.throws(() => verifyBusinessPreserved(before, businessFingerprint("course", rows(), "2".repeat(64))), /BUSINESS_ROWS_CHANGED/u);
});

test("table scope, unique primary keys and bounded row counts cannot be weakened", () => {
  assert.throws(() => businessFingerprint("course", { ...rows(), other: [] }, key), /BOUND_INPUT/u);
  const duplicate = rows(); duplicate.users.push({ id: "owned-user" });
  assert.throws(() => businessFingerprint("course", duplicate, key), /UNIQUE_ROWS/u);
  const tooMany = rows(); tooMany.users = Array.from({ length: 2001 }, (_, index) => ({ id: String(index) }));
  assert.throws(() => businessFingerprint("course", tooMany, key), /ROW_BOUND/u);
  assert.ok(Object.values(businessQueries).every(queries => Object.values(queries).every(query => /^SELECT .+ LIMIT 2001$/u.test(query))));
});

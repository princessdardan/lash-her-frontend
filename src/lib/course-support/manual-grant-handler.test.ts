import assert from "node:assert/strict";
import test from "node:test";
import { actor, body, fixture, otherId, userId } from "../../../tests/course-support/manual-grant-fixture";

test("owner grant uses one semantic admission, canonical support client, immutable audit and orderless readback", async () => {
  const { state, call } = fixture(); const input = body(); const response = await call(input); const receipt = await response.json();
  assert.equal(response.status, 200); assert.equal(receipt.state, "confirmed"); assert.equal(receipt.command.userId, userId); assert.equal(receipt.communityDeliveryVerified, false);
  assert.deepEqual([receipt.grant.orderId, receipt.grant.externalPaymentId, receipt.grant.provider], [null, null, null]);
  assert.equal(state.post, 1); assert.equal(state.admissions, 1); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await call(input)).status, 200); assert.equal((await call(input, "GET")).status, 200); assert.equal(state.post, 1, "even explicit repeated POST reads the known command rather than replaying it");
  assert.equal((await call({ ...input, userId: otherId })).status, 409); assert.equal(state.post, 1);
});
test("CSRF/origin/content/extra fields refuse before auth or outbound work", async () => {
  for (const headers of [{ origin: "https://foreign.invalid" }, { "x-lash-csrf": "" }, { "sec-fetch-site": "cross-site" }]) {
    const { state, call } = fixture(); assert.equal((await call(body(), "POST", headers)).status, 403); assert.equal(state.calls, 0); assert.equal(state.admissions, 0);
  }
  const { state, call } = fixture(); assert.equal((await call({ ...body(), orderId: "invented" } as never)).status, 400); assert.equal(state.calls, 0);
});
test("staff or customer cannot grant another customer's access", async () => {
  const { state, call } = fixture(); state.actor = { ...actor, user: { ...actor.user, role: "admin" } };
  assert.equal((await call(body())).status, 403); assert.equal((await call(body(), "GET")).status, 403); assert.equal(state.calls, 0);
});
test("free, unpublished, archived, stale, nonexistent/inactive customer never invokes grant POST", async () => {
  for (const change of [{ accessMode: "free" }, { status: "draft" }, { status: "archived" }, { revision: 4 }]) {
    const { state, call } = fixture(); state.course = { ...state.course, ...change };
    assert.equal((await call(body())).status, 409); assert.equal(state.post, 0);
  }
  const { state, call } = fixture(); state.activeCustomer = false; assert.equal((await call(body())).status, 400); assert.equal(state.post, 0);
});
test("lost ACK is never retried; explicit GET recovers actual command and effects", async () => {
  const { state, call } = fixture(); const input = body(); state.lostAck = true;
  assert.equal((await call(input)).status, 503); assert.equal(state.post, 1);
  state.lostAck = false; const result = await call(input, "GET"); assert.equal(result.status, 200); assert.equal((await result.json()).command.commandId, state.commands[0].commandId); assert.equal(state.post, 1);
});
test("accepted course race preserves actual receipt, including after changed-course reconciliation", async () => {
  const { state, call } = fixture(); state.race = true; const input = body();
  const response = await call(input); assert.equal(response.status, 202); const value = await response.json(); assert.equal(value.state, "accepted-needs-review"); assert.equal(value.command.commandId, state.commands[0].commandId);
  assert.equal((await call(input, "GET")).status, 202); assert.equal(state.post, 1);
});
test("post-accept readback failure or mismatched audit poisons admission and retains receiver command", async () => {
  for (const flag of ["failReadback", "tamperAudit"] as const) {
    const { state, call } = fixture(); state[flag] = true; const response = await call(body());
    assert.equal(response.status, 202); assert.equal((await response.json()).command.commandId, state.commands[0].commandId); assert.equal(state.post, 1);
  }
});
test("GET absence is explicitly not observed, not cancellation or retry authority", async () => {
  const { state, call } = fixture(); const response = await call(body(), "GET"); assert.equal(response.status, 202); assert.equal((await response.json()).state, "not-observed"); assert.equal(state.post, 0);
});

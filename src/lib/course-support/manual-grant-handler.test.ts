import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createManualCourseGrantHandler } from "./manual-grant-handler";
import { createCourseClient } from "@/lib/api-integration/course-client";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import type { AdminActor } from "@/lib/admin/types";

const origin = "https://owner.example.invalid";
const courseId = randomUUID(), userId = randomUUID(), adminId = randomUUID(), otherId = randomUUID();
const actor: AdminActor = { bookingProviderResourceIds: [], bookingResourceIds: [], user: { id: adminId, email: "owner@example.invalid", emailNormalized: "owner@example.invalid", displayName: null, providerUserId: "fixture", role: "owner", status: "active" } };
const initial = { id: courseId, title: "Paid course", slug: "paid-course", description: null, status: "published", accessMode: "paid", priceCents: 100, currency: "CAD", revision: 3, modules: [], introduction: null, cover: null, seo: null, taxClassification: "reviewed" };
const body = () => ({ userId, reason: "Owner support", expectedCourseRevision: 3, idempotencyKey: randomUUID() });
function fixture() {
  const state = { actor, course: { ...initial }, post: 0, calls: 0, admissions: 0, inside: false, activeCustomer: true, lostAck: false, failReadback: false,
    race: false, tamperAudit: false, commands: [] as Array<Record<string, unknown>>, grants: [] as Array<Record<string, unknown>> };
  const run = async <T>(_kind: "new-work" | "recovery", work: () => Promise<T>) => {
    assert.equal(state.inside, false); state.inside = true; state.admissions++;
    try { return await withWriterOperationContext(work); } finally { state.inside = false; }
  };
  const authorize = async () => {
    assert.equal(state.inside, true);
    if (state.actor.user.role !== "owner") throw new IntegrationServiceError("forbidden", 403);
    return state.actor;
  };
  const client = createCourseClient({ enabled: () => true, run, getAdmin: authorize, mintToken: principal => {
    assert.equal(principal.profile, "course-admin"); assert.ok("capabilities" in principal && principal.capabilities.includes("course-support")); return "canonical-owned-admin-token";
  }, getTransport: () => async request => {
    assert.equal(state.inside, true); assert.equal(request.applicationToken, "canonical-owned-admin-token"); state.calls++;
    const url = new URL(request.path, origin);
    if (url.pathname === `/v1/admin/courses/${courseId}`) return Response.json({ course: state.course });
    if (url.pathname === "/v1/admin/entitlements/commands") {
      if (state.failReadback && state.post) throw new Error("owned readback failure");
      const commands = state.commands.filter(row => row.idempotencyKey === url.searchParams.get("idempotencyKey"));
      return Response.json({ commands: state.tamperAudit ? commands.map(row => ({ ...row, affectedGrantCount: 0 })) : commands, nextCursor: null });
    }
    if (url.pathname === "/v1/admin/entitlements/grants" && request.method === "GET") return Response.json({ grants: state.grants, nextCursor: null, emailLookup: { source: "local_users_projection", complete: false } });
    assert.equal(request.method, "POST"); assert.equal(url.pathname, "/v1/admin/entitlements/grants");
    const input = JSON.parse(request.body!); assert.equal(request.idempotencyKey, input.idempotencyKey); assert.deepEqual(Object.keys(input).sort(), ["courseId", "idempotencyKey", "reason", "userId"]);
    state.post++;
    const grantId = randomUUID(), now = new Date().toISOString();
    const command = { commandId: randomUUID(), action: "grant", scope: "userCourse", outcome: "applied", actorUserId: adminId, userId: input.userId,
      courseId, targetGrantId: null, reason: input.reason, effectiveAt: now, affectedGrantCount: 1,
      effects: [{ grantId, effectType: "grant_created", previousStatus: null, resultingStatus: "active" }] };
    state.commands.push({ ...command, createdAt: now, idempotencyKey: input.idempotencyKey });
    state.grants.push({ grantId, enrollmentId: randomUUID(), userId: input.userId, userEmail: null, courseId, courseTitle: "Paid course", courseSlug: "paid-course", orderId: null,
      externalPaymentId: null, provider: null, idempotencyKey: input.idempotencyKey, grantReason: "manual", revokeReason: null, grantedAt: now,
      revokedAt: null, expiresAt: null, status: "active", revokeIdempotencyKey: null, createdAt: now, updatedAt: now });
    if (state.race) state.course = { ...state.course, status: "archived", revision: 4 };
    if (state.lostAck) throw new Error("owned lost ACK");
    return Response.json(command, { status: 201 });
  } });
  const handler = createManualCourseGrantHandler({ enabled: () => true, origin: () => origin, run, authorize,
    activeCustomer: async () => { assert.equal(state.inside, true); return state.activeCustomer; }, client: () => client });
  const call = (input: ReturnType<typeof body>, method = "POST", headers = {}) => handler(new Request(`${origin}/api/admin/courses/${courseId}/manual-grants${method === "GET" ? `?idempotencyKey=${input.idempotencyKey}` : ""}`, {
    method, headers: { origin, "content-type": "application/json", "x-lash-csrf": "1", ...headers }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  }), courseId);
  return { state, call };
}
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

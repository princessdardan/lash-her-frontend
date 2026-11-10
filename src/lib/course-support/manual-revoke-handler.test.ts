import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCourseClient } from "@/lib/api-integration/course-client";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import type { PaidRevokeSelection } from "@/lib/writer-admission/interactive-proof";
import { actor, courseId, origin, otherId, userId } from "../../../tests/course-support/manual-grant-fixture";
import { createManualCourseRevokeHandler } from "./manual-revoke-handler";

const now = "2026-11-06T14:00:00.000Z";

function fixture() {
  const grantId = randomUUID(), originalKey = `owner-paid:${randomUUID()}`, idempotencyKey = randomUUID();
  const input = { grantId, userId, expectedCourseRevision: 3, reason: "  Review complete  ", idempotencyKey };
  const course = { id: courseId, title: "Paid course", slug: "paid-course", description: null, status: "published", accessMode: "paid",
    priceCents: 100, currency: "CAD", revision: 3, modules: [], introduction: null, cover: null, seo: null, taxClassification: "reviewed" };
  const grant = { grantId, enrollmentId: randomUUID(), userId, userEmail: null, courseId, courseTitle: course.title, courseSlug: course.slug,
    orderId: null as string | null, externalPaymentId: null as string | null, provider: null as string | null, idempotencyKey: originalKey,
    grantReason: "manual", revokeReason: null as string | null, grantedAt: now, revokedAt: null as string | null, expiresAt: null,
    status: "active", revokeIdempotencyKey: null, createdAt: now, updatedAt: now };
  const state = { course, grant, actor, selection: undefined as PaidRevokeSelection | undefined, lostAck: false, auditMismatch: false,
    grantMismatch: false, duplicateGrant: false, posts: 0, admissions: 0, uncertain: 0, paths: [] as string[], readId: randomUUID(), postId: randomUUID(),
    command: undefined as Record<string, unknown> | undefined };
  const run = async <T>(_kind: "new-work" | "recovery", work: () => Promise<T>) => {
    state.admissions++;
    try { return await withWriterOperationContext(work); }
    catch (error) { if (error instanceof Error && error.message === "WRITER_OPERATION_REQUIRES_REVIEW") state.uncertain++; throw error; }
  };
  const getAdmin = async () => state.actor;
  const handler = createManualCourseRevokeHandler({ origin: () => origin, enabled: () => true, run, authorize: getAdmin,
    getPaidRevokeSelection: async () => state.selection, client: onResponse => createCourseClient({ enabled: () => true, run, getAdmin, onResponse,
      mintToken: principal => {
        assert.equal(principal.profile, "course-admin");
        assert.ok("capabilities" in principal && principal.capabilities.includes("course-support"));
        return "owner.jwt";
      }, getTransport: () => async request => {
        assert.equal(request.applicationToken, "owner.jwt");
        state.paths.push(request.path);
        const path = new URL(request.path, origin).pathname;
        const headers = { "x-request-id": request.method === "POST" ? state.postId : state.readId };
        if (path === `/v1/admin/courses/${courseId}`) return Response.json({ course: state.course }, { headers });
        if (path === "/v1/admin/entitlements/commands") {
          const record = state.command;
          const commands = record ? [{ ...record, commandId: state.auditMismatch ? otherId : record.commandId,
            idempotencyKey: `owner-paid-revoke:${idempotencyKey}`, createdAt: now }] : [];
          return Response.json({ commands, nextCursor: null }, { headers });
        }
        if (path === "/v1/admin/entitlements/grants") {
          const record = state.grantMismatch && state.posts ? { ...state.grant, revokedAt: null } : state.grant;
          return Response.json({ grants: state.duplicateGrant ? [record, record] : [record], nextCursor: null,
            emailLookup: { source: "local_users_projection", complete: false } }, { headers });
        }
        assert.equal(path, "/v1/admin/entitlements/revocations");
        assert.equal(request.method, "POST");
        const key = `owner-paid-revoke:${idempotencyKey}`;
        const reason = "[paid-course revision 3] Review complete";
        assert.equal(request.body, JSON.stringify({ scope: "grantId", grantId, reason, idempotencyKey: key }));
        assert.equal(request.idempotencyKey, key);
        state.posts++;
        state.command = { commandId: randomUUID(), action: "revoke", scope: "grantId", outcome: "applied", actorUserId: actor.user.id,
          userId, courseId, targetGrantId: grantId, reason, effectiveAt: now, affectedGrantCount: 1,
          effects: [{ grantId, effectType: "grant_revoked", previousStatus: "active", resultingStatus: "revoked" }] };
        state.grant = { ...state.grant, status: "revoked", revokeReason: "manual", revokedAt: now };
        if (state.lostAck) throw new Error("owned missing acknowledgement");
        return Response.json(state.command, { headers });
      } }) });
  const call = (body: unknown = input, method = "POST", headers = {}) => handler(new Request(
    `${origin}/api/admin/courses/${courseId}/manual-grants/revoke${method === "GET" ? `?idempotencyKey=${idempotencyKey}` : ""}`,
    { method, headers: { origin, "content-type": "application/json", "x-lash-csrf": "1", ...headers },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}) }), courseId);
  return { state, call, input };
}

test("scoped manual revocation verifies only the selected grant, exact audit and original POST correlation", async () => {
  const { state, call, input } = fixture();
  state.selection = { actorId: actor.user.id, idempotencyKey: input.idempotencyKey };
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), state.postId);
  assert.notEqual(response.headers.get("x-request-id"), state.readId);
  assert.deepEqual(await response.json(), { state: "confirmed", idempotencyKey: input.idempotencyKey, command: { commandId: state.command?.commandId },
    grant: { grantId: input.grantId, userId, courseId, status: "revoked", orderId: null, externalPaymentId: null, provider: null },
    courseRevision: 3, mutationRetried: false, communityDeliveryVerified: false });
  const commands = `/v1/admin/entitlements/commands?idempotencyKey=owner-paid-revoke%3A${input.idempotencyKey}&limit=2`;
  const course = `/v1/admin/courses/${courseId}`;
  const grants = `/v1/admin/entitlements/grants?grantId=${input.grantId}&userId=${userId}&courseId=${courseId}&limit=2`;
  assert.deepEqual(state.paths, [commands, course, grants, "/v1/admin/entitlements/revocations", commands, grants, course]);
  assert.equal(state.admissions, 1);
  assert.equal((await call()).status, 409);
  assert.equal(state.posts, 1);
});

test("manual revocation rejects foreign requests, unexpected input, mismatched scope and an unreviewed actor", async () => {
  const { state, call, input } = fixture();
  state.selection = { actorId: actor.user.id, idempotencyKey: input.idempotencyKey };
  assert.equal((await call(input, "POST", { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await call(input, "GET", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await call(input, "GET")).status, 400);
  for (const body of [{ ...input, scope: "userCourse" }, { ...input, grantId: otherId.toUpperCase() }, { ...input, idempotencyKey: otherId },
    { ...input, expectedCourseRevision: 0 }, { ...input, expectedCourseRevision: 2_147_483_648 }, { ...input, reason: " " }]) {
    assert.equal((await call(body)).status, 400);
  }
  assert.equal(state.admissions, 0);
  state.actor = { ...actor, user: { ...actor.user, id: otherId } };
  assert.equal((await call()).status, 403);
  assert.deepEqual(state.paths, []);
});

test("manual revocation refuses ineligible source grants and permits archived courses only outside scoped certification", async () => {
  for (const change of [{ idempotencyKey: "different-source" }, { orderId: otherId }, { status: "expired" }, { userId: otherId }]) {
    const { state, call } = fixture();
    state.grant = { ...state.grant, ...change };
    assert.equal((await call()).status, 409);
    assert.equal(state.posts, 0);
  }
  const { state, call, input } = fixture();
  state.course.status = "archived";
  state.selection = { actorId: actor.user.id, idempotencyKey: input.idempotencyKey };
  assert.equal((await call()).status, 409);
  state.selection = undefined;
  assert.equal((await call()).status, 200);
  assert.equal(state.posts, 1);
});

test("manual revocation retains an ambiguous effect and reconciliation never posts again", async () => {
  for (const ambiguity of ["lostAck", "auditMismatch", "grantMismatch"] as const) {
    const { state, call, input } = fixture();
    state[ambiguity] = true;
    const initial = await call();
    assert.equal(initial.status, 202);
    const pending = await initial.json();
    assert.equal(pending.state, ambiguity === "lostAck" ? "outcome-unknown" : "accepted-needs-review");
    assert.deepEqual(pending.grant, { grantId: input.grantId, userId, courseId });
    assert.equal(pending.command?.commandId, ambiguity === "lostAck" ? undefined : state.command?.commandId);
    assert.equal(state.uncertain, 1);
    state[ambiguity] = false;
    const reconciled = await call(input, "GET");
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.headers.get("x-request-id"), null);
    assert.equal((await reconciled.json()).command.commandId, state.command?.commandId);
    assert.equal((await call()).status, 200);
    assert.equal(state.posts, 1);
  }
  const { state, call, input } = fixture();
  const missing = await call(input, "GET");
  assert.equal(missing.status, 202);
  assert.equal((await missing.json()).state, "not-observed");
  assert.equal(state.posts, 0);
});

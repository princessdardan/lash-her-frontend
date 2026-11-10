import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createManualCourseGrantHandler } from "@/lib/course-support/manual-grant-handler";
import { createCourseClient } from "@/lib/api-integration/course-client";
import { IntegrationServiceError } from "@/lib/api-integration/service-errors";
import { withWriterOperationContext } from "@/lib/writer-admission/context";
import type { PaidGrantSelection } from "@/lib/writer-admission/interactive-proof";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import type { AdminActor } from "@/lib/admin/types";

export const origin = "https://owner.example.invalid";
export const courseId = randomUUID(), userId = randomUUID(), adminId = randomUUID(), otherId = randomUUID();
export const actor: AdminActor = { bookingProviderResourceIds: [], bookingResourceIds: [], user: { id: adminId, email: "owner@example.invalid", emailNormalized: "owner@example.invalid", displayName: null, providerUserId: "fixture", role: "owner", status: "active" } };
const initial = { id: courseId, title: "Paid course", slug: "paid-course", description: null, status: "published", accessMode: "paid", priceCents: 100, currency: "CAD", revision: 3, modules: [], introduction: null, cover: null, seo: null, taxClassification: "reviewed" };
export const body = () => ({ userId, reason: "Owner support", expectedCourseRevision: 3, idempotencyKey: randomUUID() });
export function fixture(admissionRun?: WriterAdmissionRunner) {
  const state = { actor, course: { ...initial }, post: 0, calls: 0, admissions: 0, inside: false, activeCustomer: true, lostAck: false, failReadback: false,
    race: false, tamperAudit: false, tamperCommandId: false, duplicateAudit: false, selectedPaidGrant: undefined as PaidGrantSelection | undefined,
    paths: [] as string[], postRequestId: randomUUID(), readRequestId: randomUUID(), postReceiptOverride: {} as Record<string, unknown>,
    commands: [] as Array<Record<string, unknown>>, grants: [] as Array<Record<string, unknown>> };
  const run = async <T>(_kind: "new-work" | "recovery", work: () => Promise<T>) => {
    assert.equal(state.inside, false); state.inside = true; state.admissions++;
    try { return await (admissionRun ? admissionRun(_kind, work) : withWriterOperationContext(work)); } finally { state.inside = false; }
  };
  const authorize = async () => {
    assert.equal(state.inside, true);
    if (state.actor.user.role !== "owner") throw new IntegrationServiceError("forbidden", 403);
    return state.actor;
  };
  const client = (onResponse: (requestId: string) => void) => createCourseClient({ enabled: () => true, run, getAdmin: authorize, onResponse, mintToken: principal => {
    assert.equal(principal.profile, "course-admin"); assert.ok("capabilities" in principal && principal.capabilities.includes("course-support")); return "canonical-owned-admin-token";
  }, getTransport: () => async request => {
    assert.equal(state.inside, true); assert.equal(request.applicationToken, "canonical-owned-admin-token"); state.calls++;
    state.paths.push(request.path);
    const url = new URL(request.path, origin);
    const headers = { "x-request-id": request.method === "POST" ? state.postRequestId : state.readRequestId };
    if (url.pathname === `/v1/admin/courses/${courseId}`) return Response.json({ course: state.course }, { headers });
    if (url.pathname === "/v1/admin/entitlements/commands") {
      if (state.failReadback && state.post) throw new Error("owned readback failure");
      let commands = state.commands.filter(row => row.idempotencyKey === url.searchParams.get("idempotencyKey"));
      if (state.tamperAudit) commands = commands.map(row => ({ ...row, affectedGrantCount: 0 }));
      if (state.tamperCommandId) commands = commands.map(row => ({ ...row, commandId: otherId }));
      if (state.duplicateAudit) commands = [...commands, ...commands];
      return Response.json({ commands, nextCursor: null }, { headers });
    }
    if (url.pathname === "/v1/admin/entitlements/grants" && request.method === "GET") return Response.json({ grants: state.grants, nextCursor: null, emailLookup: { source: "local_users_projection", complete: false } }, { headers });
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
    return Response.json({ ...command, ...state.postReceiptOverride }, { status: 201, headers });
  } });
  const handler = createManualCourseGrantHandler({ enabled: () => true, origin: () => origin, run, authorize,
    activeCustomer: async () => { assert.equal(state.inside, true); return state.activeCustomer; }, client,
    getPaidGrantSelection: async () => state.selectedPaidGrant });
  const call = (input: ReturnType<typeof body>, method = "POST", headers = {}) => handler(new Request(`${origin}/api/admin/courses/${courseId}/manual-grants${method === "GET" ? `?idempotencyKey=${input.idempotencyKey}` : ""}`, {
    method, headers: { origin, "content-type": "application/json", "x-lash-csrf": "1", ...headers }, ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
  }), courseId);
  return { state, call };
}

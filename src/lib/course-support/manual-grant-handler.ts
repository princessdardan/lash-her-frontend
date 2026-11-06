import "server-only";

import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { getCourseClient } from "@/lib/api-integration/course-client";
import { runCourseAdminOperation } from "@/lib/api-integration/course-admin-operation";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError, integrationErrorResponse } from "@/lib/api-integration/service-errors";
import { customerUsers } from "@/lib/customer-auth/schema";
import { getPrivateDb } from "@/lib/private-db/client";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
type Client = ReturnType<typeof getCourseClient>;
type Input = { userId: string; expectedCourseRevision: number; reason: string; idempotencyKey: string };
type Command = Awaited<ReturnType<Client["grantAccess"]>>;
const fail = (code: "invalid_request" | "forbidden" | "conflict", status: number): never => { throw new IntegrationServiceError(code, status); };
const key = (value: string) => `owner-paid:${value}`;
const reason = (revision: number, value: string) => `[paid-course revision ${revision}] ${value}`;
function input(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "expectedCourseRevision,idempotencyKey,reason,userId") return fail("invalid_request", 400);
  const row = value as Input;
  if (!uuid.test(row.userId ?? "") || !uuid.test(row.idempotencyKey ?? "") || !Number.isSafeInteger(row.expectedCourseRevision) || row.expectedCourseRevision < 1 ||
    typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 1800) return fail("invalid_request", 400);
  return { ...row, reason: row.reason.trim() };
}
async function activeCustomer(userId: string) {
  const [user] = await getPrivateDb().select({ id: customerUsers.id, status: customerUsers.status }).from(customerUsers).where(eq(customerUsers.id, userId)).limit(1);
  return user?.status === "active";
}
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export function createManualCourseGrantHandler(dependencies: {
  client?: () => Client; authorize?: typeof requirePermission; activeCustomer?: typeof activeCustomer;
  run?: WriterAdmissionRunner; origin?: () => string | undefined; enabled?: () => boolean;
} = {}) {
  return async (request: Request, courseId: string): Promise<Response> => {
    let retained: Command | undefined;
    let retainedAttempt: string | undefined;
    try {
      if (!(dependencies.enabled ?? (() => isIntegrationFeatureEnabled("courseReads")))()) throw new IntegrationServiceError("feature_disabled", 404);
      if (!uuid.test(courseId)) return fail("invalid_request", 400);
      if (!["GET", "POST"].includes(request.method)) throw new IntegrationServiceError("invalid_request", 405);
      const query = new URL(request.url).searchParams;
      let submitted: Input | undefined;
      let attempt: string;
      if (request.method === "POST") {
        if (query.size) return fail("invalid_request", 400);
        submitted = input(await readSameOriginJson(request, dependencies.origin?.() ?? process.env.AUTH_URL, 8192));
        attempt = submitted.idempotencyKey;
      } else {
        if (query.size !== 1 || !uuid.test(query.get("idempotencyKey") ?? "")) return fail("invalid_request", 400);
        attempt = query.get("idempotencyKey")!;
      }
      retainedAttempt = attempt;
      return await runCourseAdminOperation(async () => {
        try {
          const actor = await (dependencies.authorize ?? requirePermission)("courses:support");
          if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode) return fail("forbidden", 403);
          const client = (dependencies.client ?? getCourseClient)();
          const known = await client.listEntitlementCommands({ idempotencyKey: key(attempt), limit: 2 });
          if (known.nextCursor || known.commands.length > 1) return fail("conflict", 409);
          let command: Command | undefined = known.commands[0];
          if (command && (command.courseId !== courseId || command.actorUserId !== actor.user.id || command.action !== "grant" || command.scope !== "userCourse" ||
            !/^\[paid-course revision [1-9][0-9]*\] /u.test(command.reason) || submitted && (command.userId !== submitted.userId || command.reason !== reason(submitted.expectedCourseRevision, submitted.reason)))) return fail("conflict", 409);
          if (!command && !submitted) return Response.json({ state: "not-observed", idempotencyKey: attempt, mutationRetried: false }, { status: 202, headers });
          let accepted = false;
          try {
            if (!command) {
              const selected = submitted!;
              const before = (await client.getAdminCourse(courseId)).course;
              if (before.id !== courseId || before.status !== "published" || before.accessMode !== "paid" || before.currency !== "CAD" || before.priceCents <= 0 || before.revision !== selected.expectedCourseRevision) return fail("conflict", 409);
              if (!(await (dependencies.activeCustomer ?? activeCustomer)(selected.userId))) return fail("invalid_request", 400);
              const actual = await client.grantAccess({ userId: selected.userId, courseId, reason: reason(selected.expectedCourseRevision, selected.reason), idempotencyKey: key(attempt) });
              // The receiver retains the immutable command and its effects even
              // if a later read fails. Never hide or automatically undo it.
              accepted = true;
              command = actual;
              if (actual.action !== "grant" || actual.scope !== "userCourse" || actual.courseId !== courseId || actual.userId !== selected.userId || actual.actorUserId !== actor.user.id || actual.reason !== reason(selected.expectedCourseRevision, selected.reason)) throw new Error("GRANT_RECEIPT_MISMATCH");
            }
            retained = command;
            const saved = await client.listEntitlementCommands({ commandId: command.commandId, idempotencyKey: key(attempt), limit: 2 });
            if (saved.nextCursor || saved.commands.length !== 1 || saved.commands[0].commandId !== command.commandId || saved.commands[0].courseId !== courseId || saved.commands[0].userId !== command.userId || saved.commands[0].actorUserId !== actor.user.id || saved.commands[0].reason !== command.reason || saved.commands[0].action !== "grant" || saved.commands[0].scope !== command.scope || saved.commands[0].outcome !== command.outcome || saved.commands[0].affectedGrantCount !== command.affectedGrantCount || !isDeepStrictEqual(saved.commands[0].effects, command.effects)) throw new Error("GRANT_AUDIT_READBACK_MISMATCH");
            command = saved.commands[0];
            retained = command;
            const grants = await client.listGrants({ userId: command.userId, courseId, idempotencyKey: key(attempt), limit: 2 });
            const after = (await client.getAdminCourse(courseId)).course;
            const revision = Number(/^\[paid-course revision ([1-9][0-9]*)\] /u.exec(command.reason)![1]);
            const grant = grants.grants[0];
            const customerActive = await (dependencies.activeCustomer ?? activeCustomer)(command.userId);
            const confirmed = customerActive && command.outcome === "applied" && command.targetGrantId === null && !grants.nextCursor && grants.grants.length === 1 && command.effects.length === 1 &&
              grant.grantId === command.effects[0].grantId && grant.userId === command.userId && grant.courseId === courseId && grant.idempotencyKey === key(attempt) &&
              command.affectedGrantCount === 1 && command.effects[0].effectType === "grant_created" && command.effects[0].previousStatus === null && command.effects[0].resultingStatus === "active" && grant.grantReason === "manual" && grant.orderId === null && grant.externalPaymentId === null && grant.provider === null && grant.status === "active" &&
              after.id === courseId && after.status === "published" && after.accessMode === "paid" && after.currency === "CAD" && after.priceCents > 0 && after.revision === revision;
            return Response.json({ state: confirmed ? "confirmed" : "accepted-needs-review", idempotencyKey: attempt, command,
              grant: grant ? { grantId: grant.grantId, userId: grant.userId, courseId: grant.courseId, status: grant.status, grantReason: grant.grantReason,
                orderId: grant.orderId, externalPaymentId: grant.externalPaymentId, provider: grant.provider } : null,
              courseRevision: after.revision, mutationRetried: false, communityDeliveryVerified: false }, { status: confirmed ? 200 : 202, headers });
          } catch (error) {
            if (!command && !accepted) throw error;
            markWriterOperationUncertain();
            return Response.json({ state: "accepted-needs-review", idempotencyKey: attempt, command: command ?? null, mutationRetried: false, communityDeliveryVerified: false }, { status: 202, headers });
          }
        } catch (error) {
          if (error instanceof AdminAuthError) return integrationErrorResponse(new IntegrationServiceError(error.code === "unauthenticated" ? "sign_in_required" : "forbidden", error.code === "unauthenticated" ? 401 : 403));
          return integrationErrorResponse(error);
        }
      }, dependencies.run);
    } catch (error) {
      if (retained && retainedAttempt) return Response.json({ state: "accepted-needs-review", idempotencyKey: retainedAttempt, command: retained, mutationRetried: false, communityDeliveryVerified: false }, { status: 202, headers });
      return integrationErrorResponse(error);
    }
  };
}

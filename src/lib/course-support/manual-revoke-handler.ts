import "server-only";

import { isDeepStrictEqual } from "node:util";
import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import { runCourseAdminOperation } from "@/lib/api-integration/course-admin-operation";
import { createCourseClient } from "@/lib/api-integration/course-client";
import { hasConfiguredRequestOrigin } from "@/lib/api-integration/request-origin";
import { isIntegrationFeatureEnabled } from "@/lib/api-integration/rollout-flags";
import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError, integrationErrorResponse } from "@/lib/api-integration/service-errors";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { readInteractiveBrowserRequest, type PaidRevokeSelection } from "@/lib/writer-admission/interactive-proof";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const maxRevision = 2_147_483_647;
const grantKeyPrefix = "owner-paid:";
const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
type Client = ReturnType<typeof createCourseClient>;
type Course = Awaited<ReturnType<Client["getAdminCourse"]>>["course"];
type Grant = Awaited<ReturnType<Client["listGrants"]>>["grants"][number];
type Command = Awaited<ReturnType<Client["revokeAccess"]>>;
type Target = { grantId: string; userId: string; courseId: string };
type Input = Omit<Target, "courseId"> & { expectedCourseRevision: number; reason: string; idempotencyKey: string };

const invalid = () => new IntegrationServiceError("invalid_request", 400);
const conflict = () => new IntegrationServiceError("conflict", 409);
const reasonFor = (input: Input) => `[paid-course revision ${input.expectedCourseRevision}] ${input.reason}`;

function parseInput(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "expectedCourseRevision,grantId,idempotencyKey,reason,userId") throw invalid();
  const row = value as Input;
  if (![row.userId, row.grantId, row.idempotencyKey].every(id => typeof id === "string" && uuid.test(id)) ||
    !Number.isInteger(row.expectedCourseRevision) || row.expectedCourseRevision < 1 || row.expectedCourseRevision > maxRevision ||
    typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 1800) throw invalid();
  return { ...row, reason: row.reason.trim() };
}

function matchingPaidCourse(course: Course, courseId: string, revision: number, publishedOnly: boolean): boolean {
  return course.id === courseId && course.revision === revision && course.accessMode === "paid" && course.currency === "CAD" && course.priceCents > 0 &&
    (course.status === "published" || !publishedOnly && course.status === "archived");
}

function originalManualGrant(grant: Grant | undefined, target: Target): grant is Grant {
  return !!grant && grant.grantId === target.grantId && grant.userId === target.userId && grant.courseId === target.courseId &&
    grant.grantReason === "manual" && grant.orderId === null && grant.externalPaymentId === null && grant.provider === null &&
    grant.idempotencyKey.startsWith(grantKeyPrefix) && uuid.test(grant.idempotencyKey.slice(grantKeyPrefix.length));
}

async function readExactGrant(client: Client, { grantId, userId, courseId }: Target): Promise<Grant | undefined> {
  const page = await client.listGrants({ grantId, userId, courseId, limit: 2 });
  return !page.nextCursor && page.grants.length === 1 ? page.grants[0] : undefined;
}

function matchingCommandRevision(command: Command, actorId: string, courseId: string, submitted?: Input): number | undefined {
  if (command.action !== "revoke" || command.scope !== "grantId" || command.actorUserId !== actorId || command.courseId !== courseId ||
    !command.targetGrantId || !uuid.test(command.targetGrantId) ||
    (submitted && (command.targetGrantId !== submitted.grantId || command.userId !== submitted.userId || command.reason !== reasonFor(submitted)))) return undefined;
  const revision = Number(/^\[paid-course revision ([1-9][0-9]*)\] \S/u.exec(command.reason)?.[1]);
  return Number.isInteger(revision) && revision <= maxRevision ? revision : undefined;
}

export function createManualCourseRevokeHandler(dependencies: {
  client?: (onResponse: (requestId: string) => void) => Client; authorize?: typeof requirePermission;
  run?: WriterAdmissionRunner; origin?: () => string | undefined; enabled?: () => boolean;
  getPaidRevokeSelection?: () => Promise<PaidRevokeSelection | undefined>;
} = {}) {
  const getSelection = dependencies.getPaidRevokeSelection ?? (async () => (await readInteractiveBrowserRequest())?.paidRevoke);
  return async (request: Request, courseId: string): Promise<Response> => {
    let attempt: string | undefined, attempted = false;
    let retainedCommand: { commandId: string } | undefined, retainedTarget: Target | undefined;
    const pending = () => Response.json({ state: retainedCommand ? "accepted-needs-review" : "outcome-unknown", idempotencyKey: attempt,
      command: retainedCommand ?? null, grant: retainedTarget ?? null, mutationRetried: false, communityDeliveryVerified: false }, { status: 202, headers });
    try {
      if (!(dependencies.enabled ?? (() => isIntegrationFeatureEnabled("courseReads")))()) throw new IntegrationServiceError("feature_disabled", 404);
      if (!uuid.test(courseId)) throw invalid();
      if (request.method !== "GET" && request.method !== "POST") throw new IntegrationServiceError("invalid_request", 405);
      const query = new URL(request.url).searchParams;
      const origin = dependencies.origin?.() ?? process.env.AUTH_URL;
      let submitted: Input | undefined;
      if (request.method === "POST") {
        if (query.size) throw invalid();
        submitted = parseInput(await readSameOriginJson(request, origin, 8192));
      } else {
        const fetchSite = request.headers.get("sec-fetch-site");
        if (!hasConfiguredRequestOrigin(request, origin) || fetchSite && !["same-origin", "none"].includes(fetchSite)) {
          throw new IntegrationServiceError("forbidden", 403);
        }
        if (query.size !== 1 || !uuid.test(query.get("idempotencyKey") ?? "")) throw invalid();
      }
      const idempotencyKey = submitted?.idempotencyKey ?? query.get("idempotencyKey")!;
      const selected = await getSelection();
      if (selected && (!submitted || idempotencyKey !== selected.idempotencyKey)) throw invalid();
      attempt = idempotencyKey;

      return await runCourseAdminOperation(async () => {
        try {
          const actor = await (dependencies.authorize ?? requirePermission)("courses:support");
          if (actor.user.role !== "owner" || actor.user.status !== "active" || actor.developerMode ||
            selected && actor.user.id !== selected.actorId) throw new IntegrationServiceError("forbidden", 403);
          let receivedRequestId: string | undefined;
          const onResponse = (requestId: string) => { receivedRequestId = requestId; };
          const client = dependencies.client?.(onResponse) ?? createCourseClient({ onResponse });
          const commandQuery = { idempotencyKey: `owner-paid-revoke:${idempotencyKey}`, limit: 2 };
          const known = await client.listEntitlementCommands(commandQuery);
          if (known.nextCursor || known.commands.length > 1 ||
            known.commands[0] && (selected || known.commands[0].idempotencyKey !== commandQuery.idempotencyKey)) throw conflict();
          let command: Command | undefined = known.commands[0];
          if (!command && !submitted) return Response.json({ state: "not-observed", idempotencyKey, mutationRetried: false }, { status: 202, headers });

          let originalGrant: Grant | undefined, before: Course | undefined, mutationRequestId: string | undefined;
          if (!command && submitted) {
            const target = { grantId: submitted.grantId, userId: submitted.userId, courseId };
            before = (await client.getAdminCourse(courseId)).course;
            if (!matchingPaidCourse(before, courseId, submitted.expectedCourseRevision, !!selected)) throw conflict();
            originalGrant = await readExactGrant(client, target);
            if (!originalManualGrant(originalGrant, target) || originalGrant.status !== "active" || originalGrant.revokedAt !== null ||
              originalGrant.revokeReason !== null) throw conflict();
            retainedTarget = target;
            receivedRequestId = undefined;
            attempted = true;
            try {
              command = await client.revokeAccess({ scope: "grantId", grantId: target.grantId, reason: reasonFor(submitted), idempotencyKey: commandQuery.idempotencyKey });
              mutationRequestId = receivedRequestId;
            } catch (error) {
              if (error instanceof IntegrationServiceError && error.status < 500) attempted = false;
              throw error;
            }
          }

          const revision = command && matchingCommandRevision(command, actor.user.id, courseId, submitted);
          if (!command || revision === undefined || !command.targetGrantId) {
            if (attempted) throw new Error("REVOKE_RECEIPT_MISMATCH");
            throw conflict();
          }
          const target = { grantId: command.targetGrantId, userId: command.userId, courseId };
          retainedCommand = { commandId: command.commandId };
          retainedTarget = target;
          const saved = await client.listEntitlementCommands(commandQuery);
          if (saved.nextCursor || saved.commands.length !== 1) throw new Error("REVOKE_AUDIT_READBACK_MISMATCH");
          const audited = saved.commands[0];
          if (!isDeepStrictEqual(audited, { ...command, idempotencyKey: commandQuery.idempotencyKey, createdAt: audited.createdAt })) {
            throw new Error("REVOKE_AUDIT_READBACK_MISMATCH");
          }
          const grant = await readExactGrant(client, target);
          const after = (await client.getAdminCourse(courseId)).course;
          const effect = command.effects[0];
          if (command.outcome !== "applied" || command.affectedGrantCount !== 1 || command.effects.length !== 1 || effect.grantId !== target.grantId ||
            effect.effectType !== "grant_revoked" || effect.previousStatus !== "active" || effect.resultingStatus !== "revoked" ||
            !originalManualGrant(grant, target) || grant.status !== "revoked" || grant.revokeReason !== "manual" || grant.revokedAt !== command.effectiveAt ||
            originalGrant && grant.idempotencyKey !== originalGrant.idempotencyKey ||
            !matchingPaidCourse(after, courseId, revision, !!selected) || before && before.status !== after.status) {
            if (attempted) markWriterOperationUncertain();
            return pending();
          }
          return Response.json({ state: "confirmed", idempotencyKey, command: retainedCommand,
            grant: { ...target, status: "revoked", orderId: null, externalPaymentId: null, provider: null },
            courseRevision: after.revision, mutationRetried: false, communityDeliveryVerified: false },
          { headers: mutationRequestId ? { ...headers, "x-request-id": mutationRequestId } : headers });
        } catch (error) {
          if (attempted || retainedCommand) {
            if (attempted) markWriterOperationUncertain();
            return pending();
          }
          if (error instanceof AdminAuthError) return integrationErrorResponse(new IntegrationServiceError(
            error.code === "unauthenticated" ? "sign_in_required" : "forbidden", error.code === "unauthenticated" ? 401 : 403));
          return integrationErrorResponse(error);
        }
      }, dependencies.run);
    } catch (error) {
      return attempted || retainedCommand ? pending() : integrationErrorResponse(error);
    }
  };
}

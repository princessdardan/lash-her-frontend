import "server-only";

import { cookies } from "next/headers";
import { requirePermission } from "@/lib/admin/auth";
import { matchesP506OriginHeaders, resolveP506CandidateOrigin } from "@/lib/env/p506-candidate-origin";
import { AdminAuthError } from "@/lib/admin/types";
import {
  customerSessionCookieName,
  resolveCustomerAuthConfiguration,
} from "@/lib/customer-auth/policy";
import { issueLockedCustomerToken } from "@/lib/customer-auth/session-issuance";
import { canonicalUuid } from "@/lib/customer-lifecycle/policy";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { runWriterAdmission } from "@/lib/writer-admission/runtime";
import type { paths } from "./generated/community-discussions";
import { mintApplicationToken } from "./application-jwt";
import { communityCapabilitiesForActor } from "./staff-capabilities";
import { getGatewayTransport } from "./gateway-transport";
import { validateCandidateRequest, validateCandidateResponse } from "./candidate-validation";
import { isIntegrationFeatureEnabled } from "./rollout-flags";
import { readSameOriginJson } from "./same-origin-json";
import {
  IntegrationServiceError,
  integrationErrorResponse,
  parseGatewayFailure,
  upstreamIntegrationError,
} from "./service-errors";

export const communityReadsEnabled = () =>
  isIntegrationFeatureEnabled("communityReads");
export const communityWritesEnabled = () =>
  isIntegrationFeatureEnabled("communityWrites");

export const communityMediaEnabled = () =>
  isIntegrationFeatureEnabled("communityMedia");

export function communityAccountEnabled() {
  return (
    isIntegrationFeatureEnabled("customerAccess") &&
    process.env.CUSTOMER_AUTH_ENABLED === "true"
  );
}

type Method = "get" | "post" | "patch" | "put" | "delete";
type QueryName = "after" | "search" | "status";
type Operation = readonly [
  method: Method,
  path: keyof paths,
  query?: readonly QueryName[],
  expected?: number,
];
const operations = {
  spaces: ["get", "/v1/spaces", ["after"]],
  feed: ["get", "/v1/spaces/{courseId}/posts", ["after", "search"]],
  post: ["post", "/v1/spaces/{courseId}/posts", [], 201],
  thread: ["get", "/v1/discussions/{postId}", ["after"]],
  comment: ["post", "/v1/discussions/{postId}/comments", [], 201],
  edit: ["patch", "/v1/content/{contentId}"],
  delete: ["delete", "/v1/content/{contentId}"],
  react: ["put", "/v1/discussions/{postId}/reaction"],
  report: ["post", "/v1/content/{contentId}/reports", [], 201],
  ownProfile: ["get", "/v1/profile"],
  profile: ["put", "/v1/profile"],
  members: ["get", "/v1/spaces/{courseId}/members", ["after", "search"]],
  member: ["get", "/v1/spaces/{courseId}/members/{memberId}"],
  media: ["get", "/v1/discussions/{postId}/media"],
  reserveImage: ["post", "/v1/discussions/{postId}/media", [], 201],
  completeImage: ["post", "/v1/media/{mediaId}/complete", [], 202],
  viewImage: ["get", "/v1/media/{mediaId}/view"],
  removeImage: ["delete", "/v1/media/{mediaId}"],

  notifications: ["get", "/v1/notifications", ["after"]],
  unreadNotifications: ["get", "/v1/notifications/unread"],
  notificationPreferences: ["get", "/v1/notifications/preferences"],
  saveNotificationPreferences: ["put", "/v1/notifications/preferences"],
  setNotificationRead: ["put", "/v1/notifications/{notificationId}/read"],
  reports: ["get", "/v1/moderation/reports", ["after", "status"]],
  moderate: ["post", "/v1/moderation/actions"],
  space: ["put", "/v1/moderation/spaces/{courseId}"],
} as const satisfies Record<string, Operation>;

function adminBrowserOrigin() {
  const configured = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!configured || !URL.canParse(configured)) return undefined;
  const url = new URL(configured);
  if (url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "/api/auth")) return undefined;
  return url.origin;
}

function buildQuery(request: Request, allowed: readonly QueryName[]) {
  const query = new URLSearchParams();
  for (const [name, value] of new URL(request.url).searchParams) {
    if (
      !allowed.some((key) => key === name) ||
      query.has(name) ||
      (name === "after" && !canonicalUuid(value)) ||
      (name === "search" &&
        (!value.trim() ||
          value.length > 100 ||
          /[\u0000-\u001f\u007f]/u.test(value))) ||
      (name === "status" && value !== "open" && value !== "resolved")
    )
      throw new IntegrationServiceError("invalid_request", 400);
    query.set(name, value);
  }
  return query.size ? `?${query.toString()}` : "";
}

export async function communityRequest(
  request: Request,
  operation: keyof typeof operations,
  ...resourceIds: string[]
) {
  const [method, contractPath, queryFields = [], expected = 200]: Operation =
    operations[operation];
  const admin = contractPath.startsWith("/v1/moderation/");
  const write = method !== "get";
  const media = contractPath.split("/").includes("media");
  try {
    if (
      !communityReadsEnabled() ||
      (media && !communityMediaEnabled()) ||
      (write && !communityWritesEnabled()) ||
      (!admin && !communityAccountEnabled())
    )
      throw new IntegrationServiceError("feature_disabled", 404);
    const parameterCount = contractPath.match(/\{[^}]+\}/gu)?.length ?? 0;
    if (
      parameterCount !== resourceIds.length ||
      resourceIds.some((id) => !canonicalUuid(id))
    )
      throw new IntegrationServiceError("not_found", 404);
    const candidateOrigin = resolveP506CandidateOrigin();
    if (candidateOrigin && (new URL(request.url).origin !== candidateOrigin ||
        !matchesP506OriginHeaders(request.headers, candidateOrigin)))
      throw new IntegrationServiceError("forbidden", 403);
    const configuration = admin
      ? undefined
      : resolveCustomerAuthConfiguration();
    const session =
      configuration &&
      (await cookies()).get(customerSessionCookieName(configuration.secure))
        ?.value;
    if (!admin && !session)
      throw new IntegrationServiceError("sign_in_required", 401);
    const params: Record<string, string> = {};
    let parameter = 0;
    const pathname = contractPath.replace(/\{([^}]+)\}/gu, (_, name: string) => {
      const id = resourceIds[parameter++];
      params[name] = id;
      return id;
    });
    const query = buildQuery(request, queryFields);
    const path = pathname + query;
    let body: string | undefined;
    if (write) {
      const input = await readSameOriginJson(
        request,
        admin ? candidateOrigin ?? adminBrowserOrigin() : configuration?.origin,
        24_576,
      );
      if (method === "delete") {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          throw new IntegrationServiceError("invalid_request", 400);
      } else {
        validateCandidateRequest("community", contractPath, method, {
          params, query: Object.fromEntries(new URLSearchParams(query)), body: input,
        });
        body = JSON.stringify(input);
      }
    }

    // Staff authorization can refresh identity or write a denial audit.
    // Reject invalid browser mutations before entering that operation.
    const actor = admin
      ? await requirePermission("community:moderate")
      : undefined;
    if (actor && (actor.developerMode || !communityCapabilitiesForActor(actor).includes("community-moderator")))
      throw new IntegrationServiceError("forbidden", 403);

    const execute = async (): Promise<Response> => {
      if (
        !communityReadsEnabled() ||
        (media && !communityMediaEnabled()) ||
        (write && !communityWritesEnabled()) ||
        (!admin && !communityAccountEnabled())
      )
        return integrationErrorResponse(
          new IntegrationServiceError("feature_disabled", 404),
        );
      const token = actor
        ? mintApplicationToken({
            profile: "community-admin",
            adminId: actor.user.id,
            capabilities: ["community-moderator"],
          })
        : (
            await issueLockedCustomerToken(session ?? "", (id) =>
              mintApplicationToken({ profile: "community-member", customerId: id }),
            )
          )?.token;
      if (!token)
        return integrationErrorResponse(
          new IntegrationServiceError("sign_in_required", 401),
        );
      try {
        const response = await getGatewayTransport()({
          service: "community",
          communityApplication: true,
          method: method.toUpperCase() as Uppercase<Method>,
          path,
          applicationToken: token,
          ...(body === undefined ? {} : { body }),
        });
        if (
          response.headers.get("content-type")?.split(";", 1)[0] !==
          "application/json"
        )
          throw new IntegrationServiceError("service_unavailable", 503);
        const result: unknown = await response.json();
        const gateway = parseGatewayFailure(response, result);
        if (gateway) {
          if (write && gateway.uncertain) markWriterOperationUncertain();
          return integrationErrorResponse(gateway.failure);
        }
        validateCandidateResponse(
          "community",
          contractPath,
          method,
          response.status,
          result,
        );
        if (!response.ok) {
          const { error } = result as { error: { code: string } };
          const requestId = response.headers.get("x-request-id");
          // The receiver can commit the reservation before signing the upload
          // ticket and rechecking course access. Both dependencies may fail.
          const reservationMayExist = operation === "reserveImage" &&
            response.status === 503 &&
            (error.code === "media_unavailable" || error.code === "course_authority_unavailable");
          if (write && ((response.status >= 500 && response.status !== 503) || reservationMayExist))
            markWriterOperationUncertain();
          const failure =
            error.code === "participation_suspended"
              ? new IntegrationServiceError(
                  "participation_suspended",
                  403,
                  requestId,
                )
              : response.status === 401
                ? new IntegrationServiceError(
                    "service_unavailable",
                    503,
                    requestId,
                  )
                : response.status === 422
                  ? new IntegrationServiceError(
                      "invalid_request",
                      400,
                      requestId,
                    )
                  : upstreamIntegrationError(
                      response.status,
                      error.code,
                      requestId,
                      response.headers.get("retry-after"),
                    );
          return integrationErrorResponse(failure);
        }
        if (response.status !== expected)
          throw new IntegrationServiceError("service_unavailable", 503);
        return Response.json(result, {
          status: expected,
          headers: {
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        if (write) markWriterOperationUncertain();
        return integrationErrorResponse(
          new IntegrationServiceError("service_unavailable", 503),
        );
      }
    };
    return write
      ? await runWriterAdmission("new-work", execute)
      : await execute();
  } catch (error) {
    if (error instanceof AdminAuthError)
      return integrationErrorResponse(
        error.code === "unauthenticated"
          ? new IntegrationServiceError("sign_in_required", 401)
          : new IntegrationServiceError("forbidden", 403),
      );
    return integrationErrorResponse(error);
  }
}

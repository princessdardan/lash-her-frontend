import "server-only";

import { requirePermission } from "@/lib/admin/auth";
import { AdminAuthError } from "@/lib/admin/types";
import type { AdminPermissionAction } from "@/lib/admin/permissions";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { markWriterOperationUncertain } from "@/lib/writer-admission/context";
import { runWriterAdmission, type WriterAdmissionRunner } from "@/lib/writer-admission/runtime";
import { mintApplicationToken, type ApplicationPrincipal } from "./application-jwt";
import { type CandidateBody, type CandidateQuery, type CandidateSuccess, validateCandidateRequest, validateCandidateResponse } from "./candidate-validation";
import { getGatewayTransport, type GatewayRequest } from "./gateway-transport";
import { isIntegrationFeatureEnabled, type IntegrationFeature } from "./rollout-flags";
import { IntegrationServiceError, parseGatewayFailure, safeIntegrationRequestId, upstreamIntegrationError } from "./service-errors";
import { courseCapabilitiesForActor } from "./staff-capabilities";
import type { paths } from "./candidate-generated/course";

type Method = "get" | "post" | "patch";
type Body<P extends keyof paths, M extends Method> = CandidateBody<"course", P, M>;
type Query<P extends keyof paths> = CandidateQuery<"course", P, "get">;
type Success<P extends keyof paths, M extends Method> = CandidateSuccess<"course", P, M>;
type Input = { params?: Record<string, string>; query?: object; body?: unknown; idempotencyKey?: string };
type Access = "public" | "learner" | "editor" | "support";

export function createCourseClient(dependencies: {
  getTransport?: () => (request: GatewayRequest) => Promise<Response>;
  getCustomer?: typeof getCustomerActor;
  getAdmin?: typeof requirePermission;
  mintToken?: (principal: ApplicationPrincipal) => string;
  enabled?: (feature: IntegrationFeature) => boolean;
  run?: WriterAdmissionRunner;
  onResponse?: (requestId: string) => void;
} = {}) {
  const getTransport = dependencies.getTransport ?? getGatewayTransport;
  const getCustomer = dependencies.getCustomer ?? getCustomerActor;
  const getAdmin = dependencies.getAdmin ?? requirePermission;
  const mintToken = dependencies.mintToken ?? mintApplicationToken;
  const enabled = dependencies.enabled ?? isIntegrationFeatureEnabled;
  const run = dependencies.run ?? runWriterAdmission;

  async function request<P extends keyof paths, M extends Method>(path: P, method: M, access: Access, input: Input = {}): Promise<Success<P, M>> {
    if (!enabled("courseReads") || access === "learner" && !enabled("customerAccess")) throw new IntegrationServiceError("feature_disabled", 404);
    if (Object.values(input.params ?? {}).some(value => !/^[A-Za-z0-9_-]{1,160}$/u.test(value))) throw new IntegrationServiceError("invalid_request", 400);
    if (input.idempotencyKey && !/^[A-Za-z0-9._:-]{1,255}$/u.test(input.idempotencyKey)) throw new IntegrationServiceError("invalid_request", 400);
    validateCandidateRequest("course", path, method, input);
    const execute = async (): Promise<{ value: Success<P, M> } | { failure: IntegrationServiceError }> => {
      let outboundStarted = false;
      let requestId: string | undefined;
      try {
        if (!enabled("courseReads")) throw new IntegrationServiceError("feature_disabled", 404);
        if (access === "learner" && !enabled("customerAccess")) throw new IntegrationServiceError("feature_disabled", 404);
        validateCandidateRequest("course", path, method, input);
        let applicationToken: string | undefined;
        let customerId: string | undefined;
        if (access === "learner") {
          const customer = await getCustomer();
          if (!customer) throw new IntegrationServiceError("sign_in_required", 401);
          customerId = customer.id;
          applicationToken = mintToken({ profile: "course-learner", customerId: customer.id });
        } else if (access === "editor" || access === "support") {
          const permission: AdminPermissionAction = access === "editor" ? "courses:edit" : "courses:support";
          const actor = await getAdmin(permission);
          const capabilities = courseCapabilitiesForActor(actor);
          if (!capabilities.includes(access === "editor" ? "course-editor" : "course-support")) throw new IntegrationServiceError("forbidden", 403);
          applicationToken = mintToken({ profile: "course-admin", adminId: actor.user.id, capabilities });
        }
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query ?? {})) if (value !== undefined) query.set(key, String(value));
        const pathname = path.replace(/\{([^}]+)\}/gu, (_match, name: string) => input.params![name]);
        const transport = getTransport();
        outboundStarted = true;
        const response = await transport({ service: "course", method: method.toUpperCase() as GatewayRequest["method"],
          path: `${pathname}${query.size ? `?${query}` : ""}`, applicationToken,
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
        requestId = safeIntegrationRequestId(response.headers.get("x-request-id"));
        dependencies.onResponse?.(requestId);
        if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new Error("INVALID_INTEGRATION_RESPONSE");
        let value: unknown;
        try { value = await response.json(); } catch { throw new Error("INVALID_INTEGRATION_RESPONSE"); }
        const gatewayFailure = parseGatewayFailure(response, value);
        if (gatewayFailure) {
          if (method !== "get" && gatewayFailure.uncertain) markWriterOperationUncertain();
          return { failure: gatewayFailure.failure };
        }
        validateCandidateResponse("course", path, method, response.status, value);
        if (response.status < 200 || response.status >= 300) {
          if (method !== "get" && response.status >= 500) markWriterOperationUncertain();
          const code = value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "code" in value.error && typeof value.error.code === "string" ? value.error.code : "";
          // The browser session was already verified and a fresh server token
          // minted. Receiver401 is a service/configuration failure, not a reason
          // to send the customer through another sign-in loop.
          if (response.status === 401 || access === "public" && response.status === 403) return { failure: new IntegrationServiceError("service_unavailable", 503, requestId) };
          return { failure: upstreamIntegrationError(response.status, code, response.headers.get("x-request-id"), response.headers.get("retry-after")) };
        }
        if (customerId && path.endsWith("/progress")) {
          const owned = (value as { progress: { userId: string } | Array<{ userId: string }> }).progress;
          if ((Array.isArray(owned) ? owned : [owned]).some(row => row.userId !== customerId)) throw new Error("INTEGRATION_OWNER_MISMATCH");
        }
        return { value: value as Success<P, M> };
      } catch (error) {
        if (error instanceof IntegrationServiceError) return { failure: error };
        if (error instanceof AdminAuthError) return { failure: new IntegrationServiceError(error.code === "unauthenticated" ? "sign_in_required" : "forbidden", error.code === "unauthenticated" ? 401 : 403) };
        if (method !== "get" && outboundStarted) markWriterOperationUncertain();
        return { failure: new IntegrationServiceError("service_unavailable", 503, requestId) };
      }
    };
    // Named mutation helpers are admitted even when called directly by actions.
    // Deterministic documented denials settle before they become UI errors.
    const result = method === "get" ? await execute() : await run("new-work", execute);
    if ("failure" in result) throw result.failure;
    return result.value;
  }

  return {
    listCatalog: (query: Query<"/v1/courses"> = {}) => request("/v1/courses", "get", "public", { query }),
    getCatalogCourse: (slug: string) => request("/v1/courses/{slug}", "get", "public", { params: { slug } }),
    listMyCourses: () => request("/v1/student/courses", "get", "learner"),
    getMyCourse: (courseId: string) => request("/v1/student/courses/{courseId}", "get", "learner", { params: { courseId } }),
    listCourseLessons: (courseId: string) => request("/v1/student/courses/{courseId}/lessons", "get", "learner", { params: { courseId } }),
    getLesson: (lessonId: string) => request("/v1/student/lessons/{lessonId}", "get", "learner", { params: { lessonId } }),
    authorizePlayback: (lessonId: string) => request("/v1/student/lessons/{lessonId}/playback", "get", "learner", { params: { lessonId } }),
    listProgress: (query: Query<"/v1/student/progress"> = {}) => request("/v1/student/progress", "get", "learner", { query }),
    recordProgress: (lessonId: string, body: Body<"/v1/student/lessons/{lessonId}/progress", "post">) => request("/v1/student/lessons/{lessonId}/progress", "post", "learner", { params: { lessonId }, body }),
    listAdminCourses: (query: Query<"/v1/admin/courses"> = {}) => request("/v1/admin/courses", "get", "editor", { query }),
    getAdminCourse: (courseId: string) => request("/v1/admin/courses/{courseId}", "get", "editor", { params: { courseId } }),
    createCourse: (body: Body<"/v1/admin/courses", "post">) => request("/v1/admin/courses", "post", "editor", { body }),
    updateCourse: (courseId: string, body: Body<"/v1/admin/courses/{courseId}", "patch">) => request("/v1/admin/courses/{courseId}", "patch", "editor", { params: { courseId }, body }),
    createModule: (courseId: string, body: Body<"/v1/admin/courses/{courseId}/modules", "post">) => request("/v1/admin/courses/{courseId}/modules", "post", "editor", { params: { courseId }, body }),
    updateModule: (moduleId: string, body: Body<"/v1/admin/modules/{moduleId}", "patch">) => request("/v1/admin/modules/{moduleId}", "patch", "editor", { params: { moduleId }, body }),
    reorderModules: (courseId: string, body: Body<"/v1/admin/courses/{courseId}/modules/reorder", "post">) => request("/v1/admin/courses/{courseId}/modules/reorder", "post", "editor", { params: { courseId }, body }),
    createLesson: (moduleId: string, body: Body<"/v1/admin/modules/{moduleId}/lessons", "post">) => request("/v1/admin/modules/{moduleId}/lessons", "post", "editor", { params: { moduleId }, body }),
    updateLesson: (lessonId: string, body: Body<"/v1/admin/lessons/{lessonId}", "patch">) => request("/v1/admin/lessons/{lessonId}", "patch", "editor", { params: { lessonId }, body }),
    reorderLessons: (moduleId: string, body: Body<"/v1/admin/modules/{moduleId}/lessons/reorder", "post">) => request("/v1/admin/modules/{moduleId}/lessons/reorder", "post", "editor", { params: { moduleId }, body }),
    createVideoUpload: (lessonId: string) => request("/v1/admin/lessons/{lessonId}/video-upload", "post", "editor", { params: { lessonId } }),
    listEntitlementCommands: (query: Query<"/v1/admin/entitlements/commands"> = {}) => request("/v1/admin/entitlements/commands", "get", "support", { query }),
    listEnrollments: (query: Query<"/v1/admin/entitlements/enrollments"> = {}) => request("/v1/admin/entitlements/enrollments", "get", "support", { query }),
    listGrants: (query: Query<"/v1/admin/entitlements/grants"> = {}) => request("/v1/admin/entitlements/grants", "get", "support", { query }),
    listRevocations: (query: Query<"/v1/admin/entitlements/revocations"> = {}) => request("/v1/admin/entitlements/revocations", "get", "support", { query }),
    grantAccess: (body: Body<"/v1/admin/entitlements/grants", "post">) => request("/v1/admin/entitlements/grants", "post", "support", { body, idempotencyKey: body.idempotencyKey }),
    revokeAccess: (body: Body<"/v1/admin/entitlements/revocations", "post">) => request("/v1/admin/entitlements/revocations", "post", "support", { body, idempotencyKey: body.idempotencyKey }),
  };
}
export const getCourseClient = () => createCourseClient();

import "server-only";

import { readCourseAccess } from "@/lib/courses/access";
import { legacyProgressImportEnabled } from "@/lib/learning/rollout";
import { getCustomerActor } from "@/lib/customer-auth/session";
import { hasStalledPlaybackRenewalPermit, readInteractiveBrowserRequest, type LearningEnrollmentSelection } from "@/lib/writer-admission/interactive-proof";
import { createCourseClient } from "./course-client";
import { integrationErrorResponse, IntegrationServiceError, safeIntegrationRequestId } from "./service-errors";
import { readSameOriginJson } from "./same-origin-json";

type Client = ReturnType<typeof createCourseClient>;
export type AcademyOperation = "catalog" | "catalog-course" | "my-courses" | "my-course" | "course-lessons" | "lesson" | "playback" | "progress" | "record-progress" | "legacy-progress" | "free-enrollment" | "quiz" | "quiz-attempts" | "submit-quiz-attempt";

export function createAcademyHandler(operation: AcademyOperation, dependencies: { client?: () => Client; origin?: () => string | undefined;
  getCustomer?: typeof getCustomerActor; getLegacyAccess?: typeof readCourseAccess; legacyProgressEnabled?: () => boolean; getLearningEnrollment?: () => Promise<LearningEnrollmentSelection | undefined> } = {}) {
  const origin = dependencies.origin ?? (() => process.env.CUSTOMER_AUTH_URL);
  const getLearningEnrollment = dependencies.getLearningEnrollment ?? (async () => (await readInteractiveBrowserRequest())?.learningEnrollment);
  return async (request: Request, params: Record<string, string> = {}): Promise<Response> => {
    let requestId = safeIntegrationRequestId();
    try {
      const url = new URL(request.url);
      if (request.method !== (["record-progress", "legacy-progress", "free-enrollment", "submit-quiz-attempt"].includes(operation) ? "POST" : "GET")) throw new IntegrationServiceError("invalid_request", 405);
      if (request.method === "POST" && hasStalledPlaybackRenewalPermit(request)) throw new IntegrationServiceError("forbidden", 403);
      const query: Record<string, string | number> = Object.create(null);
      for (const [name, value] of url.searchParams) {
        if (Object.hasOwn(query, name)) throw new IntegrationServiceError("invalid_request", 400);
        if (name === "limit") {
          if (!/^[1-9][0-9]{0,2}$/u.test(value)) throw new IntegrationServiceError("invalid_request", 400);
          query[name] = Number(value);
        } else query[name] = value;
      }
      if (!["catalog", "progress"].includes(operation) && Object.keys(query).length) throw new IntegrationServiceError("invalid_request", 400);
      if (Object.keys(params).some(name => !["courseId", "lessonId", "slug"].includes(name)) ||
        Object.entries(params).some(([name, value]) => name === "slug" ? !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 160 : !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value))) throw new IntegrationServiceError("invalid_request", 400);
      let result: unknown;
      const course = dependencies.client?.() ?? createCourseClient({ onResponse: value => { requestId = value; } });
      switch (operation) {
        case "catalog": result = await course.listCatalog(query); break;
        case "catalog-course": result = await course.getCatalogCourse(params.slug); break;
        case "my-courses": result = await course.listMyCourses(); break;
        case "my-course": result = await course.getMyCourse(params.courseId); break;
        case "course-lessons": result = await course.listCourseLessons(params.courseId); break;
        case "lesson": result = await course.getLesson(params.lessonId); break;
        case "playback": result = await course.authorizePlayback(params.lessonId); break;
        case "progress": result = await course.listProgress(query); break;
        case "quiz": result = await course.getQuiz(params.lessonId); break;
        case "quiz-attempts": result = await course.listQuizAttempts(params.lessonId); break;
        case "free-enrollment": {
          const body = await readSameOriginJson(request, origin(), 16_384) as Parameters<Client["enrollFree"]>[1];
          const selected = await getLearningEnrollment();
          if (selected) {
            if (body?.idempotencyKey !== selected.idempotencyKey || Object.keys(body).length !== 1) throw new IntegrationServiceError("invalid_request", 400);
            const actor = await (dependencies.getCustomer ?? getCustomerActor)();
            if (!actor) throw new IntegrationServiceError("sign_in_required", 401);
            if (actor.id !== selected.actorId) throw new IntegrationServiceError("forbidden", 403);
          }
          result = await course.enrollFree(params.courseId, body);
          break;
        }
        case "submit-quiz-attempt": result = await course.submitQuizAttempt(params.lessonId, await readSameOriginJson(request, origin(), 65_536) as Parameters<Client["submitQuizAttempt"]>[1]); break;
        case "legacy-progress": {
          if (!(dependencies.legacyProgressEnabled ?? legacyProgressImportEnabled)()) throw new IntegrationServiceError("feature_disabled", 404);
          const actor = await (dependencies.getCustomer ?? getCustomerActor)();
          if (!actor) throw new IntegrationServiceError("sign_in_required", 401);
          const body = await readSameOriginJson(request, origin(), 131_072) as Parameters<Client["importLegacyPracticeProgress"]>[1];
          if (typeof body?.sourceId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/u.test(body.sourceId)) {
            throw new IntegrationServiceError("invalid_request", 400);
          }
          if (!await (dependencies.getLegacyAccess ?? readCourseAccess)(body.sourceId)) throw new IntegrationServiceError("forbidden", 403);
          result = await course.importLegacyPracticeProgress(params.courseId, body);
          break;
        }
        case "record-progress": {
          const body = await readSameOriginJson(request, origin(), 16_384);
          result = await course.recordProgress(params.lessonId, body as Parameters<Client["recordProgress"]>[1]); break;
        }
      }
      const isPublic = operation === "catalog" || operation === "catalog-course";
      return Response.json(result, { headers: { "cache-control": isPublic ? "public, max-age=0, s-maxage=60, stale-while-revalidate=30" : "private, no-store",
        "x-request-id": requestId, "x-content-type-options": "nosniff" } });
    } catch (error) { return integrationErrorResponse(error); }
  };
}

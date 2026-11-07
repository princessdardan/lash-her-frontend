import "server-only";

import { createCourseClient } from "./course-client";
import { readSameOriginJson } from "./same-origin-json";
import { integrationErrorResponse, IntegrationServiceError, safeIntegrationRequestId } from "./service-errors";
import { runCourseAdminOperation } from "./course-admin-operation";
import { isIntegrationFeatureEnabled } from "./rollout-flags";
import { currentWriterAuthoringActorId } from "@/lib/writer-admission/context";
import type { WriterAdmissionRunner } from "@/lib/writer-admission/runtime";

type Client = ReturnType<typeof createCourseClient>;
export type CourseAdminOperation = "list-courses" | "get-course" | "create-course" | "update-course" | "create-module" | "update-module" | "reorder-modules" | "create-lesson" | "update-lesson" | "reorder-lessons" | "create-video-upload" | "get-quiz" | "update-quiz" | "video-status" | "refresh-video" | "add-caption" | "delete-caption" | "publication-readiness";
const methods: Record<CourseAdminOperation, string> = {
  "list-courses": "GET", "get-course": "GET", "create-course": "POST", "update-course": "PATCH", "create-module": "POST", "update-module": "PATCH",
  "reorder-modules": "POST", "create-lesson": "POST", "update-lesson": "PATCH", "reorder-lessons": "POST", "create-video-upload": "POST",
  "get-quiz": "GET", "update-quiz": "PUT", "video-status": "GET", "refresh-video": "POST", "add-caption": "POST", "delete-caption": "DELETE", "publication-readiness": "GET",
};
const parameter: Record<CourseAdminOperation, string[]> = { "list-courses": [], "get-course": ["courseId"], "create-course": [], "update-course": ["courseId"], "create-module": ["courseId"],
  "update-module": ["moduleId"], "reorder-modules": ["courseId"], "create-lesson": ["moduleId"], "update-lesson": ["lessonId"], "reorder-lessons": ["moduleId"], "create-video-upload": ["lessonId"],
  "get-quiz": ["lessonId"], "update-quiz": ["lessonId"], "video-status": ["lessonId"], "refresh-video": ["lessonId", "videoAssetId"], "add-caption": ["lessonId", "videoAssetId"], "delete-caption": ["lessonId", "videoAssetId", "trackId"], "publication-readiness": ["courseId"] };

export function createCourseAdminHandler(operation: CourseAdminOperation, dependencies: { client?: () => Client; origin?: () => string | undefined; run?: WriterAdmissionRunner; enabled?: () => boolean } = {}) {
  return async (request: Request, params: Record<string, string> = {}): Promise<Response> => {
    let requestId = safeIntegrationRequestId();
    try {
      if (!(dependencies.enabled ?? (() => isIntegrationFeatureEnabled("courseReads")))()) throw new IntegrationServiceError("feature_disabled", 404);
      if (request.method !== methods[operation]) throw new IntegrationServiceError("invalid_request", 405);
      const keys = parameter[operation];
      if (Object.keys(params).sort().join(",") !== [...keys].sort().join(",") || keys.some(key => key === "trackId" ? !/^[A-Za-z0-9_-]{1,255}$/u.test(params[key]) : !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(params[key]))) throw new IntegrationServiceError("invalid_request", 400);
      const query: Record<string, string | number> = Object.create(null);
      for (const [name, value] of new URL(request.url).searchParams) {
        if (operation !== "list-courses" || Object.hasOwn(query, name) || !["limit", "cursor"].includes(name)) throw new IntegrationServiceError("invalid_request", 400);
        if (name === "limit") {
          if (!/^[1-9][0-9]{0,2}$/u.test(value)) throw new IntegrationServiceError("invalid_request", 400);
          query[name] = Number(value);
        } else query[name] = value;
      }
      const body = request.method === "GET" ? undefined : await readSameOriginJson(request, dependencies.origin?.() ?? process.env.AUTH_URL);
      return await runCourseAdminOperation(async () => {
        try {
          const course = dependencies.client?.() ?? createCourseClient({ onResponse: value => { requestId = value; } });
          let result: unknown;
          switch (operation) {
            case "list-courses": result = await course.listAdminCourses(query); break;
            case "get-course": result = await course.getAdminCourse(params.courseId); break;
            case "publication-readiness": result = await course.getPublicationReadiness(params.courseId); break;
            case "create-course": {
              const input = body as Parameters<Client["createCourse"]>[0];
              if (currentWriterAuthoringActorId() && input?.status !== "draft") throw new IntegrationServiceError("invalid_request", 400);
              result = await course.createCourse(input);
              break;
            }
            case "update-course": result = await course.updateCourse(params.courseId, body as Parameters<Client["updateCourse"]>[1]); break;
            case "create-module": result = await course.createModule(params.courseId, body as Parameters<Client["createModule"]>[1]); break;
            case "update-module": result = await course.updateModule(params.moduleId, body as Parameters<Client["updateModule"]>[1]); break;
            case "reorder-modules": result = await course.reorderModules(params.courseId, body as Parameters<Client["reorderModules"]>[1]); break;
            case "create-lesson": result = await course.createLesson(params.moduleId, body as Parameters<Client["createLesson"]>[1]); break;
            case "update-lesson": result = await course.updateLesson(params.lessonId, body as Parameters<Client["updateLesson"]>[1]); break;
            case "reorder-lessons": result = await course.reorderLessons(params.moduleId, body as Parameters<Client["reorderLessons"]>[1]); break;
            case "create-video-upload": result = await course.createVideoUpload(params.lessonId, body as Parameters<Client["createVideoUpload"]>[1]); break;
            case "get-quiz": result = await course.getAdminQuiz(params.lessonId); break;
            case "update-quiz": result = await course.updateQuiz(params.lessonId, body as Parameters<Client["updateQuiz"]>[1]); break;
            case "video-status": result = await course.getVideoStatus(params.lessonId); break;
            case "add-caption": result = await course.addVideoCaption(params.lessonId, params.videoAssetId, body as Parameters<Client["addVideoCaption"]>[2]); break;
            case "delete-caption": result = await course.deleteVideoCaption(params.lessonId, params.videoAssetId, params.trackId, body as Parameters<Client["deleteVideoCaption"]>[3]); break;
            case "refresh-video": {
              if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new IntegrationServiceError("invalid_request", 400);
              result = await course.refreshVideo(params.lessonId, params.videoAssetId); break;
            }
          }
          return Response.json(result, { headers: { "cache-control": "private, no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" } });
        } catch (error) { return integrationErrorResponse(error); }
      }, dependencies.run);
    } catch (error) { return integrationErrorResponse(error); }
  };
}

import "server-only";

import { createCourseClient } from "./course-client";
import { readSameOriginJson } from "./same-origin-json";
import { integrationErrorResponse, IntegrationServiceError, safeIntegrationRequestId } from "./service-errors";

type Client = ReturnType<typeof createCourseClient>;
export type CourseAdminOperation = "list-courses" | "get-course" | "create-course" | "update-course" | "create-module" | "update-module" | "reorder-modules" | "create-lesson" | "update-lesson" | "reorder-lessons" | "create-video-upload" | "get-quiz" | "update-quiz" | "video-status" | "refresh-video" | "add-caption" | "delete-caption";
const methods: Record<CourseAdminOperation, string> = {
  "list-courses": "GET", "get-course": "GET", "create-course": "POST", "update-course": "PATCH", "create-module": "POST", "update-module": "PATCH",
  "reorder-modules": "POST", "create-lesson": "POST", "update-lesson": "PATCH", "reorder-lessons": "POST", "create-video-upload": "POST",
  "get-quiz": "GET", "update-quiz": "PUT", "video-status": "GET", "refresh-video": "POST", "add-caption": "POST", "delete-caption": "DELETE",
};
const parameter: Record<CourseAdminOperation, string[]> = { "list-courses": [], "get-course": ["courseId"], "create-course": [], "update-course": ["courseId"], "create-module": ["courseId"],
  "update-module": ["moduleId"], "reorder-modules": ["courseId"], "create-lesson": ["moduleId"], "update-lesson": ["lessonId"], "reorder-lessons": ["moduleId"], "create-video-upload": ["lessonId"],
  "get-quiz": ["lessonId"], "update-quiz": ["lessonId"], "video-status": ["lessonId"], "refresh-video": ["lessonId", "videoAssetId"], "add-caption": ["lessonId", "videoAssetId"], "delete-caption": ["lessonId", "videoAssetId", "trackId"] };

export function createCourseAdminHandler(operation: CourseAdminOperation, dependencies: { client?: () => Client; origin?: () => string | undefined } = {}) {
  return async (request: Request, params: Record<string, string> = {}): Promise<Response> => {
    let requestId = safeIntegrationRequestId();
    try {
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
      const course = dependencies.client?.() ?? createCourseClient({ onResponse: value => { requestId = value; } });
      let result: unknown;
      switch (operation) {
        case "list-courses": result = await course.listAdminCourses(query); break;
        case "get-course": result = await course.getAdminCourse(params.courseId); break;
        case "create-course": result = await course.createCourse(body as Parameters<Client["createCourse"]>[0]); break;
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
        case "refresh-video": case "delete-caption": {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new IntegrationServiceError("invalid_request", 400);
          result = operation === "refresh-video" ? await course.refreshVideo(params.lessonId, params.videoAssetId) : await course.deleteVideoCaption(params.lessonId, params.videoAssetId, params.trackId); break;
        }
      }
      return Response.json(result, { headers: { "cache-control": "private, no-store", "x-request-id": requestId, "x-content-type-options": "nosniff" } });
    } catch (error) { return integrationErrorResponse(error); }
  };
}

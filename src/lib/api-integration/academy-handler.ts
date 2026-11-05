import "server-only";

import { createCourseClient } from "./course-client";
import { integrationErrorResponse, IntegrationServiceError, safeIntegrationRequestId } from "./service-errors";

type Client = ReturnType<typeof createCourseClient>;
export type AcademyOperation = "catalog" | "catalog-course" | "my-courses" | "my-course" | "course-lessons" | "lesson" | "playback" | "progress" | "record-progress";

export function createAcademyHandler(operation: AcademyOperation, dependencies: { client?: () => Client; origin?: () => string | undefined } = {}) {
  const origin = dependencies.origin ?? (() => process.env.CUSTOMER_AUTH_URL);
  return async (request: Request, params: Record<string, string> = {}): Promise<Response> => {
    let requestId = safeIntegrationRequestId();
    try {
      const url = new URL(request.url);
      if (request.method !== (operation === "record-progress" ? "POST" : "GET")) throw new IntegrationServiceError("invalid_request", 405);
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
        case "record-progress": {
          const trusted = origin();
          if (!trusted || new URL(trusted).origin !== url.origin || request.headers.get("origin") !== url.origin || request.headers.get("x-lash-csrf") !== "1" ||
            request.headers.get("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin") throw new IntegrationServiceError("forbidden", 403);
          if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") throw new IntegrationServiceError("invalid_request", 415);
          const reader = request.body?.getReader();
          let size = 0; const chunks: Uint8Array[] = [];
          if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
            if (size > 16_384) { await reader.cancel(); throw new IntegrationServiceError("invalid_request", 413); } chunks.push(chunk.value); }
          let body: unknown;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new IntegrationServiceError("invalid_request", 400); }
          result = await course.recordProgress(params.lessonId, body as Parameters<Client["recordProgress"]>[1]); break;
        }
      }
      const isPublic = operation === "catalog" || operation === "catalog-course";
      return Response.json(result, { headers: { "cache-control": isPublic ? "public, max-age=0, s-maxage=60, stale-while-revalidate=30" : "private, no-store",
        "x-request-id": requestId, "x-content-type-options": "nosniff" } });
    } catch (error) { return integrationErrorResponse(error); }
  };
}

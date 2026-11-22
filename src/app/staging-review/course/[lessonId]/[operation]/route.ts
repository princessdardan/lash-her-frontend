import { readSameOriginJson } from "@/lib/api-integration/same-origin-json";
import { IntegrationServiceError, integrationErrorResponse } from "@/lib/api-integration/service-errors";
import { reviewCourseSettings, reviewLessonRequest } from "@/lib/staging-review/course";
import { getReviewSubject, reviewSameOrigin } from "@/lib/staging-review/session";

type Context = { params: Promise<{ lessonId: string; operation: string }> };
const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

export const dynamic = "force-dynamic";

export function GET(request: Request, context: Context) {
  return handle(request, context, "get");
}

export function POST(request: Request, context: Context) {
  return handle(request, context, "post");
}

export function HEAD() {
  return new Response(null, { status: 405, headers });
}

async function handle(request: Request, { params }: Context, method: "get" | "post") {
  try {
    const subject = await getReviewSubject();
    if (!subject) throw new IntegrationServiceError("sign_in_required", 401);
    const { lessonId, operation } = await params;
    const config = reviewCourseSettings(lessonId);
    const attempts = "/v1/student/lessons/{lessonId}/quiz/attempts";
    if (!config || new URL(request.url).search ||
      (operation !== "progress" && operation !== "quiz-attempts" && !(operation === "playback" && method === "get")))
      throw new IntegrationServiceError("not_found", 404);
    if (method === "post") {
      if (!reviewSameOrigin(request)) throw new IntegrationServiceError("forbidden", 403);
      const quizAttempt = operation === "quiz-attempts";
      const body = await readSameOriginJson(request, new URL(request.url).origin, quizAttempt ? 65_536 : 1024);
      if (quizAttempt) {
        const result = await reviewLessonRequest(config, subject, lessonId, attempts, "post", body);
        return Response.json(result, { headers });
      }
      // These assessed lessons complete through the Course quiz transaction.
      if (body && typeof body === "object" && "event" in body && body.event !== "lesson_started")
        throw new IntegrationServiceError("invalid_request", 400);
      const result = await reviewLessonRequest(config, subject, lessonId, "/v1/student/lessons/{lessonId}/progress", "post", body);
      return Response.json(result, { headers });
    }
    const result = operation === "playback"
      ? await reviewLessonRequest(config, subject, lessonId, "/v1/student/lessons/{lessonId}/playback", "get")
      : await reviewLessonRequest(config, subject, lessonId, operation === "quiz-attempts" ? attempts : "/v1/student/progress", "get");
    return Response.json(result, { headers });
  } catch (error) {
    return integrationErrorResponse(error);
  }
}

import {
  academyJson,
  authorizeAcademyBff,
  isAcademyPrincipal,
  isValidAcademyId,
  mapAcademyCourseApiError,
  type AcademyBffDependencies,
  type AcademyRouteContext,
} from "@/lib/academy/bff";
import type { AcademyProgressInput } from "@/lib/academy/course-api";

const MAX_PROGRESS_BODY_BYTES = 4 * 1024;

export function createAcademyProgressPostHandler(
  dependencies: AcademyBffDependencies,
) {
  return async function POST(
    request: Request,
    context: AcademyRouteContext<{ courseId: string; lessonId: string }>,
  ): Promise<Response> {
    const principal = await authorizeAcademyBff(dependencies);
    if (!isAcademyPrincipal(principal)) return principal;

    const { courseId, lessonId } = await context.params;
    if (!isValidAcademyId(courseId) || !isValidAcademyId(lessonId)) {
      return academyJson({ error: "Invalid lesson identifier" }, 400);
    }

    const progress = await readProgress(request);
    if (!progress) {
      return academyJson({ error: "Invalid progress request" }, 400);
    }

    try {
      return academyJson(
        await dependencies.courseApi.updateProgress({
          courseId,
          lessonId,
          progress,
          userId: principal.userId,
        }),
      );
    } catch (error) {
      return mapAcademyCourseApiError(error, dependencies);
    }
  };
}

async function readProgress(
  request: Request,
): Promise<AcademyProgressInput | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_PROGRESS_BODY_BYTES
  ) {
    return null;
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(rawBody, "utf8") > MAX_PROGRESS_BODY_BYTES) return null;

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const candidate = body as Record<string, unknown>;
  const completed = candidate.completed;
  const positionSeconds = candidate.positionSeconds;
  if (completed === undefined && positionSeconds === undefined) return null;
  if (completed !== undefined && typeof completed !== "boolean") return null;
  if (
    positionSeconds !== undefined &&
    (typeof positionSeconds !== "number" ||
      !Number.isFinite(positionSeconds) ||
      !Number.isInteger(positionSeconds) ||
      positionSeconds < 0 ||
      positionSeconds > 86_400)
  ) {
    return null;
  }

  return {
    ...(completed === undefined ? {} : { completed }),
    ...(positionSeconds === undefined ? {} : { positionSeconds }),
  };
}

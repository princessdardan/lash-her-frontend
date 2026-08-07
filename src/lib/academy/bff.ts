import {
  getAcademyPrincipal,
  type AcademyPrincipal,
  type AcademySessionLike,
} from "./auth";
import { AcademyCourseApiError, type AcademyCourseApi } from "./course-api";

export interface AcademyBffDependencies {
  authenticate: () => Promise<AcademySessionLike | null>;
  courseApi: AcademyCourseApi;
  enabled: boolean;
  isCustomerActive: (customerUserId: string) => Promise<boolean>;
  logError?: (message: string, error: unknown) => void;
}

export interface AcademyRouteContext<T extends Record<string, string>> {
  params: Promise<T>;
}

export async function authorizeAcademyBff(
  dependencies: AcademyBffDependencies,
): Promise<AcademyPrincipal | Response> {
  if (!dependencies.enabled) {
    return academyJson({ error: "Academy is not available" }, 404);
  }

  const principal = getAcademyPrincipal(await dependencies.authenticate());
  if (!principal) {
    return academyJson({ error: "Authentication required" }, 401);
  }

  try {
    if (!(await dependencies.isCustomerActive(principal.userId))) {
      return academyJson({ error: "Authentication required" }, 401);
    }
  } catch (error) {
    dependencies.logError?.(
      "[academy] Customer status verification failed",
      error,
    );
    return academyJson(
      {
        error: "Academy is temporarily unavailable",
        code: "COURSE_API_UNAVAILABLE",
      },
      503,
    );
  }

  return principal;
}

export function isAcademyPrincipal(
  value: AcademyPrincipal | Response,
): value is AcademyPrincipal {
  return !(value instanceof Response);
}

export function isValidAcademyId(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512;
}

export function academyJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      Vary: "Cookie",
    },
  });
}

export function mapAcademyCourseApiError(
  error: unknown,
  dependencies: AcademyBffDependencies,
): Response {
  if (error instanceof AcademyCourseApiError) {
    switch (error.code) {
      case "ACCESS_REVOKED":
        return academyJson(
          { error: "Course access has been revoked", code: error.code },
          403,
        );
      case "ARCHIVED_UNSUPPORTED":
        return academyJson(
          { error: "This archived course is not supported", code: error.code },
          409,
        );
      case "INVALID_REQUEST":
        return academyJson(
          { error: "Invalid academy request", code: error.code },
          400,
        );
      case "NOT_FOUND":
        return academyJson(
          { error: "Academy content was not found", code: error.code },
          404,
        );
      case "PAYMENT_ACCESS_PROCESSING":
        return academyJson(
          { error: "Course access is still processing", code: error.code },
          409,
        );
      case "VIDEO_PROCESSING":
        return academyJson(
          { error: "Video is still processing", code: error.code },
          409,
        );
      case "COURSE_API_UNAVAILABLE":
        return academyJson(
          { error: "Academy is temporarily unavailable", code: error.code },
          503,
        );
    }
  }

  dependencies.logError?.("[academy] Course API request failed", error);
  return academyJson(
    {
      error: "Academy is temporarily unavailable",
      code: "COURSE_API_UNAVAILABLE",
    },
    503,
  );
}

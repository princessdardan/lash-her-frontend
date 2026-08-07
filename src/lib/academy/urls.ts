import { getAcademyConfig } from "./config";

function basePath(override?: string): string {
  return override ?? getAcademyConfig().basePath;
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export function academyDashboardUrl(base?: string): string {
  return basePath(base);
}

export function academySignInUrl(returnTo?: string, base?: string): string {
  const path = `${basePath(base)}/sign-in`;
  if (!returnTo) return path;

  const query = new URLSearchParams({ returnTo });
  return `${path}?${query.toString()}`;
}

export function academyCourseUrl(courseId: string, base?: string): string {
  return `${basePath(base)}/courses/${segment(courseId)}`;
}

export function academyLessonUrl(
  courseId: string,
  lessonId: string,
  base?: string,
): string {
  return `${academyCourseUrl(courseId, base)}/lessons/${segment(lessonId)}`;
}

export function academyCourseApiUrl(courseId: string): string {
  return `/api/academy/courses/${segment(courseId)}`;
}

export function academyLessonApiUrl(
  courseId: string,
  lessonId: string,
): string {
  return `${academyCourseApiUrl(courseId)}/lessons/${segment(lessonId)}`;
}

export function academyPlaybackApiUrl(
  courseId: string,
  lessonId: string,
): string {
  return `${academyLessonApiUrl(courseId, lessonId)}/playback`;
}

export function academyProgressApiUrl(
  courseId: string,
  lessonId: string,
): string {
  return `${academyLessonApiUrl(courseId, lessonId)}/progress`;
}

export function getSafeAcademyReturnTo(
  value: FormDataEntryValue | string | string[] | null | undefined,
  base?: string,
): string {
  const fallback = academyDashboardUrl(base);
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || !candidate.startsWith("/")) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, "https://academy.local");
    const academyBase = basePath(base);
    if (
      parsed.origin !== "https://academy.local" ||
      (parsed.pathname !== academyBase &&
        !parsed.pathname.startsWith(`${academyBase}/`)) ||
      parsed.pathname === `${academyBase}/sign-in`
    ) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

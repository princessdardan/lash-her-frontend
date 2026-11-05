const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export const validLearningId = (value: string): boolean => uuid.test(value);
export const validCourseSlug = (value: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 160;
export const lessonHref = (courseId: string, lessonId: string): string => `/academy/courses/${courseId}/lessons/${lessonId}`;
export const customerSignInHref = (path: string): string => `/sign-in?callbackUrl=${encodeURIComponent(path)}`;

export function safeLearningUrl(value: string | null | undefined, allowRelative = false): string | undefined {
  if (!value || value !== value.trim() || /[\u0000-\u0020\\]/u.test(value)) return undefined;
  if (allowRelative && value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function formatPosition(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function coursePrice(course: { accessMode: string; priceCents: number; currency: string }): string {
  if (course.accessMode === "free" && course.priceCents === 0 && course.currency === "CAD") return "Free";
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: course.currency }).format(course.priceCents / 100) + ` ${course.currency}`;
}

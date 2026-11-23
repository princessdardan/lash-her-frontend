import { readP407CourseCheckoutScope } from "./p407-course";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Attach the existing isolated proof only to the reviewed catalog and lesson reads. */
export function p406LearnerReadProof(
  path: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): string | undefined {
  const raw = env.P406_LEARNER_READ_SCOPE_JSON;
  if (raw === undefined || raw.length > 200) return undefined;
  if (!/^\/v1\/(?:courses\/|student\/(?:courses\/|progress\?|lessons\/))/u.test(path)) return undefined;

  try {
    const scope = readP407CourseCheckoutScope(env, now);
    const readScope: unknown = JSON.parse(raw);
    if (!scope || !readScope || typeof readScope !== "object" ||
      Object.keys(readScope).sort().join(",") !== "courseSlug,lessonId") return undefined;
    const { courseSlug, lessonId } = readScope as Record<string, unknown>;
    if (typeof courseSlug !== "string" || courseSlug.length > 100 || !slug.test(courseSlug) ||
        typeof lessonId !== "string" || !uuid.test(lessonId)) return undefined;
    const match = path === `/v1/courses/${courseSlug}` ||
      path === `/v1/student/courses/${scope.courseId}` ||
      path === `/v1/student/progress?courseId=${scope.courseId}` ||
      path === `/v1/student/progress?lessonId=${lessonId}` ||
      path === `/v1/student/lessons/${lessonId}`;
    return match ? env.P407_POSTGRES_RELAY_DEPLOYMENT_PROOF : undefined;
  } catch {
    return undefined;
  }
}

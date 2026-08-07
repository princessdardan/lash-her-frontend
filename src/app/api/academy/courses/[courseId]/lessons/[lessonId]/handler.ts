import {
  academyJson,
  authorizeAcademyBff,
  isAcademyPrincipal,
  isValidAcademyId,
  mapAcademyCourseApiError,
  type AcademyBffDependencies,
  type AcademyRouteContext,
} from "@/lib/academy/bff";

export function createAcademyLessonGetHandler(
  dependencies: AcademyBffDependencies,
) {
  return async function GET(
    _request: Request,
    context: AcademyRouteContext<{ courseId: string; lessonId: string }>,
  ): Promise<Response> {
    const principal = await authorizeAcademyBff(dependencies);
    if (!isAcademyPrincipal(principal)) return principal;

    const { courseId, lessonId } = await context.params;
    if (!isValidAcademyId(courseId) || !isValidAcademyId(lessonId)) {
      return academyJson({ error: "Invalid lesson identifier" }, 400);
    }

    try {
      return academyJson(
        await dependencies.courseApi.getLesson({
          courseId,
          lessonId,
          userId: principal.userId,
        }),
      );
    } catch (error) {
      return mapAcademyCourseApiError(error, dependencies);
    }
  };
}

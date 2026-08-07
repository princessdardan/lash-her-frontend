import {
  academyJson,
  authorizeAcademyBff,
  isAcademyPrincipal,
  isValidAcademyId,
  mapAcademyCourseApiError,
  type AcademyBffDependencies,
  type AcademyRouteContext,
} from "@/lib/academy/bff";

export function createAcademyCourseGetHandler(
  dependencies: AcademyBffDependencies,
) {
  return async function GET(
    _request: Request,
    context: AcademyRouteContext<{ courseId: string }>,
  ): Promise<Response> {
    const principal = await authorizeAcademyBff(dependencies);
    if (!isAcademyPrincipal(principal)) return principal;

    const { courseId } = await context.params;
    if (!isValidAcademyId(courseId)) {
      return academyJson({ error: "Invalid course identifier" }, 400);
    }

    try {
      return academyJson(
        await dependencies.courseApi.getCourse({
          courseId,
          userId: principal.userId,
        }),
      );
    } catch (error) {
      return mapAcademyCourseApiError(error, dependencies);
    }
  };
}

import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ lessonId: string }> }) { return createCourseAdminHandler("update-lesson")(request, await context.params); }

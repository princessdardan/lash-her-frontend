import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ moduleId: string }> }) { return createCourseAdminHandler("update-module")(request, await context.params); }

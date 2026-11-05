import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) { return createCourseAdminHandler("reorder-modules")(request, await context.params); }

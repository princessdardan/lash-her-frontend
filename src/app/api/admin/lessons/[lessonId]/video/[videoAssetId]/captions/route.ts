import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ lessonId: string; videoAssetId: string }> }) { return createCourseAdminHandler("add-caption")(request, await context.params); }

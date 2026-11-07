import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, context: { params: Promise<{ lessonId: string; videoAssetId: string; trackId: string }> }) { return createCourseAdminHandler("delete-caption")(request, await context.params); }

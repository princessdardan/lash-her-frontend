import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ courseId: string }> }) { return createCourseAdminHandler("publication-readiness")(request, await context.params); }
export const HEAD = () => new Response(null, { status: 405, headers: { "cache-control": "private, no-store" } });

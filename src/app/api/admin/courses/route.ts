import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createCourseAdminHandler("list-courses");
export const POST = createCourseAdminHandler("create-course");
export const HEAD = () => new Response(null, { status: 405, headers: { "cache-control": "private, no-store" } });

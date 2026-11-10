import { createCourseAdminHandler } from "@/lib/api-integration/course-admin-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => createCourseAdminHandler("list-courses")(request);
export const POST = (request: Request) => createCourseAdminHandler("create-course")(request);
export const HEAD = () => new Response(null, { status: 405, headers: { "cache-control": "private, no-store" } });

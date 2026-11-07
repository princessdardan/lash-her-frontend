import { createManualCourseRevokeHandler } from "@/lib/course-support/manual-revoke-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  return createManualCourseRevokeHandler()(request, (await context.params).courseId);
}

export async function GET(request: Request, context: { params: Promise<{ courseId: string }> }) {
  return createManualCourseRevokeHandler()(request, (await context.params).courseId);
}

export const HEAD = () => new Response(null, { status: 405, headers: { "cache-control": "private, no-store" } });

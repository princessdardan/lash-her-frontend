import { createAcademyHandler } from "@/lib/api-integration/academy-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ lessonId: string }> }) { return createAcademyHandler("quiz")(request, await context.params); }
export const HEAD = () => new Response(null, { status: 405, headers: { "cache-control": "private, no-store" } });

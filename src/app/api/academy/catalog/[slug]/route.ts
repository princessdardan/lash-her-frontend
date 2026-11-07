import { createAcademyHandler } from "@/lib/api-integration/academy-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createAcademyHandler("catalog-course");
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) { return handle(request, await context.params); }
export function HEAD() { return new Response(null, { status: 405, headers: { "cache-control": "no-store" } }); }

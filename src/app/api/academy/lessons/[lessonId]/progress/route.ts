import { createAcademyHandler } from "@/lib/api-integration/academy-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handle = createAcademyHandler("record-progress");
export async function POST(request: Request, context: { params: Promise<{ lessonId: string }> }) { return handle(request, await context.params); }

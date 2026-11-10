import { createAcademyHandler } from "@/lib/api-integration/academy-handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) { return createAcademyHandler("free-enrollment")(request, await context.params); }

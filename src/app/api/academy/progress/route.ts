import { createAcademyHandler } from "@/lib/api-integration/academy-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => createAcademyHandler("progress")(request);
export function HEAD() { return new Response(null, { status: 405, headers: { "cache-control": "no-store" } }); }

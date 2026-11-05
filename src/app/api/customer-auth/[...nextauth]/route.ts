import { createCustomerAuthHandler } from "@/lib/customer-auth/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createCustomerAuthHandler();
export const POST = GET;
// Next's automatic HEAD-to-GET fallback must not consume single-use tokens.
export function HEAD() { return new Response(null, { status: 405, headers: { "cache-control": "no-store", allow: "GET, POST" } }); }

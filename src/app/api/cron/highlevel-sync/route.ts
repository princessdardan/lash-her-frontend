import { createCrmCronHandler } from "@/lib/highlevel/worker";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const GET = createCrmCronHandler();

import { createAccountHandler } from "@/lib/customer-lifecycle/handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = createAccountHandler();

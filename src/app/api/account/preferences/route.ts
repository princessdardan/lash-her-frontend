import { createAccountHandler } from "@/lib/customer-lifecycle/handler";
export const runtime = "nodejs";
export const POST = createAccountHandler();

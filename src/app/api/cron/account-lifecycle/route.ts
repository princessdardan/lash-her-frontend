import { createAccountLifecycleCron } from "@/lib/customer-lifecycle/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export const GET = createAccountLifecycleCron();
